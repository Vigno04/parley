export const DEFAULTS = {
  summarizerEnabled: true,
  autoTranscribe: true,
  summarizerProvider: 'gemini',
  summarizerModel: 'gemini-2.5-flash',
  // null = no fallback; when set, getSummarizer wraps the primary so one
  // provider outage doesn't fail a meeting whose transcript is already intact.
  summarizerFallbackProvider: null,
  summarizerFallbackModel: null,
  sttProvider: 'sidecar',
  sttModel: null,
  whisperModel: 'small',
  notesChannelId: null,
  useThread: true,
  autoJoin: true,
  language: 'auto',
  summaryLanguage: 'en',
  recordingRetention: 'immediately',
};

const COLS = {
  summarizerEnabled: 'summarizer_enabled',
  autoTranscribe: 'auto_transcribe',
  summarizerProvider: 'summarizer_provider',
  summarizerModel: 'summarizer_model',
  summarizerFallbackProvider: 'summarizer_fallback_provider',
  summarizerFallbackModel: 'summarizer_fallback_model',
  sttProvider: 'stt_provider',
  sttModel: 'stt_model',
  whisperModel: 'whisper_model',
  notesChannelId: 'notes_channel_id',
  useThread: 'use_thread',
  autoJoin: 'auto_join',
  language: 'language',
  summaryLanguage: 'summary_language',
  recordingRetention: 'recording_retention',
};

function fromRow(row) {
  return {
    summarizerEnabled: row.summarizer_enabled == null ? DEFAULTS.summarizerEnabled : !!row.summarizer_enabled,
    autoTranscribe: row.auto_transcribe == null ? DEFAULTS.autoTranscribe : !!row.auto_transcribe,
    summarizerProvider: row.summarizer_provider ?? DEFAULTS.summarizerProvider,
    summarizerModel: row.summarizer_model ?? DEFAULTS.summarizerModel,
    summarizerFallbackProvider: row.summarizer_fallback_provider ?? DEFAULTS.summarizerFallbackProvider,
    summarizerFallbackModel: row.summarizer_fallback_model ?? DEFAULTS.summarizerFallbackModel,
    sttProvider: row.stt_provider ?? DEFAULTS.sttProvider,
    sttModel: row.stt_model ?? DEFAULTS.sttModel,
    whisperModel: row.whisper_model ?? DEFAULTS.whisperModel,
    notesChannelId: row.notes_channel_id ?? DEFAULTS.notesChannelId,
    useThread: row.use_thread == null ? DEFAULTS.useThread : !!row.use_thread,
    autoJoin: row.auto_join == null ? DEFAULTS.autoJoin : !!row.auto_join,
    language: row.language ?? DEFAULTS.language,
    summaryLanguage: row.summary_language ?? DEFAULTS.summaryLanguage,
    recordingRetention: row.recording_retention ?? DEFAULTS.recordingRetention,
  };
}

export function getGuildConfig(db, guildId) {
  const row = db.sql.prepare(`SELECT * FROM guild_config WHERE guild_id = ?`).get(guildId);
  return { guildId, ...(row ? fromRow(row) : DEFAULTS) };
}

export function setGuildConfig(db, guildId, patch) {
  const current = getGuildConfig(db, guildId);
  // Drop undefined keys (node:sqlite cannot bind undefined) and pin guildId so a
  // stray patch key can't corrupt the row identity or the returned object.
  const safePatch = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const merged = { ...current, ...safePatch, guildId };
  db.sql.prepare(
    `INSERT OR REPLACE INTO guild_config
       (guild_id, summarizer_enabled, auto_transcribe, summarizer_provider, summarizer_model, summarizer_fallback_provider, summarizer_fallback_model, stt_provider, stt_model, whisper_model, notes_channel_id, use_thread, auto_join, language, summary_language, recording_retention)
     VALUES (@guildId, @summarizerEnabled, @autoTranscribe, @summarizerProvider, @summarizerModel, @summarizerFallbackProvider, @summarizerFallbackModel, @sttProvider, @sttModel, @whisperModel, @notesChannelId, @useThread, @autoJoin, @language, @summaryLanguage, @recordingRetention)`
  ).run({
    guildId,
    summarizerEnabled: merged.summarizerEnabled ? 1 : 0,
    autoTranscribe: merged.autoTranscribe ? 1 : 0,
    summarizerProvider: merged.summarizerProvider,
    summarizerModel: merged.summarizerModel,
    summarizerFallbackProvider: merged.summarizerFallbackProvider,
    summarizerFallbackModel: merged.summarizerFallbackModel,
    sttProvider: merged.sttProvider,
    sttModel: merged.sttModel,
    whisperModel: merged.whisperModel,
    notesChannelId: merged.notesChannelId,
    useThread: merged.useThread ? 1 : 0,
    autoJoin: merged.autoJoin ? 1 : 0,
    language: merged.language,
    summaryLanguage: merged.summaryLanguage,
    recordingRetention: merged.recordingRetention,
  });
  return merged;
}

export const CONFIG_COLS = COLS;
