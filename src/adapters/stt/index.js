import { config as envConfig } from '../../config/env.js';
import { createSidecarSTT } from './sidecar.js';
import { createOpenAICompatibleSTT } from './openai-compatible.js';

export const WHISPER_MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3', 'large-v3-turbo'];
export const STT_PROVIDERS = ['sidecar', 'openai'];
export const STT_MODELS = {
  sidecar: WHISPER_MODELS,
  openai: ['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe'],
};

export function resolveSttModel(cfg, provider = cfg?.sttProvider) {
  if (provider === 'sidecar' || !provider) return cfg?.whisperModel || WHISPER_MODELS[0];
  return cfg?.sttModel || 'whisper-1';
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
// DB providers whose caps include 'stt' or 'both' (and openai by default).
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
      if (row.caps !== 'stt' && row.caps !== 'both') continue;
      let provModels = [];
      if (row.models) {
        try {
          provModels = Array.isArray(row.models) ? row.models : JSON.parse(row.models);
        } catch {
          provModels = String(row.models).split(/[,\n]+/).map((s) => s.trim()).filter(Boolean);
        }
      }
      out.push({
        provider: row.id,
        label: row.name || row.id,
        models: provModels,
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
