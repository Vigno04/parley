// src/pipeline/jobs.js
// Registry of in-flight transcription/summarize jobs, each with an
// AbortController so the dashboard can cancel a stuck pipeline.
//
// Why: without this, a dead STT endpoint causes transcribeTracks to retry
// every track forever (one failed fetch per track, but the worker pool never
// stops), and neither "Delete generated data" nor "Delete meeting" interrupts
// the in-flight work — the pipeline keeps running against a meeting that the
// user already wiped. This module gives every job a single abort switch that
// the API exposes as POST /meetings/:id/cancel.

const jobs = new Map(); // meetingId -> { controller, phase, startedAt }

export function registerJob(meetingId, { phase = 'transcribing' } = {}) {
  const id = Number(meetingId);
  // If a job is already active, return its existing controller so the caller
  // can attach to the in-flight work instead of spawning a duplicate.
  const existing = jobs.get(id);
  if (existing && !existing.controller.signal.aborted) return existing;

  const controller = new AbortController();
  const entry = { controller, phase, startedAt: Date.now() };
  jobs.set(id, entry);
  return entry;
}

export function getJob(meetingId) {
  return jobs.get(Number(meetingId)) || null;
}

export function cancelJob(meetingId) {
  const id = Number(meetingId);
  const job = jobs.get(id);
  if (!job) return false;
  job.controller.abort();
  return true;
}

export function removeJob(meetingId) {
  return jobs.delete(Number(meetingId));
}

/** Snapshot for the UI: which meetings are currently mid-pipeline. */
export function listActiveJobs() {
  const out = [];
  for (const [id, job] of jobs) {
    if (job.controller.signal.aborted) continue;
    out.push({ meetingId: id, phase: job.phase, startedAt: job.startedAt });
  }
  return out;
}