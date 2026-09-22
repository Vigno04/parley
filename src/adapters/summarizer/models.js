// Live model catalogs, driven by DB-backed provider rows or standard providers.
//
// Every provider exposes what it actually serves — Gemini's ListModels, the
// OpenAI-compatible `/models` endpoints and Ollama's `/api/tags` — so the Setup
// UI and the `/setup` autocomplete can offer the complete list to search through
// instead of a hand-maintained handful. Results are cached in memory: Discord
// autocomplete fires on every keystroke and has to answer inside 3 seconds.
//
// A dead endpoint, missing key or timeout degrades to CURATED_MODELS rather
// than showing an empty picker; the model field stays free text either way.

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// ListModels reports `generateContent` support but no modality, so image, TTS,
// music, embedding and live-audio endpoints look like chat models. They can't
// produce StructuredNotes — drop them by id.
const GEMINI_NON_TEXT = /embedding|^aqa$|^imagen|^veo-|^lyria|nano-banana|-tts$|-image(-|$)|transcribe|native-audio|-live(-|$)/;

// OpenAI's /models mixes chat with audio, image, embedding and moderation
// endpoints. Keep the chat families, minus the non-text variants.
const OPENAI_TEXT = /^(gpt|o[1-9]|chatgpt|codex)/i;
const OPENAI_NON_TEXT = /transcribe|tts|audio|realtime|whisper|embedding|moderation|image|dall-e|sora|search|computer-use/i;

export const CURATED_MODELS = {
  gemini: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
  openai: ['gpt-4o', 'gpt-4o-mini'],
  opencode: ['glm-5.3', 'kimi-k3', 'kimi-k2.6'],
  openrouter: ['openai/gpt-4o-mini', 'google/gemini-2.5-flash', 'anthropic/claude-3.5-sonnet'],
  ollama: ['llama3', 'mistral', 'qwen2.5'],
};

export const DEFAULT_MODELS = {
  gemini: 'gemini-2.5-flash',
  openai: 'gpt-4o',
  opencode: 'glm-5.3',
  openrouter: 'openai/gpt-4o-mini',
  ollama: 'llama3',
};

export const CATALOG_PROVIDERS = Object.keys(CURATED_MODELS);

const CACHE_TTL_MS = 10 * 60 * 1000; // live catalogs barely change
const ERROR_TTL_MS = 30 * 1000;      // don't hammer a dead endpoint per keystroke
const cache = new Map(); // provider id -> { until, payload }

export function clearModelCache(providerId) {
  if (providerId) cache.delete(providerId);
  else cache.clear();
}

/** "1M" / "128K" / "8192" — compact context-window label. */
export function formatContext(tokens) {
  if (!Number.isFinite(tokens) || tokens <= 0) return '';
  if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

async function getJson(url, { headers = {}, timeoutMs, fetchImpl }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers, signal: ctrl.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 160)}` : ''}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const entry = (id, label, context) => ({ id, label: label || id, context: Number.isFinite(context) ? context : null });

async function fetchGemini({ apiKey, fetchImpl, timeoutMs }) {
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
  const models = [];
  let pageToken = '';
  // ListModels pages at 50 by default; ask for the max and follow the cursor.
  for (let page = 0; page < 5; page += 1) {
    const url = `${GEMINI_BASE}/models?key=${encodeURIComponent(apiKey)}&pageSize=200`
      + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
    const data = await getJson(url, { timeoutMs, fetchImpl });
    for (const m of data?.models || []) {
      if (!m?.supportedGenerationMethods?.includes('generateContent')) continue;
      const id = String(m.name || '').replace(/^models\//, '');
      if (!id || GEMINI_NON_TEXT.test(id)) continue;
      models.push(entry(id, m.displayName, m.inputTokenLimit));
    }
    pageToken = data?.nextPageToken || '';
    if (!pageToken) break;
  }
  return models;
}

// Shared shape for the OpenAI-compatible `/models` listings.
async function fetchOpenAICompatible({ baseUrl, apiKey, fetchImpl, timeoutMs, isOpenAI = false }) {
  if (!baseUrl) throw new Error('Base URL is not set');
  const data = await getJson(`${baseUrl.replace(/\/$/, '')}/models`, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    timeoutMs,
    fetchImpl,
  });
  const rawList = data?.data || [];
  const models = [];
  for (const m of rawList) {
    if (!m?.id) continue;
    const out = m.architecture?.output_modalities;
    if (Array.isArray(out) && out.length && !out.includes('text')) continue;
    if (isOpenAI && (!OPENAI_TEXT.test(m.id) || OPENAI_NON_TEXT.test(m.id))) continue;
    models.push(entry(m.id, m.name, m.context_length));
  }
  // Fallback for OpenAI compatible gateways with custom model names
  if (isOpenAI && models.length === 0) {
    for (const m of rawList) {
      if (m?.id) models.push(entry(m.id, m.name, m.context_length));
    }
  }
  return models;
}

async function fetchOllama({ baseUrl, fetchImpl, timeoutMs }) {
  if (!baseUrl) throw new Error('OLLAMA_URL is not set');
  const data = await getJson(`${baseUrl.replace(/\/$/, '')}/api/tags`, { timeoutMs, fetchImpl });
  return (data?.models || [])
    .map((m) => m?.name)
    .filter((name) => typeof name === 'string' && name)
    .map((name) => entry(name));
}

// Curated shortlist first (in its own order), then everything else A→Z.
function order(models, curated) {
  const rank = new Map(curated.map((id, i) => [id, i]));
  return models.sort((a, b) => {
    const ra = rank.has(a.id) ? rank.get(a.id) : Number.MAX_SAFE_INTEGER;
    const rb = rank.has(b.id) ? rank.get(b.id) : Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    return a.id.localeCompare(b.id);
  });
}

function dedupe(models) {
  const seen = new Set();
  const out = [];
  for (const m of models) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

/**
 * The catalog for one provider.
 *
 * `provider` can be a DB row ({ id, kind, base_url, api_key }) or a provider slug string.
 */
export async function listModels(provider, {
  env = {},
  fetchImpl = fetch,
  timeoutMs = 4000,
  refresh = false,
  now = Date.now,
} = {}) {
  let providerId;
  let kind = 'openai-compatible';
  let base_url = '';
  let api_key = null;

  if (typeof provider === 'string') {
    providerId = provider;
    if (providerId === 'gemini') {
      kind = 'gemini';
      api_key = env.gemini?.apiKey;
    } else if (providerId === 'ollama') {
      kind = 'ollama';
      base_url = env.ollama?.url || 'http://127.0.0.1:11434';
    } else if (providerId === 'openai') {
      kind = 'openai-compatible';
      base_url = env.openai?.baseUrl || 'https://api.openai.com/v1';
      api_key = env.openai?.apiKey;
    } else if (providerId === 'opencode') {
      kind = 'openai-compatible';
      base_url = env.opencode?.baseUrl || 'https://opencode.ai/zen/go/v1';
      api_key = env.opencode?.apiKey;
    } else if (providerId === 'openrouter') {
      kind = 'openai-compatible';
      base_url = env.openrouter?.baseUrl || 'https://openrouter.ai/api/v1';
      api_key = env.openrouter?.apiKey;
    } else if (env[providerId]) {
      base_url = env[providerId].baseUrl || env[providerId].url || '';
      api_key = env[providerId].apiKey || null;
    }
  } else if (provider && typeof provider === 'object') {
    providerId = provider.id;
    kind = provider.kind || 'openai-compatible';
    base_url = provider.base_url || provider.baseUrl || (env[providerId]?.baseUrl || env[providerId]?.url || '');
    api_key = provider.api_key || provider.apiKey || (env[providerId]?.apiKey || null);
    if (!base_url && providerId === 'openai') base_url = 'https://api.openai.com/v1';
    if (!base_url && providerId === 'openrouter') base_url = 'https://openrouter.ai/api/v1';
    if (!base_url && providerId === 'opencode') base_url = 'https://opencode.ai/zen/go/v1';
    if (!base_url && providerId === 'ollama') base_url = 'http://127.0.0.1:11434';
  }

  if (!providerId) return { provider: null, models: [], source: 'curated', error: 'Provider not found', fetchedAt: now() };

  const curated = CURATED_MODELS[providerId] || [];
  const base = { provider: providerId, curated, default: DEFAULT_MODELS[providerId] || null };

  const hit = cache.get(providerId);
  if (!refresh && hit && hit.until > now()) return hit.payload;

  let payload;
  try {
    let models;
    switch (kind) {
      case 'gemini':
        models = await fetchGemini({ apiKey: api_key, fetchImpl, timeoutMs });
        break;
      case 'ollama':
        models = await fetchOllama({ baseUrl: base_url, fetchImpl, timeoutMs });
        break;
      case 'openai-compatible':
      default:
        models = await fetchOpenAICompatible({
          baseUrl: base_url,
          apiKey: api_key,
          fetchImpl,
          timeoutMs,
          isOpenAI: providerId === 'openai',
        });
        break;
    }
    models = dedupe(models);
    if (!models.length) throw new Error('provider returned no models');
    payload = { ...base, models: order(models, curated), source: 'live', error: null, fetchedAt: now() };
  } catch (err) {
    payload = {
      ...base,
      models: curated.map((id) => entry(id)),
      source: 'curated',
      error: err?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : (err?.message || String(err)),
      fetchedAt: now(),
    };
  }
  cache.set(providerId, { until: now() + (payload.source === 'live' ? CACHE_TTL_MS : ERROR_TTL_MS), payload });
  return payload;
}

/**
 * Rank a catalog against a search string. Every whitespace-separated token must
 * appear in the id or the display label; exact id, then prefix, then id-substring
 * matches come first, so typing "flash" or "claude son" lands on the obvious pick.
 */
export function searchModels(models, query = '', limit = 25) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return models.slice(0, limit);
  const tokens = q.split(/\s+/);
  const scored = [];
  for (let i = 0; i < models.length; i += 1) {
    const m = models[i];
    const id = m.id.toLowerCase();
    const hay = `${id} ${String(m.label || '').toLowerCase()}`;
    if (!tokens.every((t) => hay.includes(t))) continue;
    const score = id === q ? 0 : id.startsWith(q) ? 1 : id.includes(q) ? 2 : 3;
    scored.push({ m, score, i });
  }
  // Stable within a score band: preserve the catalog's own ordering.
  scored.sort((a, b) => (a.score - b.score) || (a.i - b.i));
  return scored.slice(0, limit).map((s) => s.m);
}
