import { Router } from 'express';
import { ChannelType } from 'discord.js';
import { readdirSync, createReadStream, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { getGuildConfig, setGuildConfig } from '../store/config.js';
import { validateSetup, availableProviders, RECORDING_RETENTION_OPTIONS, RECORDING_RETENTION_LABELS } from '../commands/setup-logic.js';
import { LANGUAGES } from '../adapters/summarizer/languages.js';
import { config as env } from '../config/env.js';
import { askMeeting } from '../adapters/summarizer/ask.js';
import { getSummarizer } from '../adapters/summarizer/index.js';
import { buildTranscript, computeTalkTime } from '../pipeline/summarize.js';
import { resolveSummaryLanguage } from '../adapters/summarizer/languages.js';
import { SUMMARY_PROMPT } from '../adapters/summarizer/notes.js';
import { listModels, clearModelCache, DEFAULT_MODELS } from '../adapters/summarizer/models.js';
import { connectionStatus, setConnection } from '../store/secrets.js';import { COMMAND_CATALOG } from '../commands/definitions.js';
import { retryMeeting, retranscribeMeeting, retryPlan, RETRYABLE_STATUSES } from '../pipeline/retry.js';
import { availableSttProviders } from '../adapters/stt/index.js';
import { transcribeTracks } from '../pipeline/transcribe.js';
import { parsePcmName, wavHeader, pcmDurationMs } from '../voice/audio.js';
import { requireAdmin } from './auth.js';
import { setMeetingProgress, getMeetingProgress, clearMeetingProgress } from '../pipeline/progress.js';

function guildName(client, id, dbNames = {}) {
  return client?.guilds?.cache?.get(id)?.name || dbNames[id] || id;
}

// Does any configured guild still use the local sidecar for transcription?
// Default provider is 'sidecar', so an unconfigured guild counts as sidecar.
function anyGuildUsesSidecar(db) {
  try {
    const rows = db.sql.prepare(`SELECT stt_provider FROM guild_config`).all();
    if (rows.length === 0) return true;
    return rows.some((row) => (row.stt_provider ?? 'sidecar') === 'sidecar');
  } catch { return true; }
}

export function apiRouter({ db, bot = null, client = null, sidecar = null, env: envOverride = null }) {
  const r = Router();
  const effectiveEnv = envOverride || env;
  const liveClient = () => bot?.client || client;
  const audioDir = (id) => join(effectiveEnv.dataDir, 'audio', String(id));

  function liveMeetings(guildId) {
    const sessions = (bot && typeof bot.liveMeetings === 'function' ? bot.liveMeetings() : [])
      .filter((s) => s.guildId === guildId);
    const c = liveClient();
    return sessions.map((s) => {
      let attendees = db.listAttendees(s.meetingId).map((a) => ({ id: a.user_id, displayName: a.display_name }));
      if (s.phase !== 'processing') {
        const channel = c?.guilds?.cache?.get(s.guildId)?.channels?.cache?.get(s.channelId);
        if (channel?.members) {
          const live = [...channel.members.values()].filter((m) => !m.user?.bot)
            .map((m) => ({ id: m.id, displayName: m.displayName }));
          if (live.length) attendees = live;
        }
      }
      return { ...s, attendees };
    });
  }

  r.get('/guilds', (_req, res) => {
    const c = liveClient();
    const fromDb = db.listGuilds().map(({ guild_id }) => guild_id);
    const fromCache = c ? [...c.guilds.cache.values()].map((g) => g.id) : [];
    const allIds = [...new Set([...fromDb, ...fromCache])];
    const dbNames = db.getGuildNames();
    res.json(allIds.map((id) => ({ id, name: guildName(c, id, dbNames) })));
  });

  r.get('/guilds/:g/meetings', (req, res) => {
    res.json(db.listRecentRich(req.params.g, 100));
  });

  r.get('/guilds/:g/live', (req, res) => {
    res.json({ live: liveMeetings(req.params.g) });
  });

  r.post('/guilds/:g/live/:channelId/stop', async (req, res) => {
    if (!bot || typeof bot.stopMeeting !== 'function') {
      return res.status(400).json({ error: 'Live recording is not managed by this server.' });
    }
    try {
      const result = await bot.stopMeeting(req.params.g, req.params.channelId);
      if (!result.ok) return res.status(404).json(result);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.get('/guilds/:g/stats', (req, res) => {
    res.json({
      stats: db.guildStats(req.params.g),
      leaderboard: db.talkTimeLeaderboard(req.params.g),
      timeline: db.meetingsTimeline(req.params.g, 30),
    });
  });

  r.get('/meetings/:id', (req, res) => {
    const id = Number(req.params.id);
    const meeting = db.getMeeting(id);
    if (!meeting) return res.status(404).json({ error: 'meeting not found' });
    const plan = retryPlan(db, id, { dataDir: env.dataDir });
    let pcmCount = 0;
    try {
      pcmCount = readdirSync(audioDir(id)).filter((f) => f.endsWith('.pcm')).length;
    } catch {}
    const cfg = getGuildConfig(db, meeting.guild_id);
    res.json({
      meeting,
      summary: db.getSummary(id),
      attendees: db.listAttendees(id),
      utterances: db.listUtterances(id),
      hasAudio: pcmCount > 0,
      pcmCount,
      sttPrompt: cfg.sttPrompt || '',
      sttProviders: availableSttProviders(db, env),
      retry: { eligible: RETRYABLE_STATUSES.has(meeting.status) && plan.ok, action: plan.action, reason: plan.reason || null },
      progress: getMeetingProgress(id),
    });
  });

  r.get('/meetings/:id/progress', (req, res) => {
    const id = Number(req.params.id);
    const progress = getMeetingProgress(id);
    res.json({ ok: true, active: !!progress, progress });
  });

  r.get('/meetings/:id/export', async (req, res) => {
    const id = Number(req.params.id);
    const meeting = db.getMeeting(id);
    if (!meeting) return res.status(404).json({ error: 'meeting not found' });
    const summary = db.getSummary(id);
    const attendees = db.listAttendees(id).map((a) => a.display_name);
    const utterances = db.listUtterances(id);
    const date = (meeting.started_at || '').slice(0, 10);
    if (req.query.format === 'md') {
      const { renderNotes } = await import('../delivery/discord-notes.js');
      const lines = [`# ${meeting.channel_name || 'Meeting'} — ${date}`, ''];
      if (attendees.length) lines.push(`**Attendees:** ${attendees.join(', ')}`, '');
      if (summary?.notes) lines.push(renderNotes(summary.notes, summary.talktime || [],
        { channelName: meeting.channel_name, date: meeting.started_at }), '');
      lines.push('## Full transcript', '');
      for (const u of utterances) {
        const t = Math.floor((u.start_ms || 0) / 1000);
        const mm = String(Math.floor(t / 60)).padStart(2, '0');
        const ss = String(t % 60).padStart(2, '0');
        lines.push(`**[${mm}:${ss}] ${u.display_name}:** ${u.text}`);
      }
      const md = lines.join('\n');
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="meeting-${id}-${date}.md"`);
      return res.send(md);
    }
    res.setHeader('Content-Disposition', `attachment; filename="meeting-${id}-${date}.json"`);
    res.json({ meeting, summary, attendees, utterances });
  });

  r.post('/meetings/:id/retry', async (req, res) => {
    const id = Number(req.params.id);
    const meeting = db.getMeeting(id);
    if (!meeting) return res.status(404).json({ error: 'meeting not found' });
    const c = liveClient();
    const deliver = c
      ? async (notes, talktime) => {
          const cfg = getGuildConfig(db, meeting.guild_id);
          const { postNotes } = await import('../delivery/post.js');
          await postNotes({ client: c, meeting, cfg, notes, talktime });
        }
      : null;
    try {
      const result = await retryMeeting(db, id, { dataDir: env.dataDir, deliver });
      if (!result.ok) return res.status(502).json({ error: result.reason || 'Retry failed.', ...result });
      res.json({ ok: true, ...result, meeting: db.getMeeting(id) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/meetings/:id/retranscribe', async (req, res) => {
    const id = Number(req.params.id);
    const meeting = db.getMeeting(id);
    if (!meeting) return res.status(404).json({ error: 'meeting not found' });

    let pcmCount = 0;
    try {
      pcmCount = readdirSync(audioDir(id)).filter((f) => f.endsWith('.pcm')).length;
    } catch {}
    if (pcmCount === 0) {
      return res.status(400).json({ error: 'No audio recordings remain for this meeting.' });
    }

    const { sttProvider, whisperModel, sttModel } = req.body || {};
    const c = liveClient();
    const deliver = c
      ? async (notes, talktime) => {
          const cfg = getGuildConfig(db, meeting.guild_id);
          const { postNotes } = await import('../delivery/post.js');
          await postNotes({ client: c, meeting, cfg, notes, talktime });
        }
      : null;

    try {
      const result = await retranscribeMeeting(db, id, {
        dataDir: env.dataDir,
        deliver,
        sttProvider,
        whisperModel,
        sttModel,
      });
      if (!result.ok) {
        return res.status(502).json({ error: result.reason || 'Retranscription failed.', ...result });
      }
      res.json({
        ok: true,
        ...result,
        meeting: db.getMeeting(id),
        summary: db.getSummary(id),
        utterances: db.listUtterances(id),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Track active and recent comparison benchmark jobs per meeting
  const compareJobs = new Map();

  r.get('/meetings/:id/compare-status', (req, res) => {
    const id = Number(req.params.id);
    const job = compareJobs.get(id);
    const progress = getMeetingProgress(id);
    res.json({
      ok: true,
      active: !!(job?.active),
      progress: progress || null,
      runs: job?.runs || null,
      error: job?.error || null,
    });
  });

  r.post('/meetings/:id/compare-cancel', (req, res) => {
    const id = Number(req.params.id);
    const job = compareJobs.get(id);
    if (job?.active) {
      job.active = false;
      job.abortCtrl?.abort();
      clearMeetingProgress(id);
      console.log(`[compare] Meeting ${id}: Benchmark cancelled explicitly by user.`);
    }
    res.json({ ok: true });
  });

  r.post('/meetings/:id/compare-transcribe', async (req, res) => {
    const id = Number(req.params.id);
    const meeting = db.getMeeting(id);
    if (!meeting) return res.status(404).json({ error: 'meeting not found' });

    // If a benchmark is already actively running for this meeting, attach to it!
    const existingJob = compareJobs.get(id);
    if (existingJob?.active && existingJob.promise) {
      console.log(`[compare] Meeting ${id}: Client attached to ongoing benchmark.`);
      try {
        const resultRuns = await existingJob.promise;
        return res.json({ ok: true, runs: resultRuns });
      } catch (err) {
        return res.status(500).json({ error: err.message || 'Comparison failed' });
      }
    }

    const dir = audioDir(id);
    let files = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.pcm'));
    } catch {}
    if (files.length === 0) {
      return res.status(400).json({ error: 'No audio recordings remain on disk for this meeting.' });
    }

    const requestedModels = Array.isArray(req.body?.models) ? req.body.models : [];
    if (requestedModels.length === 0) {
      return res.status(400).json({ error: 'Please select at least 2 models to compare.' });
    }

    const cfg = getGuildConfig(db, meeting.guild_id);
    const attendees = db.listAttendees(id);
    const nameMap = new Map(attendees.map((a) => [a.user_id, a.display_name]));

    let tracks = files.map((f) => {
      const { userId, startMs } = parsePcmName(f);
      return {
        userId,
        displayName: nameMap.get(userId) || userId,
        startMs,
        pcmPath: join(dir, f),
      };
    });

    // Order by recording timeline
    tracks.sort((a, b) => a.startMs - b.startMs);

    // Limit time window from start of recording if requested
    const durationLimitSec = Number(req.body?.durationLimit || 0);
    if (durationLimitSec > 0 && tracks.length > 0) {
      const originMs = tracks[0].startMs;
      const cutoffMs = originMs + (durationLimitSec * 1000);
      const filtered = tracks.filter((t) => t.startMs <= cutoffMs);
      tracks = filtered.length > 0 ? filtered : tracks.slice(0, 10);
    }

    const isParallel = req.body?.executionMode === 'parallel';
    const chunkConcurrency = isParallel ? 2 : 1;

    const abortCtrl = new AbortController();
    const job = {
      active: true,
      abortCtrl,
      runs: null,
      error: null,
      startedAt: Date.now(),
      promise: null,
    };
    compareJobs.set(id, job);

    res.on('close', () => {
      if (!res.writableEnded) {
        console.log(`[compare] Meeting ${id}: Client socket disconnected; benchmark continuing in background.`);
      }
    });

    async function executeBenchmark() {
      console.log(`[compare] Meeting ${id}: benchmarking ${requestedModels.length} models across ${tracks.length} tracks (mode: ${isParallel ? 'PARALLEL' : 'SEQUENTIAL'}, chunkConcurrency: ${chunkConcurrency})...`);

      const totalSteps = requestedModels.length * tracks.length;
      let completedSteps = 0;
      const compareStartTime = Date.now();

      setMeetingProgress(id, {
        phase: 'comparing',
        currentModel: requestedModels[0]?.label || requestedModels[0]?.model || 'Model 1',
        modelIndex: 1,
        totalModels: requestedModels.length,
        completed: 0,
        total: totalSteps,
        percent: 0,
        startedAt: compareStartTime,
      });

      async function runModel(m, modelIndex = 0) {
        if (abortCtrl.signal.aborted) return null;
        const runCfg = {
          ...cfg,
          sttProvider: m.sttProvider || cfg.sttProvider,
          sttModel: m.model || null,
          whisperModel: m.model || 'small',
          sttPrompt: req.body?.sttPrompt ?? cfg.sttPrompt,
        };
        const modelLabel = m.label || `${runCfg.sttProvider}:${runCfg.sttModel || runCfg.whisperModel}`;
        console.log(`[compare] Starting model: ${modelLabel}...`);

        setMeetingProgress(id, {
          phase: 'comparing',
          currentModel: modelLabel,
          modelIndex: modelIndex + 1,
          totalModels: requestedModels.length,
          completed: completedSteps,
          total: totalSteps,
          percent: totalSteps > 0 ? Math.min(99, Math.round((completedSteps / totalSteps) * 100)) : 0,
          startedAt: compareStartTime,
        });

        try {
          const { utterances, failures } = await transcribeTracks(tracks, runCfg, {
            db,
            env,
            signal: abortCtrl.signal,
            concurrency: chunkConcurrency,
            mergeTracks: async (tr) => tr, // Non-destructive: compare without modifying raw disk audio
            onProgress: ({ completed: modelTrackDone }) => {
              const currentDone = isParallel
                ? completedSteps + 1
                : (modelIndex * tracks.length) + modelTrackDone;
              const pct = totalSteps > 0
                ? Math.min(99, Math.round((currentDone / totalSteps) * 100))
                : 0;
              const elapsed = Math.max(0, Math.round((Date.now() - compareStartTime) / 1000));
              let eta = null;
              if (currentDone > 0 && totalSteps > currentDone) {
                const rate = elapsed / currentDone;
                eta = Math.max(0, Math.round((totalSteps - currentDone) * rate));
              }
              setMeetingProgress(id, {
                phase: 'comparing',
                currentModel: modelLabel,
                modelIndex: modelIndex + 1,
                totalModels: requestedModels.length,
                completed: currentDone,
                total: totalSteps,
                percent: pct,
                elapsedSeconds: elapsed,
                etaSeconds: eta,
                startedAt: compareStartTime,
              });
            },
          });
          completedSteps = isParallel ? completedSteps + tracks.length : (modelIndex + 1) * tracks.length;
          console.log(`[compare] Finished model: ${modelLabel} (${utterances.length} utterances, ${failures.length} errors)`);
          const enrichedUtterances = utterances.map((u) => ({
            ...u,
            audioUrl: `/api/meetings/${id}/audio-clip?userId=${encodeURIComponent(u.userId)}&startMs=${u.startMs}`,
          }));
          return {
            provider: runCfg.sttProvider,
            model: runCfg.sttModel || runCfg.whisperModel,
            label: modelLabel,
            utterances: enrichedUtterances,
            failures,
          };
        } catch (err) {
          if (abortCtrl.signal.aborted) {
            console.log(`[compare] Model ${modelLabel} aborted.`);
            return null;
          }
          console.error(`[compare] Model error for ${modelLabel}:`, err);
          return {
            provider: runCfg.sttProvider,
            model: runCfg.sttModel || runCfg.whisperModel,
            label: modelLabel,
            utterances: [],
            failures: [{ error: err.message || String(err) }],
          };
        }
      }

      let runs = [];
      try {
        if (isParallel) {
          const results = await Promise.all(requestedModels.map((m, idx) => runModel(m, idx)));
          runs = results.filter(Boolean);
        } else {
          for (let i = 0; i < requestedModels.length; i++) {
            if (abortCtrl.signal.aborted) break;
            const result = await runModel(requestedModels[i], i);
            if (result) runs.push(result);
          }
        }
      } finally {
        clearMeetingProgress(id);
      }
      return runs;
    }

    job.promise = executeBenchmark();

    try {
      const runs = await job.promise;
      job.runs = runs;
      job.active = false;
      if (!res.writableEnded) {
        res.json({ ok: true, runs });
      }
    } catch (err) {
      job.error = err.message || String(err);
      job.active = false;
      if (!res.writableEnded) {
        res.status(500).json({ error: job.error });
      }
    }
  });

  // Stream a specific audio track as a standard playable WAV file on the fly
  r.get(['/meetings/:id/audio-clip', '/meetings/:id/audio/:userId/:startMs'], async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid meeting id' });
    const meeting = db.getMeeting(id);
    if (!meeting) return res.status(404).json({ error: 'meeting not found' });

    const userId = String(req.params.userId || req.query.userId || '').replace(/[^a-zA-Z0-9_-]/g, '');
    const startMs = Number(req.params.startMs ?? req.query.startMs);
    if (!userId || !Number.isFinite(startMs) || startMs < 0) {
      return res.status(400).json({ error: 'valid userId and startMs are required' });
    }

    const dir = audioDir(id);
    const pcmPath = join(dir, `${userId}_${startMs}.pcm`);

    let fileStat;
    try {
      fileStat = statSync(pcmPath);
    } catch {
      return res.status(404).json({ error: 'Audio recording file not found' });
    }

    const header = wavHeader(fileStat.size);
    res.writeHead(200, {
      'Content-Type': 'audio/wav',
      'Content-Length': fileStat.size + header.length,
      'Accept-Ranges': 'none',
      'Cache-Control': 'private, max-age=86400',
    });
    res.write(header);
    const stream = createReadStream(pcmPath);
    stream.on('error', (err) => {
      console.error('[audio] Stream error:', err);
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
    stream.pipe(res);
  });

  // List all available audio tracks for a meeting
  r.get('/meetings/:id/audio-tracks', (req, res) => {
    const id = Number(req.params.id);
    const meeting = db.getMeeting(id);
    if (!meeting) return res.status(404).json({ error: 'meeting not found' });

    const dir = audioDir(id);
    let files = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.pcm'));
    } catch {}

    const attendees = db.listAttendees(id);
    const nameMap = new Map(attendees.map((a) => [a.user_id, a.display_name]));

    const tracks = files.map((f) => {
      const { userId, startMs } = parsePcmName(f);
      let size = 0;
      try { size = statSync(join(dir, f)).size; } catch {}
      return {
        userId,
        displayName: nameMap.get(userId) || userId,
        startMs,
        durationMs: pcmDurationMs(size),
        sizeBytes: size,
        audioUrl: `/api/meetings/${id}/audio-clip?userId=${encodeURIComponent(userId)}&startMs=${startMs}`,
      };
    }).sort((a, b) => a.startMs - b.startMs);

    res.json({ ok: true, tracks, count: tracks.length });
  });

  // List all available STT providers with models parsed and capability-filtered
  r.get('/stt-providers', (_req, res) => {
    res.json({ ok: true, providers: availableSttProviders(db, effectiveEnv) });
  });

  r.post('/meetings/:id/apply-transcription', requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const meeting = db.getMeeting(id);
    if (!meeting) return res.status(404).json({ error: 'meeting not found' });
    const utterances = req.body?.utterances;
    if (!Array.isArray(utterances)) return res.status(400).json({ error: 'utterances array required' });

    db.sql.exec('BEGIN');
    try {
      db.sql.prepare(`DELETE FROM utterances WHERE meeting_id = ?`).run(id);
      const insert = db.sql.prepare(
        `INSERT INTO utterances (meeting_id, user_id, display_name, start_ms, end_ms, text)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const u of utterances) {
        insert.run(id, u.userId, u.displayName, u.startMs, u.endMs, u.text);
      }
      db.sql.exec('COMMIT');
    } catch (e) {
      db.sql.exec('ROLLBACK');
      return res.status(500).json({ error: e.message });
    }
    res.json({ ok: true, utterances: db.listUtterances(id) });
  });

  r.post('/meetings/:id/clear-generated', requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const meeting = db.getMeeting(id);
    if (!meeting) return res.status(404).json({ error: 'meeting not found' });

    let pcmCount = 0;
    try {
      pcmCount = readdirSync(audioDir(id)).filter((f) => f.endsWith('.pcm')).length;
    } catch {}
    if (pcmCount === 0) {
      return res.status(400).json({ error: 'Cannot clear generated data because no audio recordings exist for this meeting.' });
    }

    db.clearMeetingGeneratedData(id);
    res.json({
      ok: true,
      meeting: db.getMeeting(id),
      summary: db.getSummary(id),
      utterances: db.listUtterances(id),
    });
  });

  r.delete('/meetings/:id/audio', requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const meeting = db.getMeeting(id);
    if (!meeting) return res.status(404).json({ error: 'meeting not found' });
    const job = comparisonJobs.get(id);
    if (job?.active && job.abortController) {
      job.abortController.abort();
      job.active = false;
    }
    await rm(audioDir(id), { recursive: true, force: true }).catch(() => {});
    res.json({ ok: true });
  });

  r.delete('/meetings/:id', requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const meeting = db.getMeeting(id);
    if (!meeting) return res.status(404).json({ error: 'meeting not found' });
    db.deleteMeeting(id);
    await rm(audioDir(id), { recursive: true, force: true }).catch(() => {});
    res.json({ ok: true });
  });

  r.post('/meetings/:id/merge', requireAdmin, async (req, res) => {
    const targetId = Number(req.params.id);
    const target = db.getMeeting(targetId);
    if (!target) return res.status(404).json({ error: 'meeting not found' });
    const sourceIds = (Array.isArray(req.body?.sourceIds) ? req.body.sourceIds : [])
      .map(Number).filter((s) => s && s !== targetId);
    if (sourceIds.length === 0) return res.status(400).json({ error: 'sourceIds required' });
    for (const sid of sourceIds) {
      const m = db.getMeeting(sid);
      if (!m) return res.status(404).json({ error: `meeting ${sid} not found` });
      if (m.guild_id !== target.guild_id) return res.status(400).json({ error: 'meetings belong to different guilds' });
    }

    const merged = db.mergeMeetings(targetId, sourceIds);

    const utterances = db.listUtterances(targetId).map((u) => ({
      displayName: u.display_name, userId: u.user_id, text: u.text,
      startMs: u.start_ms, endMs: u.end_ms,
    }));
    const cfg = getGuildConfig(db, target.guild_id);
    const transcript = buildTranscript(utterances);
    const talktime = computeTalkTime(utterances);
    const meta = {
      channelName: target.channel_name, date: target.started_at,
      attendees: db.listAttendees(targetId).map((a) => a.display_name),
      summaryLanguage: resolveSummaryLanguage(cfg),
      summaryPrompt: cfg.summaryPrompt,
    };
    try {
      const summarizer = getSummarizer(cfg, db);
      const notes = await summarizer.summarize(transcript, meta);
      db.clearSummary(targetId);
      db.saveSummary(targetId, notes, talktime, summarizer.lastUsed ?? `${cfg.summarizerProvider}:${cfg.summarizerModel || ''}`);
      db.seedTodos(targetId, target.guild_id, notes.actionItems || [], target.started_at);
    } catch (e) {
      return res.status(502).json({ error: e.message, merged });
    }
    for (const sid of merged) await rm(audioDir(sid), { recursive: true, force: true }).catch(() => {});
    res.json({ ok: true, merged });
  });

  r.get('/guilds/:g/todos', (req, res) => {
    const { open, assignee } = req.query;
    const opts = { open: open === '1' };
    if (assignee !== undefined) opts.assignee = assignee === '__unassigned__' ? null : assignee;
    res.json(db.listTodos(req.params.g, opts));
  });

  r.get('/guilds/:g/assignees', (req, res) => {
    res.json(db.listAssignees(req.params.g));
  });

  r.patch('/todos/:id', requireAdmin, (req, res) => {
    db.setTodoDone(Number(req.params.id), !!req.body.done);
    res.json({ ok: true });
  });

  r.get('/guilds/:g/search', (req, res) => {
    const q = (req.query.q || '').trim();
    res.json(q ? db.searchUtterances(req.params.g, q) : []);
  });

  // ── Guild config ───────────────────────────────────────────────────────────
  r.get('/guilds/:g/config', (req, res) => {
    const guild = liveClient()?.guilds?.cache?.get(req.params.g);
    const channels = guild
      ? [...guild.channels.cache.filter((c) => c.type === ChannelType.GuildText).values()]
          .map((c) => ({ id: c.id, name: c.name }))
      : [];
    const provs = availableProviders(db);
    const secrets = {};
    for (const p of provs) {
      secrets[p.provider] = p.ok;
    }
    res.json({
      config: getGuildConfig(db, req.params.g),
defaultSummaryPrompt: SUMMARY_PROMPT,
      providers: provs,
      sttProviders: availableSttProviders(db, env),      channels,
      secrets,
      defaultModels: DEFAULT_MODELS,
      languages: LANGUAGES,
      recordingRetentionOptions: RECORDING_RETENTION_OPTIONS,
      recordingRetentionLabels: RECORDING_RETENTION_LABELS,
    });
  });

  r.patch('/guilds/:g/config', async (req, res) => {
    const result = validateSetup(req.body, db);
    if (!result.ok) return res.status(400).json({ error: result.error });
    const config = setGuildConfig(db, req.params.g, result.patch);
    let sidecarStatus = sidecar ? sidecar.status() : null;
    if (sidecar && sidecar.managed() && result.patch.sttProvider !== undefined) {
      try {
        if (result.patch.sttProvider === 'sidecar') {
          await sidecar.start();
        } else if (!anyGuildUsesSidecar(db)) {
          await sidecar.stop();
        }
        sidecarStatus = sidecar.status();
      } catch { /* surface via status only */ }
    }
    res.json({ ok: true, config, sidecar: sidecarStatus });
  });

  // ── Provider CRUD ─────────────────────────────────────────────────────────
  r.get('/providers', (_req, res) => {
    // Never leak api_key to the client — replace with presence boolean.
    const providers = db.listProviders().map(({ api_key, ...rest }) => ({
      ...rest,
      hasKey: !!api_key,
    }));
    res.json(providers);
  });

  r.post('/providers', requireAdmin, (req, res) => {
    const { id, name, kind, caps, baseUrl, apiKey, models } = req.body || {};
    if (!id || !name) return res.status(400).json({ error: 'id and name are required.' });
    if (!/^[a-z0-9]([a-z0-9_-]*[a-z0-9])?$/.test(id)) {
      return res.status(400).json({ error: 'id must be lowercase alphanumeric with hyphens/underscores.' });
    }
    if (id === 'sidecar' || id === 'none' || id === 'fake') {
      return res.status(400).json({ error: `"${id}" is reserved.` });
    }
    const validKinds = ['gemini', 'openai-compatible', 'ollama'];
    if (kind && !validKinds.includes(kind)) {
      return res.status(400).json({ error: `kind must be one of: ${validKinds.join(', ')}.` });
    }
    const validCaps = ['summarizer', 'stt', 'both'];
    if (caps && !validCaps.includes(caps)) {
      return res.status(400).json({ error: `caps must be one of: ${validCaps.join(', ')}.` });
    }
    const row = db.upsertProvider({
      id,
      name,
      kind: kind || 'openai-compatible',
      caps: caps || 'both',
      baseUrl,
      apiKey,
      models,
    });
    const { api_key, ...safe } = row;
    res.json({ ok: true, provider: { ...safe, hasKey: !!api_key } });
  });

  r.patch('/providers/:id', requireAdmin, (req, res) => {
    const existing = db.getProvider(req.params.id);
    if (!existing) return res.status(404).json({ error: 'provider not found' });
    const { name, kind, caps, baseUrl, apiKey, models } = req.body || {};
    const row = db.upsertProvider({
      id: req.params.id,
      name: name ?? existing.name,
      kind: kind ?? existing.kind,
      caps: caps ?? existing.caps,
      baseUrl: baseUrl !== undefined ? baseUrl : existing.base_url,
      apiKey: apiKey !== undefined ? apiKey : null, // null = keep existing
      models: models !== undefined ? models : existing.models,
    });
    const { api_key, ...safe } = row;
    clearModelCache(req.params.id);
    res.json({ ok: true, provider: { ...safe, hasKey: !!api_key } });
  });

  r.delete('/providers/:id', requireAdmin, (req, res) => {
    const existing = db.getProvider(req.params.id);
    if (!existing) return res.status(404).json({ error: 'provider not found' });
    db.deleteProvider(req.params.id);
    clearModelCache(req.params.id);
    res.json({ ok: true });
  });

  // Test connectivity & detect models from endpoint before saving.
  r.post('/providers/detect-models', requireAdmin, async (req, res) => {
    const { id, kind, baseUrl, apiKey } = req.body || {};
    const existing = id ? db.getProvider(id) : null;
    const existingKey = existing?.api_key || (id ? env[id]?.apiKey : null) || null;
    const keyToUse = (apiKey && apiKey.trim()) ? apiKey.trim() : (existingKey || null);
    const urlToUse = (baseUrl !== undefined && baseUrl !== '')
      ? baseUrl.trim()
      : (existing?.base_url || (id ? (env[id]?.baseUrl || env[id]?.url) : '') || '');
    const kindToUse = kind || existing?.kind || 'openai-compatible';

    const dummy = {
      id: id || 'tmp-detect',
      kind: kindToUse,
      base_url: urlToUse,
      api_key: keyToUse,
    };
    const result = await listModels(dummy, { timeoutMs: 8000, refresh: true });
    res.json({
      ok: result.source === 'live',
      models: result.models.map((m) => m.id),
      error: result.error,
    });
  });

  // Test connectivity: try fetching the provider's model catalog.
  r.post('/providers/:id/test', requireAdmin, async (req, res) => {
    const row = db.getProvider(req.params.id);
    if (!row) return res.status(404).json({ error: 'provider not found' });
    const result = await listModels(row, { timeoutMs: 8000, refresh: true });
    res.json({
      ok: result.source === 'live',
      count: result.models.length,
      models: result.models.map((m) => m.id),
      error: result.error,
    });
  });

  r.put('/providers/:provider/key', requireAdmin, (req, res) => {
    const p = req.params.provider;
    const key = req.body?.key ?? '';
    const existing = db.getProvider(p);
    if (!existing && !['gemini', 'openai', 'opencode', 'openrouter'].includes(p)) {
      return res.status(400).json({ error: 'Unknown provider' });
    }
    db.upsertProvider({
      id: p,
      name: existing?.name || p,
      kind: existing?.kind || (p === 'gemini' ? 'gemini' : 'openai-compatible'),
      caps: existing?.caps || 'both',
      baseUrl: existing?.base_url || null,
      apiKey: key || null,
    });
    res.json({ ok: true });
  });

  // Live model catalog for a provider.
  r.get('/providers/:id/models', async (req, res) => {
    const p = req.params.id;
    const row = db.getProvider(p) || (['gemini', 'openai', 'opencode', 'openrouter', 'ollama'].includes(p)
      ? { id: p, kind: p === 'gemini' ? 'gemini' : p === 'ollama' ? 'ollama' : 'openai-compatible' }
      : null);
    if (!row) return res.status(400).json({ error: 'provider not found' });
    res.json(await listModels(row, { env, refresh: req.query.refresh === '1' }));
  });

  // ── System / connection ─────────────────────────────────────────────────
  r.get('/commands', (_req, res) => {
    res.json({ commands: COMMAND_CATALOG });
  });

  r.get('/system/status', (_req, res) => {
    const c = liveClient();
    res.json({
      connection: connectionStatus(env),
      providers: availableProviders(db),
      sttProviders: availableSttProviders(db, env),
      bot: bot
        ? bot.status()
        : { state: c ? 'ready' : 'stopped', connected: !!c, hasCreds: !!env.discordToken,
            user: c?.user ? { tag: c.user.tag, id: c.user.id } : null, guildCount: c?.guilds?.cache?.size ?? 0 },
      managed: !!bot,
      sttUrl: env.sttUrl,
      sidecar: sidecar ? sidecar.status() : null,
    });
  });

  r.put('/system/connection', requireAdmin, async (req, res) => {
    const patch = {};
    for (const k of ['discordToken', 'discordClientId', 'sttUrl']) {
      if (typeof req.body?.[k] === 'string') patch[k] = req.body[k];
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'No recognized settings to update.' });
    let connection;
    try {
      connection = await setConnection(patch, { env });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    try {
      let botResult = null;
      if (bot && (patch.discordToken !== undefined || patch.discordClientId !== undefined)) {
        botResult = await bot.restart();
      }
      res.json({ ok: true, connection, bot: bot ? bot.status() : null, botResult });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/system/bot/:action', requireAdmin, async (req, res) => {
    if (!bot) return res.status(400).json({ error: 'Bot is not managed by this server.' });
    const { action } = req.params;
    try {
      if (action === 'start') await bot.start();
      else if (action === 'restart') await bot.restart();
      else if (action === 'stop') await bot.stop();
      else return res.status(400).json({ error: `Unknown action "${action}".` });
      res.json({ ok: true, bot: bot.status() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/system/sidecar/:action', requireAdmin, async (req, res) => {
    if (!sidecar) return res.status(400).json({ error: 'Sidecar is not managed by this server.' });
    const { action } = req.params;
    if (!sidecar.managed() && action !== 'status') {
      return res.status(400).json({ error: sidecar.status().error || 'Local sidecar is not manageable here (running in Docker or STT_URL is remote).', sidecar: sidecar.status() });
    }
    try {
      let result = { ok: true };
      if (action === 'start') result = await sidecar.start();
      else if (action === 'restart') result = await sidecar.restart();
      else if (action === 'stop') result = await sidecar.stop();
      else if (action !== 'status') return res.status(400).json({ error: `Unknown action "${action}".` });
      const status = sidecar.status();
      if (!result.ok) return res.status(502).json({ error: result.error || 'Sidecar action failed.', sidecar: status });
      res.json({ ok: true, sidecar: status });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/guilds/:g/meetings/:id/ask', async (req, res) => {
    const id = Number(req.params.id);
    const meeting = db.getMeeting(id);
    if (!meeting) return res.status(404).json({ error: 'meeting not found' });
    const question = (req.body?.question || '').trim();
    if (!question) return res.status(400).json({ error: 'question required' });
    const transcript = db.listUtterances(id).map((u) => `${u.display_name}: ${u.text}`).join('\n');
    try {
      const answer = await askMeeting({
        cfg: getGuildConfig(db, meeting.guild_id), db, question, transcript,
        meta: { channelName: meeting.channel_name, date: meeting.started_at,
          attendees: db.listAttendees(id).map((a) => a.display_name) },
      });
      res.json({ answer });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  return r;
}
