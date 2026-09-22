// Autocomplete for /setup's options: provider and model catalogs from the DB.
//
// Provider options (provider, fallback_provider, stt_provider) autocomplete
// against the DB provider list. Model options (model, fallback_model, stt_model)
// show the live catalog from the selected provider's endpoint.

import { listModels, searchModels, formatContext } from '../adapters/summarizer/models.js';
import { availableSttProviders } from '../adapters/stt/index.js';
import { getGuildConfig } from '../store/config.js';

export const MAX_CHOICES = 25;
const MAX_NAME = 100; // Discord's per-choice name/value limit

// `id · 128K` — the id is what gets saved, the context window is the hint.
export function modelChoiceName(model) {
  const ctx = formatContext(model.context);
  const suffix = ctx ? ` · ${ctx}` : '';
  const room = MAX_NAME - suffix.length;
  const id = model.id.length > room ? `${model.id.slice(0, room - 1)}…` : model.id;
  return `${id}${suffix}`;
}

// Autocomplete for summarizer provider options.
function providerChoices(db, query = '', capsFilter = null) {
  if (!db) return [];
  const providers = db.listProviders()
    .filter((row) => !capsFilter || row.caps === capsFilter || row.caps === 'both');
  const q = (query || '').toLowerCase();
  return providers
    .filter((p) => !q || p.id.toLowerCase().includes(q) || (p.name || '').toLowerCase().includes(q))
    .slice(0, MAX_CHOICES)
    .map((p) => ({ name: `${p.name || p.id} (${p.kind})`.slice(0, MAX_NAME), value: p.id.slice(0, MAX_NAME) }));
}

// Autocomplete for STT provider options (sidecar + DB providers with stt/both caps).
function sttProviderChoices(db, query = '', env) {
  const all = availableSttProviders(db, env);
  const q = (query || '').toLowerCase();
  return all
    .filter((p) => !q || p.provider.toLowerCase().includes(q) || (p.label || '').toLowerCase().includes(q))
    .slice(0, MAX_CHOICES)
    .map((p) => ({ name: (p.label || p.provider).slice(0, MAX_NAME), value: p.provider.slice(0, MAX_NAME) }));
}

/**
 * Which provider row to use for model autocomplete. `picked` holds the provider
 * options from the same invocation (they win — the user is switching provider
 * and model together); otherwise fall back to the guild's saved config.
 * Returns the provider row, or null.
 */
export function providerForOption(optionName, picked = {}, cfg = {}) {
  let providerId;
  if (optionName === 'model') providerId = picked.provider || cfg.summarizerProvider;
  else if (optionName === 'fallback_model') {
    providerId = picked.fallbackProvider || cfg.summarizerFallbackProvider || cfg.summarizerProvider;
    if (providerId === 'none') return null;
  } else if (optionName === 'stt_model') {
    providerId = picked.sttProvider || cfg.sttProvider;
    if (providerId === 'sidecar') return null;
  } else {
    return null;
  }
  return providerId || null;
}

function providerRowForOption(optionName, picked = {}, cfg = {}, db = null) {
  const providerId = providerForOption(optionName, picked, cfg);
  if (!providerId) return null;
  if (db && typeof db.getProvider === 'function') {
    const row = db.getProvider(providerId);
    if (row) return row;
  }
  return providerId;
}

export async function modelChoices(provider, query = '', opts = {}) {
  if (!provider) return [];
  const { models } = await listModels(provider, { timeoutMs: 2000, ...opts });
  return searchModels(models, query, MAX_CHOICES)
    .map((m) => ({ name: modelChoiceName(m), value: m.id.slice(0, MAX_NAME) }));
}

/**
 * Answer one autocomplete interaction. Discord allows exactly one response.
 */
export async function handleAutocomplete(interaction, { db, env, ...opts } = {}) {
  try {
    const focused = interaction.options.getFocused(true);
    const cfg = interaction.guildId && db ? getGuildConfig(db, interaction.guildId) : {};

    // Provider autocomplete
    if (focused.name === 'provider' || focused.name === 'fallback_provider') {
      const choices = providerChoices(db, focused.value, 'summarizer');
      if (focused.name === 'fallback_provider') {
        choices.unshift({ name: 'none', value: 'none' });
      }
      return interaction.respond(choices.slice(0, MAX_CHOICES));
    }
    if (focused.name === 'stt_provider') {
      return interaction.respond(sttProviderChoices(db, focused.value, env));
    }

    // Model autocomplete — look up the provider row and query its catalog.
    const picked = {
      provider: interaction.options.getString('provider'),
      fallbackProvider: interaction.options.getString('fallback_provider'),
      sttProvider: interaction.options.getString('stt_provider'),
    };
    const providerRow = providerRowForOption(focused.name, picked, cfg, db);
    await interaction.respond(await modelChoices(providerRow, focused.value, opts));
  } catch (err) {
    console.error('autocomplete error:', err);
    await interaction.respond([]).catch(() => {});
  }
}
