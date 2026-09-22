import { FakeSummarizer } from './fake.js';
import { GeminiSummarizer } from './gemini.js';
import { OllamaSummarizer } from './ollama.js';
import { OpenAISummarizer } from './openai.js';
import { OpenCodeSummarizer } from './opencode.js';
import { OpenRouterSummarizer } from './openrouter.js';
import { FallbackSummarizer } from './fallback.js';
import { DEFAULT_MODELS } from './models.js';

// Build a summarizer from a provider DB row ({ id, kind, base_url, api_key, … })
// and a model id. The `kind` selects the adapter class.
export function createAdapter(providerRow, model) {
  if (!providerRow) throw new Error('No provider configured.');
  if (providerRow.id === 'fake' || providerRow.kind === 'fake') return new FakeSummarizer();
  const { id, kind, base_url, api_key } = providerRow;
  const resolvedModel = model || DEFAULT_MODELS[id] || '';

  if (id === 'opencode') return new OpenCodeSummarizer(resolvedModel, base_url || 'https://opencode.ai/zen/go/v1', api_key);
  if (id === 'openrouter') return new OpenRouterSummarizer(resolvedModel, base_url || 'https://openrouter.ai/api/v1', api_key);

  switch (kind) {
    case 'gemini':
      return new GeminiSummarizer(resolvedModel, api_key);
    case 'ollama':
      return new OllamaSummarizer(resolvedModel, base_url || 'http://127.0.0.1:11434');
    case 'openai-compatible':
    default:
      return new OpenAISummarizer(resolvedModel, base_url || 'https://api.openai.com/v1', api_key);
  }
}

const label = (id, model) => `${id}:${model || ''}`;

// Resolve a guild config to a working summarizer. Looks up the provider row
// from the DB (with backward-compatible env fallback).
export function getSummarizer(cfg = {}, dbOrEnv = null) {
  const providerId = cfg?.summarizerProvider;
  if (providerId === 'fake') return new FakeSummarizer();

  let row;
  if (dbOrEnv && typeof dbOrEnv.getProvider === 'function') {
    row = dbOrEnv.getProvider(providerId);
    if (!row) throw new Error(`Provider "${providerId}" not found. Add it from the dashboard.`);
  } else {
    // env fallback
    const env = dbOrEnv || {};
    row = {
      id: providerId,
      kind: providerId === 'gemini' ? 'gemini' : providerId === 'ollama' ? 'ollama' : 'openai-compatible',
      base_url: env[providerId]?.baseUrl || env[providerId]?.url,
      api_key: env[providerId]?.apiKey,
    };
  }

  const primaryModel = cfg.summarizerModel || DEFAULT_MODELS[providerId] || '';
  const primary = createAdapter(row, primaryModel);
  const fbProvider = cfg.summarizerFallbackProvider;
  const fbModel = cfg.summarizerFallbackModel || (fbProvider ? DEFAULT_MODELS[fbProvider] : '') || '';
  const primaryLabel = label(providerId, primaryModel);
  const fallbackLabel = label(fbProvider, fbModel);

  if (!fbProvider || fbProvider === 'none' || fallbackLabel === primaryLabel) return primary;

  return new FallbackSummarizer(primary, () => {
    let fbRow;
    if (dbOrEnv && typeof dbOrEnv.getProvider === 'function') {
      fbRow = dbOrEnv.getProvider(fbProvider);
      if (!fbRow) throw new Error(`Fallback provider "${fbProvider}" not found.`);
    } else {
      const env = dbOrEnv || {};
      fbRow = {
        id: fbProvider,
        kind: fbProvider === 'gemini' ? 'gemini' : fbProvider === 'ollama' ? 'ollama' : 'openai-compatible',
        base_url: env[fbProvider]?.baseUrl || env[fbProvider]?.url,
        api_key: env[fbProvider]?.apiKey,
      };
    }
    return createAdapter(fbRow, fbModel);
  }, { label: primaryLabel, fallbackLabel });
}
