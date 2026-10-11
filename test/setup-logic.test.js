import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSetup } from '../src/commands/setup-logic.js';

const env = { gemini: { apiKey: 'g' }, openai: { apiKey: '' }, opencode: { apiKey: '' }, openrouter: { apiKey: '' }, ollama: { url: 'http://x' }, sttUrl: 'http://127.0.0.1:8000' };

test('accepts gemini when key present', () => {
  const r = validateSetup({ provider: 'gemini', model: 'gemini-2.5-flash' }, env);
  assert.equal(r.ok, true);
  assert.equal(r.patch.summarizerProvider, 'gemini');
});

test('rejects openai when key missing', () => {
  const r = validateSetup({ provider: 'openai', model: 'gpt-x' }, env);
  assert.equal(r.ok, false);
  assert.match(r.error, /OPENAI_API_KEY/);
});

test('rejects opencode when key missing', () => {
  const r = validateSetup({ provider: 'opencode', model: 'gpt-5.5' }, env);
  assert.equal(r.ok, false);
  assert.match(r.error, /OPENCODE_API_KEY/);
});

test('accepts opencode when key present', () => {
  const r = validateSetup({ provider: 'opencode', model: 'gpt-5.5' }, { ...env, opencode: { apiKey: 'k' } });
  assert.equal(r.ok, true);
  assert.equal(r.patch.summarizerProvider, 'opencode');
  assert.equal(r.patch.summarizerModel, 'gpt-5.5');
});

test('rejects openrouter when key missing', () => {
  const r = validateSetup({ provider: 'openrouter', model: 'openai/gpt-4o-mini' }, env);
  assert.equal(r.ok, false);
  assert.match(r.error, /OPENROUTER_API_KEY/);
});

test('accepts openrouter when key present', () => {
  const r = validateSetup({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4' }, { ...env, openrouter: { apiKey: 'k' } });
  assert.equal(r.ok, true);
  assert.equal(r.patch.summarizerProvider, 'openrouter');
  assert.equal(r.patch.summarizerModel, 'anthropic/claude-sonnet-4');
});

test('rejects unknown provider', () => {
  const r = validateSetup({ provider: 'bogus' }, env);
  assert.equal(r.ok, false);
  assert.match(r.error, /provider/i);
});

test('accepts whisper model + thread + autojoin booleans', () => {
  const r = validateSetup({ whisperModel: 'medium', useThread: false, autoJoin: true }, env);
  assert.equal(r.ok, true);
  assert.equal(r.patch.whisperModel, 'medium');
  assert.equal(r.patch.useThread, false);
});

test('rejects invalid whisper model', () => {
  const r = validateSetup({ whisperModel: 'humongous' }, env);
  assert.equal(r.ok, false);
  assert.match(r.error, /whisper/i);
});

test('accepts valid language + summary_language', () => {
  const r = validateSetup({ language: 'de', summary_language: 'en' }, env);
  assert.equal(r.ok, true);
  assert.equal(r.patch.language, 'de');
  assert.equal(r.patch.summaryLanguage, 'en');
});

test('accepts summary_language match', () => {
  const r = validateSetup({ summary_language: 'match' }, env);
  assert.equal(r.ok, true);
  assert.equal(r.patch.summaryLanguage, 'match');
});

test('rejects unknown transcription language', () => {
  const r = validateSetup({ language: 'zz' }, env);
  assert.equal(r.ok, false);
  assert.match(r.error, /language/i);
});

test('rejects unknown summary_language', () => {
  const r = validateSetup({ summary_language: 'zz' }, env);
  assert.equal(r.ok, false);
  assert.match(r.error, /summary language/i);
});

// ── STT provider selection ───────────────────────────────────────────────────

test('accepts sidecar STT provider without a key', () => {
  const r = validateSetup({ sttProvider: 'sidecar' }, env);
  assert.equal(r.ok, true);
  assert.equal(r.patch.sttProvider, 'sidecar');
});

test('rejects openai STT when OPENAI_API_KEY missing', () => {
  const r = validateSetup({ sttProvider: 'openai' }, env);
  assert.equal(r.ok, false);
  assert.match(r.error, /OPENAI_API_KEY/);
});

test('accepts openai STT with key and a valid model', () => {
  const r = validateSetup({ sttProvider: 'openai', sttModel: 'whisper-1' }, { ...env, openai: { apiKey: 'k' } });
  assert.equal(r.ok, true);
  assert.equal(r.patch.sttProvider, 'openai');
  assert.equal(r.patch.sttModel, 'whisper-1');
});

test('rejects an invalid openai STT model', () => {
  const r = validateSetup({ sttProvider: 'openai', sttModel: 'whisper-9000' }, { ...env, openai: { apiKey: 'k' } });
  assert.equal(r.ok, false);
  assert.match(r.error, /openai model/i);
});

test('rejects an unknown STT provider', () => {
  const r = validateSetup({ sttProvider: 'magic' }, env);
  assert.equal(r.ok, false);
  assert.match(r.error, /STT provider/i);
});

test('rejects openai STT when OPENAI_API_KEY missing', () => {
  const r = validateSetup({ sttProvider: 'openai' }, env);
  assert.equal(r.ok, false);
  assert.match(r.error, /OPENAI_API_KEY/);
});

test('accepts a fallback provider whose key is present', () => {
  const r = validateSetup({ fallbackProvider: 'gemini', fallbackModel: 'gemini-2.5-flash' }, env);
  assert.equal(r.ok, true);
  assert.equal(r.patch.summarizerFallbackProvider, 'gemini');
  assert.equal(r.patch.summarizerFallbackModel, 'gemini-2.5-flash');
});

test('rejects a fallback provider whose key is missing', () => {
  const r = validateSetup({ fallbackProvider: 'openrouter' }, env);
  assert.equal(r.ok, false);
  assert.match(r.error, /OPENROUTER_API_KEY/);
});

test('rejects an unknown fallback provider', () => {
  const r = validateSetup({ fallbackProvider: 'bogus' }, env);
  assert.equal(r.ok, false);
  assert.match(r.error, /Unknown fallback provider/);
});

test('"none" clears both fallback fields', () => {
  const r = validateSetup({ fallbackProvider: 'none' }, env);
  assert.equal(r.ok, true);
  assert.equal(r.patch.summarizerFallbackProvider, null);
  assert.equal(r.patch.summarizerFallbackModel, null);
});

test('a fallback provider with no model defaults to that provider\'s first suggestion', () => {
  const r = validateSetup({ fallbackProvider: 'gemini' }, env);
  assert.equal(r.ok, true);
  assert.equal(r.patch.summarizerFallbackModel, 'gemini-2.5-flash',
    'must not inherit the outgoing provider\'s model id');
});

test('fallback model alone updates only the model', () => {
  const r = validateSetup({ fallbackModel: 'glm-5.3' }, env);
  assert.equal(r.ok, true);
  assert.equal(r.patch.summarizerFallbackModel, 'glm-5.3');
  assert.equal('summarizerFallbackProvider' in r.patch, false);
});

test('accepts custom provider with baseUrl even if apiKey is missing', () => {
  const db = {
    getProvider: (id) => id === 'local-llm' ? { id, kind: 'openai-compatible', base_url: 'http://localhost:8000', api_key: null, caps: 'summarizer' } : null,
  };
  const r = validateSetup({ provider: 'local-llm' }, db);
  assert.equal(r.ok, true);
  assert.equal(r.patch.summarizerProvider, 'local-llm');
});

test('switching provider with empty model clears summarizerModel', () => {
  const db = {
    getProvider: (id) => id === 'local-llm' ? { id, kind: 'openai-compatible', base_url: 'http://localhost:8000', api_key: null, caps: 'summarizer' } : null,
  };
  const r = validateSetup({ provider: 'local-llm', model: '' }, db);
  assert.equal(r.ok, true);
  assert.equal(r.patch.summarizerProvider, 'local-llm');
  assert.equal(r.patch.summarizerModel, null);
});

test('accepts summarizerEnabled boolean flag', () => {
  const r1 = validateSetup({ summarizerEnabled: false }, env);
  assert.equal(r1.ok, true);
  assert.equal(r1.patch.summarizerEnabled, false);

  const r2 = validateSetup({ summarizer_enabled: true }, env);
  assert.equal(r2.ok, true);
  assert.equal(r2.patch.summarizerEnabled, true);
});

test('accepts valid recordingRetention and rejects invalid', () => {
  const r1 = validateSetup({ recordingRetention: '7d' }, env);
  assert.equal(r1.ok, true);
  assert.equal(r1.patch.recordingRetention, '7d');

  const r2 = validateSetup({ recording_retention: 'never' }, env);
  assert.equal(r2.ok, true);
  assert.equal(r2.patch.recordingRetention, 'never');

  const r3 = validateSetup({ recordingRetention: 'invalid-val' }, env);
  assert.equal(r3.ok, false);
  assert.match(r3.error, /recording retention/i);
});

test('accepts autoTranscribe boolean flag', () => {
  const r1 = validateSetup({ autoTranscribe: false }, env);
  assert.equal(r1.ok, true);
  assert.equal(r1.patch.autoTranscribe, false);

  const r2 = validateSetup({ auto_transcribe: true }, env);
  assert.equal(r2.ok, true);
  assert.equal(r2.patch.autoTranscribe, true);
});

test('accepts userBlacklist and muteBlacklisted flags', () => {
  const r1 = validateSetup({ blacklist: '123, 456' }, env);
  assert.equal(r1.ok, true);
  assert.deepEqual(r1.patch.userBlacklist, ['123', '456']);

  const r2 = validateSetup({ mute_blacklisted: false }, env);
  assert.equal(r2.ok, true);
  assert.equal(r2.patch.muteBlacklisted, false);

  const r3 = validateSetup({ muteBlacklisted: true }, env);
  assert.equal(r3.ok, true);
  assert.equal(r3.patch.muteBlacklisted, true);
});

