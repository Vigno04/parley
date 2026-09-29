// src/pipeline/retry.js
// Re-run a failed meeting from the dashboard or CLI. Chooses the right recovery
// path from the meeting's current state:
//
//   • Has stored utterances  → re-summarize only (skips STT entirely). Handles
//     summary_failed and any case where the transcript survived.
//   • No utterances + PCM on disk → re-run the full pipeline (transcribe +
//     summarize). Handles transcription_failed when the audio is still present.
//   • No utterances + no PCM  → unrecoverable; report clearly.
//
// Returns { ok, action, status, reason }.
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { getGuildConfig } from '../store/config.js';
import { getSummarizer } from '../adapters/summarizer/index.js';
import { buildTranscript, computeTalkTime } from './summarize.js';
import { resolveSummaryLanguage } from '../adapters/summarizer/languages.js';
import { describeSummarizerError } from '../adapters/summarizer/errors.js';
import { parsePcmName } from '../voice/audio.js';
import { processMeeting } from './orchestrator.js';

// Statuses the UI should offer a retry or transcription for.
export const RETRYABLE_STATUSES = new Set(['transcription_failed', 'summary_failed', 'processing', 'recording', 'recorded']);

/** Decide what a retry would do, without doing it (for enabling UI + messaging). */
export function retryPlan(db, meetingId, { dataDir, exists = readdirSync } = {}) {
  const meeting = db.getMeeting(meetingId);
  if (!meeting) return { ok: false, action: 'none', reason: 'Meeting not found.' };
  const hasUtterances = db.listUtterances(meetingId).length > 0;
  let pcmCount = 0;
  try { pcmCount = exists(join(dataDir, 'audio', String(meetingId))).filter((f) => f.endsWith('.pcm')).length; }
  catch { pcmCount = 0; }
  if (pcmCount > 0 && meeting.transcription_complete !== 1) {
    return { ok: true, action: 'retranscribe', meeting };
  }
  if (hasUtterances) return { ok: true, action: 'resummarize', meeting };
  if (pcmCount > 0) return { ok: true, action: 'retranscribe', meeting };
  return { ok: false, action: 'none', meeting,
    reason: 'No transcript and no saved audio remain for this meeting, so it cannot be retried.' };
}

/**
 * Execute the retry. `deps.deliver` (optional) posts to Discord when a live
 * client is available; omit it for the dashboard (notes just show in the UI).
 */
export async function retryMeeting(db, meetingId, { dataDir, deliver = null } = {}) {
  const plan = retryPlan(db, meetingId, { dataDir });
  if (!plan.ok) return { ok: false, action: plan.action, status: db.getMeeting(meetingId)?.status, reason: plan.reason };

  const meeting = plan.meeting;
  const cfg = getGuildConfig(db, meeting.guild_id);

  if (plan.action === 'resummarize') {
    const utterances = db.listUtterances(meetingId).map((u) => ({
      userId: u.user_id, displayName: u.display_name, startMs: u.start_ms, endMs: u.end_ms, text: u.text,
    }));
    const talktime = computeTalkTime(utterances);
    if (cfg.summarizerEnabled === false) {
      db.clearSummary(meetingId);
      db.saveSummary(meetingId, null, talktime, 'disabled');
      db.setMeetingStatus(meetingId, 'done', new Date().toISOString());
      return { ok: true, action: 'resummarize', status: 'done' };
    }
    const transcript = buildTranscript(utterances);
    const meta = {
      channelName: meeting.channel_name, date: meeting.started_at,
      attendees: db.listAttendees(meetingId).map((a) => a.display_name),
      summaryLanguage: resolveSummaryLanguage(cfg),
    };
    db.setMeetingStatus(meetingId, 'processing');
    let notes;
    const summarizer = getSummarizer(cfg, db);
    try {
      notes = await summarizer.summarize(transcript, meta);
    } catch (err) {
      db.setMeetingStatus(meetingId, 'summary_failed');
      return { ok: false, action: 'resummarize', status: 'summary_failed',
        reason: err.userMessage ?? describeSummarizerError(err, cfg.summarizerProvider) };
    }
    db.clearSummary(meetingId);
    db.saveSummary(meetingId, notes, talktime, summarizer.lastUsed ?? `${cfg.summarizerProvider}:${cfg.summarizerModel || ''}`);
    db.seedTodos(meetingId, meeting.guild_id, notes.actionItems || [], meeting.started_at);
    db.setMeetingStatus(meetingId, 'done', new Date().toISOString());
    if (deliver) await deliver(notes, talktime, meta).catch(() => {});
    return { ok: true, action: 'resummarize', status: 'done' };
  }

  return retranscribeMeeting(db, meetingId, { dataDir, deliver });
}

/**
 * Retranscribe a meeting using its saved audio files and an optional model override.
 */
export async function retranscribeMeeting(db, meetingId, { dataDir, deliver = null, sttProvider, whisperModel, sttModel } = {}) {
  const meeting = db.getMeeting(meetingId);
  if (!meeting) return { ok: false, action: 'retranscribe', status: null, reason: 'Meeting not found.' };

  const audioDir = join(dataDir, 'audio', String(meetingId));
  let pcmFiles = [];
  try {
    pcmFiles = readdirSync(audioDir).filter((f) => f.endsWith('.pcm'));
  } catch {
    pcmFiles = [];
  }
  if (pcmFiles.length === 0) {
    return { ok: false, action: 'retranscribe', status: meeting.status, reason: 'No audio recordings remain on disk for this meeting.' };
  }

  const baseCfg = getGuildConfig(db, meeting.guild_id);
  const cfg = {
    ...baseCfg,
    ...(sttProvider ? { sttProvider } : {}),
    ...(whisperModel ? { whisperModel } : {}),
    ...(sttModel !== undefined ? { sttModel } : {}),
  };

  const nameById = new Map(db.listAttendees(meetingId).map((a) => [a.user_id, a.display_name]));
  const tracks = pcmFiles
    .map((f) => {
      const { userId, startMs } = parsePcmName(f);
      return { userId, displayName: nameById.get(userId) || userId, startMs, pcmPath: join(audioDir, f) };
    })
    .sort((a, b) => a.startMs - b.startMs);

  try {
    const { notes, empty } = await processMeeting(db, meetingId, { tracks, cfg, deliver });
    // Check retention before dropping the audio dir
    if ((cfg.recordingRetention || 'immediately') === 'immediately') {
      await rm(audioDir, { recursive: true, force: true }).catch(() => {});
    }
    return { ok: true, action: 'retranscribe', status: db.getMeeting(meetingId)?.status, empty: !notes || !!empty };
  } catch (err) {
    const status = db.getMeeting(meetingId)?.status;
    return {
      ok: false,
      action: 'retranscribe',
      status,
      reason: err.userMessage || describeSummarizerError(err, cfg.summarizerProvider),
    };
  }
}
