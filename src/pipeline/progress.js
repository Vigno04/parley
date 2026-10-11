// src/pipeline/progress.js
// In-memory progress registry for active transcriptions and benchmarks.

const activeProgress = new Map();

/**
 * Format remaining seconds into a human-readable ETA string.
 * e.g., 45 -> "~45s", 125 -> "~2m 5s", 3660 -> "~1h 1m"
 */
export function formatEta(seconds) {
  if (seconds == null || isNaN(seconds) || seconds < 0) return 'calculating…';
  if (seconds < 5) return 'almost done';
  if (seconds < 60) return `~${Math.round(seconds)}s remaining`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (mins < 60) {
    return secs > 0 ? `~${mins}m ${secs}s remaining` : `~${mins}m remaining`;
  }
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `~${hours}h ${remMins}m remaining`;
}

/**
 * Record or update transcription / benchmark progress for a meeting.
 */
export function setMeetingProgress(meetingId, data) {
  if (!meetingId) return;
  const id = Number(meetingId);
  const existing = activeProgress.get(id) || {};
  const startedAt = existing.startedAt || data.startedAt || Date.now();
  const elapsedSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));

  const total = Number(data.total) || 1;
  const completed = Math.min(total, Math.max(0, Number(data.completed) || 0));
  
  let percent = typeof data.percent === 'number'
    ? Math.min(100, Math.max(0, Math.round(data.percent)))
    : Math.min(100, Math.max(0, Math.round((completed / total) * 100)));

  // If completed < total, don't display 100% until truly done
  if (completed < total && percent >= 100) {
    percent = 99;
  }

  let etaSeconds = data.etaSeconds ?? null;
  if (etaSeconds == null && completed > 0 && total > completed) {
    const rate = elapsedSeconds / completed;
    etaSeconds = Math.round((total - completed) * rate);
  }

  const updated = {
    ...existing,
    ...data,
    meetingId: id,
    startedAt,
    elapsedSeconds,
    completed,
    total,
    percent,
    etaSeconds,
    etaFormatted: formatEta(etaSeconds),
    updatedAt: Date.now(),
  };

  activeProgress.set(id, updated);
  return updated;
}

/**
 * Retrieve current progress for a meeting, if active.
 */
export function getMeetingProgress(meetingId) {
  if (!meetingId) return null;
  const id = Number(meetingId);
  const p = activeProgress.get(id);
  if (!p) return null;

  // Stale check: if no updates for 10 minutes, prune
  if (Date.now() - p.updatedAt > 10 * 60 * 1000) {
    activeProgress.delete(id);
    return null;
  }

  // Update dynamic elapsed time & ETA on read
  const elapsedSeconds = Math.max(0, Math.round((Date.now() - p.startedAt) / 1000));
  let etaSeconds = p.etaSeconds;
  if (p.completed > 0 && p.total > p.completed) {
    const rate = elapsedSeconds / p.completed;
    etaSeconds = Math.max(0, Math.round((p.total - p.completed) * rate));
  }

  return {
    ...p,
    elapsedSeconds,
    etaSeconds,
    etaFormatted: formatEta(etaSeconds),
  };
}

/**
 * Clear progress when transcription or benchmark completes or errors.
 */
export function clearMeetingProgress(meetingId) {
  if (!meetingId) return;
  activeProgress.delete(Number(meetingId));
}
