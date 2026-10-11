import { readFile as fsReadFile } from 'node:fs/promises';
import { dedup } from './openai-compatible.js';

/**
 * Remove reasoning/thinking tags, plaintext thinking blocks,
 * and conversational preambles from LLM speech-to-text outputs.
 */
export function sanitizeLlmTranscript(raw) {
  if (!raw || typeof raw !== 'string') return '';

  let text = raw;

  // 1. Remove XML/markdown reasoning tags (both closed and unclosed)
  text = text.replace(/<think(?:\s[^>]*)?>[\s\S]*?(?:<\/think>|$)/gi, '');
  text = text.replace(/<thought(?:\s[^>]*)?>[\s\S]*?(?:<\/thought>|$)/gi, '');
  text = text.replace(/<thinking(?:\s[^>]*)?>[\s\S]*?(?:<\/thinking>|$)/gi, '');
  text = text.replace(/<reasoning(?:\s[^>]*)?>[\s\S]*?(?:<\/reasoning>|$)/gi, '');
  text = text.replace(/```(?:thought|thinking|reasoning)[\s\S]*?(?:```|$)/gi, '');

  // 2. If wrapped in <transcription> tags, extract inside
  const tagMatch = text.match(/<transcription(?:\s[^>]*)?>([\s\S]*?)<\/transcription>/i);
  if (tagMatch) {
    text = tagMatch[1];
  }

  // 3. Handle plaintext "Thinking Process:" or "Thought:" blocks
  // Check if there is an explicit "Transcription:" or "Output:" section after thinking
  const postThinkMatch = text.match(/(?:^|\n)\s*(?:Transcription|Transcript|Spoken Words|Output)\s*:\s*([\s\S]*)$/i);
  if (postThinkMatch) {
    text = postThinkMatch[1];
  } else if (/(?:^|\n)\s*(?:Thinking Process|Thought Process|Thought|Reasoning|Internal Monologue|Analysis)\s*:/i.test(text)) {
    // If it has Thinking Process with no actual Transcription section, strip the thinking block
    text = text.replace(/(?:^|\n)\s*(?:Thinking Process|Thought Process|Thought|Reasoning|Internal Monologue|Analysis)\s*:[\s\S]*/i, '');
  }

  // 4. Strip common AI meta-talk preamble if the model talks about the prompt
  // e.g. "The user wants me to...", "I need to transcribe...", "I will now process..."
  if (/(?:The user wants me to|The user is asking|I must transcribe|I will now process|Upon closer listening|Since there is only noise|Since the audio is|As an audio transcriber)/i.test(text)) {
    const cleanedLines = text.split('\n').filter((line) => {
      const l = line.trim();
      if (!l) return false;
      return !/^(?:The user wants|The user is|I must |I need to |I will |Upon closer|Since there|Since the audio|Based on the|As an audio|\d+\.\s+\*\*|[*•-]\s+)/i.test(l);
    });
    text = cleanedLines.join(' ');
  }

  // 5. Strip common formatting prefixes (e.g. "Transcription:", "Transcript:")
  text = text.replace(/^(?:transcription|transcript|output|result):\s*/i, '');

  return text.trim();
}

export function createLlmSTT({ baseUrl, apiKey, label = 'LLM STT' }, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const readFile = deps.readFile || fsReadFile;
  const retries = deps.retries ?? 1;
  // Thinking models may take longer to complete their reasoning phase
  const timeoutMs = deps.timeoutMs ?? 300_000;
  const url = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;

  return async function transcribe(filePath, opts = {}) {
    const bytes = await readFile(filePath);
    const base64Audio = Buffer.isBuffer(bytes) ? bytes.toString('base64') : Buffer.from(bytes).toString('base64');
    const model = opts.model || 'gemma-4-e4b-it-qat';

    let promptText = [
      'Transcribe the speech in this audio clip verbatim in its original spoken language.',
      'Output ONLY the exact transcribed words.',
      'Do not translate, summarize, explain, or preface.',
      'If the audio contains only silence, background noise, or no spoken words, respond with an empty string.',
    ].join('\n');

    if (opts.prompt) {
      promptText += `\n\nVocabulary / glossary guide:\n${opts.prompt}`;
    }

    // Do NOT set artificial max_tokens limits so models that think internally
    // or produce long transcripts have unlimited token headroom.
    const payload = {
      model,
      temperature: 0.0,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: promptText,
            },
            {
              type: 'input_audio',
              input_audio: {
                data: base64Audio,
                format: 'wav',
              },
            },
          ],
        },
      ],
    };

    if (opts.max_tokens) {
      payload.max_tokens = opts.max_tokens;
    }

    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const headers = {
          'Content-Type': 'application/json',
        };
        if (apiKey) {
          headers.Authorization = `Bearer ${apiKey}`;
        }
        const res = await fetchImpl(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`${label} HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
        }
        const json = await res.json();
        const message = json?.choices?.[0]?.message;
        let rawContent = message?.content || '';
        if (typeof rawContent !== 'string' && Array.isArray(rawContent)) {
          rawContent = rawContent.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('');
        }

        const cleanText = sanitizeLlmTranscript(rawContent);
        const text = dedup(cleanText);
        return { text, words: [], duration: undefined };
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  };
}
