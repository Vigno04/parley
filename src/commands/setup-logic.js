import { LANGUAGE_CODES, SUMMARY_LANGUAGE_VALUES } from '../adapters/summarizer/languages.js';
import { sttProviderReady } from '../adapters/stt/index.js';
import { DEFAULT_MODELS } from '../adapters/summarizer/models.js';

const WHISPER_MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3', 'large-v3-turbo'];
const KNOWN_PROVIDERS = ['gemini', 'openai', 'opencode', 'openrouter', 'ollama'];
const OPENAI_STT_MODELS = ['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe'];

// Check whether a provider is usable: look it up in the DB (or env fallback).
export function providerReady(providerId, dbOrEnv) {
  if (!dbOrEnv) return { ok: false, missing: 'no database or environment' };

  if (typeof dbOrEnv.getProvider === 'function') {
    const row = dbOrEnv.getProvider(providerId);
    if (row) {
      if (row.kind === 'ollama') return { ok: !!row.base_url, missing: row.base_url ? null : 'base_url' };
      return { ok: !!row.api_key, missing: row.api_key ? null : 'api_key' };
    }
  }

  // Env-based / standard fallback
  const env = dbOrEnv || {};
  if (providerId === 'gemini') {
    const key = env.gemini?.apiKey || process.env.GEMINI_API_KEY;
    return { ok: !!key, missing: key ? null : 'GEMINI_API_KEY' };
  }
  if (providerId === 'openai') {
    const key = env.openai?.apiKey || process.env.OPENAI_API_KEY;
    return { ok: !!key, missing: key ? null : 'OPENAI_API_KEY' };
  }
  if (providerId === 'opencode') {
    const key = env.opencode?.apiKey || process.env.OPENCODE_API_KEY;
    return { ok: !!key, missing: key ? null : 'OPENCODE_API_KEY' };
  }
  if (providerId === 'openrouter') {
    const key = env.openrouter?.apiKey || process.env.OPENROUTER_API_KEY;
    return { ok: !!key, missing: key ? null : 'OPENROUTER_API_KEY' };
  }
  if (providerId === 'ollama') {
    const url = env.ollama?.url || process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
    return { ok: !!url, missing: url ? null : 'OLLAMA_URL' };
  }
  return { ok: false, missing: 'Unknown provider' };
}

// Validate a /setup or web PATCH, producing a clean patch object.
export function validateSetup(input, dbOrEnv) {
  const patch = {};
  const isDb = typeof dbOrEnv?.getProvider === 'function';

  if (input.provider !== undefined) {
    if (!isDb && !KNOWN_PROVIDERS.includes(input.provider)) {
      return { ok: false, error: `Unknown provider: ${input.provider}.` };
    }
    const ready = providerReady(input.provider, dbOrEnv);
    if (!ready.ok) {
      return { ok: false, error: `Cannot use provider "${input.provider}": ${ready.missing}.` };
    }
    if (isDb) {
      const row = dbOrEnv.getProvider(input.provider);
      if (row && row.caps !== 'summarizer' && row.caps !== 'both') {
        return { ok: false, error: `Provider "${input.provider}" is not configured for summarization.` };
      }
    }
    patch.summarizerProvider = input.provider;
    if (input.model) patch.summarizerModel = input.model;
  }

  if (input.fallbackProvider !== undefined) {
    const fb = input.fallbackProvider;
    if (fb === null || fb === '' || fb === 'none') {
      patch.summarizerFallbackProvider = null;
      patch.summarizerFallbackModel = null;
    } else {
      if (!isDb && !KNOWN_PROVIDERS.includes(fb)) {
        return { ok: false, error: `Unknown fallback provider: ${fb}.` };
      }
      const ready = providerReady(fb, dbOrEnv);
      if (!ready.ok) {
        return { ok: false, error: `Cannot use fallback provider "${fb}": ${ready.missing}.` };
      }
      if (isDb) {
        const row = dbOrEnv.getProvider(fb);
        if (row && row.caps !== 'summarizer' && row.caps !== 'both') {
          return { ok: false, error: `Provider "${fb}" is not configured for summarization.` };
        }
      }
      patch.summarizerFallbackProvider = fb;
      patch.summarizerFallbackModel = input.fallbackModel || DEFAULT_MODELS[fb] || null;
    }
  } else if (input.fallbackModel !== undefined) {
    patch.summarizerFallbackModel = input.fallbackModel || null;
  }

  if (input.whisperModel !== undefined) {
    if (!WHISPER_MODELS.includes(input.whisperModel)) {
      return { ok: false, error: `Invalid whisper model. Use one of: ${WHISPER_MODELS.join(', ')}.` };
    }
    patch.whisperModel = input.whisperModel;
  }

  if (input.sttProvider !== undefined) {
    if (input.sttProvider !== 'sidecar') {
      if (!isDb && input.sttProvider !== 'openai') {
        return { ok: false, error: `Unknown STT provider: ${input.sttProvider}.` };
      }
      const ready = isDb ? sttProviderReady(input.sttProvider, dbOrEnv) : { ok: !!dbOrEnv?.openai?.apiKey, missing: 'OPENAI_API_KEY' };
      if (!ready.ok) return { ok: false, error: `Cannot use STT provider "${input.sttProvider}": ${ready.missing}.` };
    }
    patch.sttProvider = input.sttProvider;
    if (input.sttModel !== undefined && input.sttModel !== null) {
      if (!isDb && input.sttProvider === 'openai' && !OPENAI_STT_MODELS.includes(input.sttModel)) {
        return { ok: false, error: `Invalid OpenAI model. Use one of: ${OPENAI_STT_MODELS.join(', ')}.` };
      }
      patch.sttModel = input.sttModel;
    }
  } else if (input.sttModel !== undefined && input.sttModel !== null) {
    patch.sttModel = input.sttModel;
  }

  if (input.notesChannelId !== undefined) patch.notesChannelId = input.notesChannelId;
  if (input.useThread !== undefined) patch.useThread = !!input.useThread;
  if (input.autoJoin !== undefined) patch.autoJoin = !!input.autoJoin;
  if (input.language !== undefined) {
    if (!LANGUAGE_CODES.has(input.language)) {
      return { ok: false, error: `Invalid language. Use one of: ${[...LANGUAGE_CODES].join(', ')}.` };
    }
    patch.language = input.language;
  }

  if (input.summary_language !== undefined) {
    if (!SUMMARY_LANGUAGE_VALUES.has(input.summary_language)) {
      return { ok: false, error: `Invalid summary language. Use one of: ${[...SUMMARY_LANGUAGE_VALUES].join(', ')}.` };
    }
    patch.summaryLanguage = input.summary_language;
  }

  return { ok: true, patch };
}

export { WHISPER_MODELS };

// List available summarizer providers from the DB (or env), with readiness status.
export function availableProviders(dbOrEnv) {
  if (!dbOrEnv) return [];
  const custom = typeof dbOrEnv.listProviders === 'function'
    ? dbOrEnv.listProviders()
        .filter((row) => row.caps === 'summarizer' || row.caps === 'both')
        .map((row) => ({
          provider: row.id,
          name: row.name,
          kind: row.kind,
          ...providerReady(row.id, dbOrEnv),
        }))
    : [];

  const standard = KNOWN_PROVIDERS
    .filter((k) => !custom.some((c) => c.provider === k))
    .map((provider) => ({
      provider,
      label: provider,
      ...providerReady(provider, dbOrEnv),
    }));

  return [...custom, ...standard];
}
