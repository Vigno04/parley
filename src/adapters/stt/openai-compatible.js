import { readFile as fsReadFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { isHallucination } from '../../voice/hallucinations.js';

// Models that only accept 'json' and ignore/choke on verbose_json
const JSON_ONLY_MODELS = new Set(['gpt-4o-transcribe', 'gpt-4o-mini-transcribe']);
// Models on official OpenAI that support granular word timestamps
const WORD_TIMESTAMP_MODELS = new Set(['whisper-1']);

// One adapter for every OpenAI-compatible speech-to-text endpoint
// (POST {baseUrl}/audio/transcriptions). OpenAI and other OpenAI-compatible
// providers speak this exact shape, so a single implementation covers them —
// only baseUrl/key/model differ.
export function createOpenAICompatibleSTT({ baseUrl, apiKey, label = 'STT' }, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const readFile = deps.readFile || fsReadFile;
  const retries = deps.retries ?? 1;
  // Cloud transcription is fast, but a cold connection or
  // a large file warrants headroom. Far below the sidecar's CPU-bound ceiling.
  const timeoutMs = deps.timeoutMs ?? 120_000;
  const url = `${String(baseUrl).replace(/\/+$/, '')}/audio/transcriptions`;

  return async function transcribe(filePath, opts = {}) {
    if (!apiKey) throw new Error(`${label}: API key is not set.`);
    const bytes = await readFile(filePath);
    let lastErr;
    let forceJsonFormat = false;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const form = new FormData();
        form.append('file', new Blob([bytes]), basename(filePath));
        const model = opts.model || 'whisper-large-v3-turbo';
        form.append('model', model);

        const mLower = model.toLowerCase();
        const isVoxtralOrAudioCpp = mLower.includes('voxtral') || mLower.includes('audio-cpp') || mLower.includes('audio.cpp');

        if (forceJsonFormat || isVoxtralOrAudioCpp || JSON_ONLY_MODELS.has(model)) {
          form.append('response_format', 'json');
        } else if (WORD_TIMESTAMP_MODELS.has(model)) {
          form.append('response_format', 'verbose_json');
          form.append('timestamp_granularities[]', 'word');
        } else {
          // Standard Whisper / other models: request verbose_json
          form.append('response_format', 'verbose_json');
        }

        // Greedy decoding (temperature: 0.0) suppresses silence hallucinations
        if (!isVoxtralOrAudioCpp && !JSON_ONLY_MODELS.has(model)) {
          form.append('temperature', '0.0');
        }

        // Prompt / glossary conditioning (names, D&D vocabulary, spelling guide)
        if (opts.prompt) form.append('prompt', opts.prompt);

        // Language parameter: pin ISO code if supplied or default if required
        if (opts.language && opts.language !== 'auto') {
          form.append('language', opts.language);
        }

        const signals = [AbortSignal.timeout(timeoutMs)];
        if (opts.signal) signals.push(opts.signal);
        const reqSignal = AbortSignal.any ? AbortSignal.any(signals) : AbortSignal.timeout(timeoutMs);

        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
          signal: reqSignal,
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          // If the model complained about language or verbose_json format, switch to json on next retry
          if (body.includes("response_format 'json'") || body.includes('did not report the language')) {
            forceJsonFormat = true;
          }
          throw new Error(`${label} HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
        }
        return normalize(await res.json());
      } catch (err) {
        lastErr = err;
        if (opts.signal?.aborted) throw err;
      }
    }
    throw lastErr;
  };
}

/**
 * Low-confidence STT-segment filter (adopted from Vexa / faster-whisper metrics).
 * Discards segments where Whisper reports high no-speech probability or compression repetition.
 */
export function isLowConfidenceSegment(s) {
  if (!s || typeof s !== 'object') return false;
  if (s.no_speech_prob !== undefined && s.avg_logprob !== undefined && s.no_speech_prob > 0.6 && s.avg_logprob < -1.0) return true;
  if (s.no_speech_prob !== undefined && s.no_speech_prob > 0.8) return true;
  if (s.compression_ratio !== undefined && s.compression_ratio > 2.4) return true;
  if (s.avg_logprob !== undefined && s.avg_logprob < -1.3) return true;
  return false;
}

// Coerce an OpenAI-compatible transcription response into our { text, words, duration } shape.
// Prefer top-level word timestamps; fall back to deriving them from segments so
// downstream endMs math still works even if a provider omits the words array.
export function normalize(json) {
  let segments = Array.isArray(json?.segments) ? json.segments : [];
  if (segments.length) {
    segments = segments.filter((s) => !isLowConfidenceSegment(s) && !isHallucination(s.text));
  }

  let textCandidate = segments.length
    ? segments.map((s) => (s.text || '').trim()).filter(Boolean).join(' ')
    : (json?.text || '').trim();

  if (isHallucination(textCandidate)) {
    textCandidate = '';
  }

  const text = dedup(textCandidate);

  let words = [];
  if (text) {
    if (Array.isArray(json?.words) && json.words.length) {
      words = json.words.map((w) => ({ word: w.word, start: w.start, end: w.end }));
    } else if (segments.length) {
      words = segments
        .filter((s) => typeof s.end === 'number')
        .map((s) => ({ word: s.text, start: s.start, end: s.end }));
    }
  }

  const out = { text, words, language: json?.language };
  if (typeof json?.duration === 'number') out.duration = json.duration;
  return out;
}

// Whisper-family models occasionally hallucinate by repeating the same sentence
// (or short phrase) multiple times in a row, especially when the audio has
// trailing silence. Strip consecutive duplicate sentences so the transcript
// stays clean. Only removes *exact* consecutive repetitions to avoid false
// positives on intentionally repeated speech ("go go go").
export function dedup(text) {
  if (!text) return text;
  // Split on sentence-ending punctuation while keeping the delimiter attached.
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g);
  if (!sentences || sentences.length <= 1) return text;
  const out = [sentences[0]];
  for (let i = 1; i < sentences.length; i++) {
    if (sentences[i].trim() !== sentences[i - 1].trim()) {
      out.push(sentences[i]);
    }
  }
  return out.join('').trim();
}
