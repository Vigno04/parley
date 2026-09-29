// src/store/reconcile.js
// Boot-time housekeeping that must run whether or not the Discord bot starts
// (web-only mode still needs it). Two jobs:
//
//   1. Orphaned meetings — rows left in 'recording'/'processing' by a crash mid-
//      pipeline. Mark them 'transcription_failed' so the dashboard offers a retry
//      (the PCM is usually still on disk) instead of stranding them forever.
//   2. Orphaned audio dirs — data/audio/<id> directories whose meeting is gone
//      (deleted) or already 'done'/'empty' (audio no longer needed). These
//      accumulate unbounded otherwise.
//
// Pure-ish: fs access is injectable for tests.
import { readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { getGuildConfig } from './config.js';

// Statuses whose meeting still needs its audio (a retry may retranscribe from PCM).
export const KEEP_AUDIO_STATUSES = new Set(['recording', 'processing', 'recorded', 'transcription_failed', 'summary_failed']);

export const RETENTION_MS = {
  immediately: 0,
  '1d': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '14d': 14 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
  never: Infinity,
};

export async function sweepExpiredAudio(db, audioRoot, { readdir = readdirSync, remove = rm, log = console, now = () => Date.now() } = {}) {
  let dirs = [];
  try {
    dirs = readdir(audioRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return 0;
  }
  let swept = 0;
  for (const name of dirs) {
    const id = Number(name);
    if (!Number.isInteger(id)) continue; // ignore non-numeric dirs we didn't create
    const meeting = db.getMeeting(id);
    if (!meeting) {
      // Meeting deleted -> sweep audio
      await remove(join(audioRoot, name), { recursive: true, force: true }).catch(() => {});
      swept += 1;
      continue;
    }
    // Meetings still live/failed need audio kept for retry
    if (KEEP_AUDIO_STATUSES.has(meeting.status)) {
      continue;
    }

    // Terminal status ('done', 'empty'): check retention setting
    let retention = 'immediately';
    try {
      const cfg = getGuildConfig(db, meeting.guild_id);
      retention = cfg?.recordingRetention || 'immediately';
    } catch {
      retention = 'immediately';
    }

    if (retention === 'never') {
      continue;
    }

    if (retention === 'immediately') {
      await remove(join(audioRoot, name), { recursive: true, force: true }).catch(() => {});
      swept += 1;
      continue;
    }

    const maxAgeMs = RETENTION_MS[retention] ?? 0;
    const rawTime = meeting.ended_at || meeting.started_at;
    const meetingTime = rawTime ? new Date(rawTime).getTime() : 0;
    const ageMs = Number.isNaN(meetingTime) ? Infinity : (now() - meetingTime);
    if (ageMs >= maxAgeMs) {
      await remove(join(audioRoot, name), { recursive: true, force: true }).catch(() => {});
      swept += 1;
    }
  }
  return swept;
}

export async function reconcileOnBoot(db, audioRoot, { readdir = readdirSync, remove = rm, log = console } = {}) {
  const result = { orphanMeetings: 0, sweptDirs: 0 };

  // 1) Orphaned meetings from a crash mid-pipeline.
  for (const m of db.findOrphanedMeetings()) {
    db.setMeetingStatus(m.id, 'transcription_failed');
    result.orphanMeetings += 1;
    log.warn?.(`[reconcile] meeting ${m.id} was mid-pipeline at last shutdown → transcription_failed (retry from the dashboard).`);
  }

  // 2) Sweep audio dirs that are expired or orphaned based on retention policy.
  result.sweptDirs = await sweepExpiredAudio(db, audioRoot, { readdir, remove, log });
  if (result.sweptDirs > 0) log.log?.(`[reconcile] swept ${result.sweptDirs} expired/orphaned audio dir(s).`);
  return result;
}
