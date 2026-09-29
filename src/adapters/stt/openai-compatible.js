import { readFile as fsReadFile } from 'node:fs/promises';
import { basename } from 'node:path';

// Models that support verbose_json with word-level timestamps. The newer
// gpt-4o-transcribe / gpt-4o-mini-transcribe models only accept 'json' and
// ignore (or choke on) timestamp_granularities — sending verbose_json to them
// causes undefined behaviour that frequently manifests as duplicated text.
const VERBOSE_JSON_MODELS = new Set(['whisper-1']);

// One adapter for every OpenAI-compatible speech-to-text endpoint
// (POST {baseUrl}/audio/transcriptions). OpenAI and other OpenAI-compatible
// providers speak this exact shape, so a single implementation covers them —
// only baseUrl/key/model differ.
//
// We always request `verbose_json` with word-level timestamps so the response
// carries the same `{ text, words: [{ word, start, end }] }` our pipeline
// already consumes from the local sidecar. No call-site changes needed.
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
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const form = new FormData();
        form.append('file', new Blob([bytes]), basename(filePath));
        const model = opts.model || 'whisper-large-v3-turbo';
        form.append('model', model);
        // Only request verbose_json + word timestamps for models that support
        // them. The gpt-4o-transcribe family only accepts 'json'; sending
        // verbose_json there produces garbled / duplicated output.
        if (VERBOSE_JSON_MODELS.has(model)) {
          form.append('response_format', 'verbose_json');
          form.append('timestamp_granularities[]', 'word');
        } else {
          form.append('response_format', 'json');
        }
        // Whisper auto-detects language when none is supplied; only pin it when
        // the user picked a specific ISO code (our 'auto' sentinel means detect).
        if (opts.language && opts.language !== 'auto') form.append('language', opts.language);
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`${label} HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
        }
        return normalize(await res.json());
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  };
}

// Coerce an OpenAI-compatible transcription response into our { text, words } shape.
// Prefer top-level word timestamps; fall back to deriving them from segments so
// downstream endMs math still works even if a provider omits the words array.
export function normalize(json) {
  const text = dedup((json?.text || '').trim());
  let words = Array.isArray(json?.words)
    ? json.words.map((w) => ({ word: w.word, start: w.start, end: w.end }))
    : [];
  if (!words.length && Array.isArray(json?.segments)) {
    words = json.segments
      .filter((s) => typeof s.end === 'number')
      .map((s) => ({ word: s.text, start: s.start, end: s.end }));
  }
  return { text, words, language: json?.language };
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
