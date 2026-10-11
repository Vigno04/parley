import { convertPcmToWav, isVoicedPcm, mergeSpeakerTracks, pcmDurationMs } from '../voice/audio.js';
import { getSTT, resolveSttModel } from '../adapters/stt/index.js';
import { unlink, stat } from 'node:fs/promises';

// Transcribes each track through a small worker pool instead of one at a
// time. Cloud STT tolerates higher concurrency than the local sidecar.
//
// A failed track (bad PCM, STT hiccup, etc.) must not sink the whole
// meeting (audit A2): failures are caught per-track and collected instead
// of thrown, and the good utterances are still returned. Callers decide
// whether "some/all tracks failed" is fatal.
export async function transcribeTracks(rawTracks, cfg = {}, deps = {}) {
  const convert = deps.convert || convertPcmToWav;
  const isVoiced = deps.isVoiced || (deps.convert ? (async () => true) : isVoicedPcm);
  const mergeTracks = deps.mergeTracks || (deps.convert ? (async (tr) => tr) : mergeSpeakerTracks);

  // 1. Merge consecutive tracks from the same speaker (gap <= 2.5s)
  const merged = await mergeTracks(rawTracks, {
    gapThresholdMs: cfg.mergeGapMs ?? 2500,
    maxDurationMs: cfg.maxTrackMs ?? 30000,
  });

  // 2. Filter unvoiced / empty audio segments to eliminate silence hallucinations
  const tracks = [];
  for (const t of merged) {
    if (await isVoiced(t.pcmPath)) {
      tracks.push(t);
    }
  }

  // Resolve the configured STT provider (sidecar | openai | custom DB provider).
  const transcribe = deps.transcribe || (!deps.stt ? getSTT(cfg, deps.db, deps.env, deps.sttDeps) : null);
  const model = resolveSttModel(cfg, cfg?.sttProvider, deps.db);
  const stt = deps.stt || ((wav, runtimeCfg = {}) => transcribe(wav, {
    model,
    language: runtimeCfg.language || cfg.language,
    prompt: runtimeCfg.sttPrompt || cfg.sttPrompt,
    signal: deps.signal,
  }));
  const cleanup = deps.cleanup || (async (p) => { try { await unlink(p); } catch { /* ignore */ } });
  const concurrency = Math.max(1, deps.concurrency ?? (cfg.sttProvider === 'sidecar' ? 2 : 4));

  // Results are written by index so track order is preserved regardless of
  // which worker finishes first.
  const results = new Array(tracks.length);
  const failures = [];
  let completedTracks = 0;
  const startTime = Date.now();

  deps.onProgress?.({
    completed: 0,
    total: tracks.length,
    percent: 0,
    elapsedSeconds: 0,
    etaSeconds: null,
  });

  async function worker(start) {
    for (let i = start; i < tracks.length; i += concurrency) {
      if (deps.signal?.aborted) return;
      const t = tracks[i];
      const wavPath = t.pcmPath.replace(/\.pcm$/, '.wav');
      try {
        await convert(t.pcmPath, wavPath);
        if (deps.signal?.aborted) return;
        const { text, words, duration } = await stt(wavPath, {
          model,
          language: cfg.language,
          prompt: cfg.sttPrompt,
          signal: deps.signal,
          ...cfg,
        });
        const clean = (text || '').trim();
        if (!clean) continue; // silent track — not a failure, just nothing said
        let lastEnd = words && words.length
          ? words[words.length - 1].end
          : (typeof duration === 'number' && duration > 0 ? duration : 0);
        if (!lastEnd) {
          try {
            const { size } = await stat(t.pcmPath);
            lastEnd = pcmDurationMs(size) / 1000;
          } catch { /* ignore */ }
        }
        results[i] = {
          userId: t.userId,
          displayName: t.displayName,
          startMs: t.startMs,
          endMs: t.startMs + Math.round(lastEnd * 1000),
          text: clean,
        };
      } catch (err) {
        failures.push({ userId: t.userId, displayName: t.displayName, error: err.message || String(err) });
      } finally {
        completedTracks++;
        const elapsedSeconds = Math.max(0, Math.round((Date.now() - startTime) / 1000));
        let etaSeconds = null;
        if (completedTracks > 0 && tracks.length > completedTracks) {
          const rate = elapsedSeconds / completedTracks;
          etaSeconds = Math.max(0, Math.round((tracks.length - completedTracks) * rate));
        }
        const percent = tracks.length > 0
          ? Math.min(99, Math.round((completedTracks / tracks.length) * 100))
          : 100;
        deps.onProgress?.({
          completed: completedTracks,
          total: tracks.length,
          percent,
          elapsedSeconds,
          etaSeconds,
        });
        await cleanup(wavPath);
      }
    }
  }

  const workerCount = Math.min(concurrency, tracks.length);
  await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i)));

  deps.onProgress?.({
    completed: tracks.length,
    total: tracks.length,
    percent: 100,
    elapsedSeconds: Math.max(0, Math.round((Date.now() - startTime) / 1000)),
    etaSeconds: 0,
  });

  const utterances = results.filter(Boolean);
  return { utterances, failures };
}
