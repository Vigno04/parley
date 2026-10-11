import { transcribeFile } from '../stt-client.js';
import { normalize } from './openai-compatible.js';

// The local faster-whisper sidecar provider. Thin wrapper over the existing
// stt-client so the resolver can treat every provider uniformly as
// `(filePath, { model, language }) => { text, words }`.
export function createSidecarSTT({ baseUrl }, deps = {}) {
  return async function transcribe(filePath, opts = {}) {
    const raw = await transcribeFile(filePath, { model: opts.model, language: opts.language }, { ...deps, baseUrl });
    return normalize(raw);
  };
}
