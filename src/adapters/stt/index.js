import { config as envConfig } from '../../config/env.js';
import { createSidecarSTT } from './sidecar.js';
import { createOpenAICompatibleSTT } from './openai-compatible.js';
import { createLlmSTT } from './llm.js';

export const WHISPER_MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3', 'large-v3-turbo'];
export const STT_PROVIDERS = ['sidecar', 'openai'];
export const STT_MODELS = {
  sidecar: WHISPER_MODELS,
  openai: ['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe'],
};

export function parseProviderModels(modelsData) {
  if (!modelsData) return [];
  let parsed;
  if (Array.isArray(modelsData)) {
    parsed = modelsData;
  } else if (typeof modelsData === 'string') {
    try {
      parsed = JSON.parse(modelsData);
    } catch {
      parsed = modelsData.split(/[,\n]+/).map((s) => s.trim()).filter(Boolean);
    }
  } else {
    return [];
  }
  return (Array.isArray(parsed) ? parsed : []).map((m) => {
    if (typeof m === 'string') {
      return { id: m, caps: ['stt', 'summarizer'] };
    }
    return { id: m.id || m.name, caps: Array.isArray(m.caps) ? m.caps : ['stt', 'summarizer'] };
  });
}

export function resolveSttModel(cfg, provider = cfg?.sttProvider, db = null) {
  if (provider === 'sidecar' || !provider) return cfg?.whisperModel || WHISPER_MODELS[0];
  if (cfg?.sttModel) return cfg.sttModel;
  if (db && typeof db.getProvider === 'function') {
    const row = db.getProvider(provider);
    if (row?.models) {
      const parsed = parseProviderModels(row.models);
      const sttModel = parsed.find((m) => m.caps.includes('stt') || m.caps.includes('llm_stt'));
      if (sttModel) return sttModel.id;
    }
  }
  return 'whisper-1';
}

// Build the transcribe function for a guild config. Supports both:
//   getSTT(cfg, db, env, deps) — new DB-backed signature
//   getSTT(cfg, env, deps)     — legacy / test signature
export function getSTT(cfg = {}, dbOrEnv = null, envOrDeps = envConfig, deps = {}) {
  let db = null;
  let effectiveEnv = envConfig;
  let effectiveDeps = deps;

  if (dbOrEnv && typeof dbOrEnv.getProvider === 'function') {
    db = dbOrEnv;
    effectiveEnv = envOrDeps || envConfig;
    effectiveDeps = deps || {};
  } else {
    effectiveEnv = dbOrEnv || envConfig;
    effectiveDeps = envOrDeps || {};
  }

  const provider = cfg.sttProvider || 'sidecar';
  if (provider === 'sidecar') {
    const sttUrl = effectiveEnv?.sttUrl || effectiveEnv?.stt?.url || 'http://127.0.0.1:8000';
    return createSidecarSTT({ baseUrl: sttUrl }, effectiveDeps);
  }
  if (provider === 'openai') {
    const apiKey = effectiveEnv?.openai?.apiKey ?? (db ? db.getProvider('openai')?.api_key : null);
    const baseUrl = effectiveEnv?.openai?.baseUrl || (db ? db.getProvider('openai')?.base_url : null) || 'https://api.openai.com/v1';
    return createOpenAICompatibleSTT({ baseUrl, apiKey, label: 'OpenAI STT' }, effectiveDeps);
  }
  if (!db) {
    throw new Error(`Unknown STT provider: ${provider}`);
  }
  const row = db.getProvider(provider);
  if (!row) throw new Error(`Unknown STT provider: ${provider}`);

  // Check if the target model is configured for LLM STT (/chat/completions with input_audio)
  const targetModel = cfg.sttModel || resolveSttModel(cfg, provider, db);
  const parsedModels = parseProviderModels(row.models);
  const modelMeta = parsedModels.find((m) => m.id === targetModel);
  const isLlmStt = modelMeta
    ? (modelMeta.caps.includes('llm_stt') && !modelMeta.caps.includes('stt'))
    : (row.caps === 'llm_stt');

  if (isLlmStt) {
    return createLlmSTT({ baseUrl: row.base_url, apiKey: row.api_key, label: row.name || provider }, effectiveDeps);
  }
  return createOpenAICompatibleSTT({ baseUrl: row.base_url, apiKey: row.api_key, label: row.name || provider }, effectiveDeps);
}

// Whether a provider is usable right now.
export function sttProviderReady(provider, dbOrEnv = null, env = envConfig) {
  if (provider === 'sidecar') {
    const url = dbOrEnv?.sttUrl || env?.sttUrl || process.env.STT_URL || 'http://127.0.0.1:8000';
    return { ok: !!url, missing: url ? null : 'STT_URL' };
  }
  if (provider === 'openai') {
    const key = (dbOrEnv?.getProvider ? dbOrEnv.getProvider('openai')?.api_key : null)
      || dbOrEnv?.openai?.apiKey
      || env?.openai?.apiKey
      || process.env.OPENAI_API_KEY;
    return { ok: !!key, missing: key ? null : 'OPENAI_API_KEY' };
  }
  if (!dbOrEnv || typeof dbOrEnv.getProvider !== 'function') {
    return { ok: false, missing: 'provider not found' };
  }
  const row = dbOrEnv.getProvider(provider);
  if (!row) return { ok: false, missing: 'provider not found' };
  return { ok: !!row.base_url, missing: row.base_url ? null : 'base_url' };
}

// List available STT providers: always includes the built-in sidecar, plus any
// DB providers whose caps include 'stt', 'llm_stt' or 'both' (and openai by default).
export function availableSttProviders(dbOrEnv = null, env = envConfig) {
  const isDb = dbOrEnv && typeof dbOrEnv.listProviders === 'function';
  const out = [
    {
      provider: 'sidecar',
      label: 'Local sidecar (faster-whisper)',
      models: WHISPER_MODELS,
      ...sttProviderReady('sidecar', dbOrEnv, env),
    },
  ];
  if (isDb) {
    for (const row of dbOrEnv.listProviders()) {
      const parsedModels = parseProviderModels(row.models);
      const hasSttModels = parsedModels.some((m) => m.caps.includes('stt') || m.caps.includes('llm_stt'));
      const providerSupportsStt = row.caps === 'stt' || row.caps === 'both' || row.caps === 'llm_stt' || hasSttModels;
      if (!providerSupportsStt) continue;

      let sttModelIds = [];
      if (parsedModels.length > 0) {
        sttModelIds = parsedModels
          .filter((m) => m.caps.includes('stt') || m.caps.includes('llm_stt'))
          .map((m) => m.id);
        if (sttModelIds.length === 0) sttModelIds = parsedModels.map((m) => m.id);
      }

      out.push({
        provider: row.id,
        label: row.name || row.id,
        models: sttModelIds,
        modelDetails: parsedModels,
        ...sttProviderReady(row.id, dbOrEnv, env),
      });
    }
  }
  if (!out.some((p) => p.provider === 'openai')) {
    out.push({
      provider: 'openai',
      label: 'OpenAI (cloud)',
      models: STT_MODELS.openai,
      ...sttProviderReady('openai', dbOrEnv, env),
    });
  }
  return out;
}
