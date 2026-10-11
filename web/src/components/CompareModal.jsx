import { useState, useMemo, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { Icon } from './ui.jsx';

/**
 * Word-level diff comparison between a reference text and a candidate text.
 * Returns an array of tokens with type: 'match' | 'added' | 'removed'
 */
function diffWords(refText = '', candText = '') {
  const refWords = (refText || '').trim().split(/\s+/).filter(Boolean);
  const candWords = (candText || '').trim().split(/\s+/).filter(Boolean);

  // Compute Longest Common Subsequence (LCS) matrix
  const m = refWords.length;
  const n = candWords.length;
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));

  for (let i = 0; i < m; i++) {
    const rw = refWords[i].toLowerCase().replace(/[.,!?;:"]/g, '');
    for (let j = 0; j < n; j++) {
      const cw = candWords[j].toLowerCase().replace(/[.,!?;:"]/g, '');
      if (rw === cw) {
        dp[i + 1][j + 1] = dp[i][j] + 1;
      } else {
        dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  // Backtrack to build diff tokens
  let i = m;
  let j = n;
  const tokens = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const rw = refWords[i - 1].toLowerCase().replace(/[.,!?;:"]/g, '');
      const cw = candWords[j - 1].toLowerCase().replace(/[.,!?;:"]/g, '');
      if (rw === cw) {
        tokens.unshift({ type: 'match', text: candWords[j - 1] });
        i--;
        j--;
        continue;
      }
    }
    if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      tokens.unshift({ type: 'added', text: candWords[j - 1] });
      j--;
    } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
      tokens.unshift({ type: 'removed', text: refWords[i - 1] });
      i--;
    }
  }

  return tokens;
}

function fmtSeconds(sec = 0) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function parseModelList(provider) {
  if (!provider) return [];
  if (Array.isArray(provider.models)) {
    return provider.models
      .map((m) => (typeof m === 'string' ? m : m.id || m.name))
      .filter((m) => typeof m === 'string' && m.trim().length > 1);
  }
  if (typeof provider.models === 'string') {
    try {
      const parsed = JSON.parse(provider.models);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((m) => {
            const caps = Array.isArray(m?.caps) ? m.caps : [];
            return caps.includes('stt') || caps.includes('llm_stt') || caps.length === 0;
          })
          .map((m) => (typeof m === 'string' ? m : m.id || m.name))
          .filter((m) => typeof m === 'string' && m.trim().length > 1);
      }
    } catch {}
    return provider.models
      .split(/[,\n]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 1);
  }
  return [];
}

export function CompareModal({
  meetingId,
  sttProviders = [],
  initialPrompt = '',
  onClose,
  onApplied,
}) {
  // Extract all model options from sttProviders (only usable/configured providers)
  const allModels = useMemo(() => {
    const list = [];
    for (const p of sttProviders) {
      if (p.ok === false) continue;
      const modelNames = parseModelList(p);
      const provId = p.provider || p.id;
      const provLabel = p.label || p.name || provId;

      for (const m of modelNames) {
        list.push({
          sttProvider: provId,
          model: m,
          label: provId === 'sidecar' ? `Local sidecar (${m})` : `${provLabel}: ${m}`,
        });
      }
    }
    return list;
  }, [sttProviders]);

  // Start with no models selected by default
  const [selectedKeys, setSelectedKeys] = useState(() => new Set());

  const DURATION_OPTIONS = [
    { value: 60, label: 'First 1 minute (Fastest ~15s)' },
    { value: 180, label: 'First 3 minutes' },
    { value: 300, label: 'First 5 minutes (Recommended)' },
    { value: 600, label: 'First 10 minutes' },
    { value: 900, label: 'First 15 minutes' },
    { value: 1800, label: 'First 30 minutes' },
    { value: 0, label: 'Entire meeting (All audio chunks)' },
  ];

  const [durationLimit, setDurationLimit] = useState(300);
  const [executionMode, setExecutionMode] = useState('sequential'); // 'sequential' | 'parallel'
  const [prompt, setPrompt] = useState(initialPrompt || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [runs, setRuns] = useState(null);
  const [refIndex, setRefIndex] = useState(0);
  const [applying, setApplying] = useState(false);
  const [serverProgress, setServerProgress] = useState(null);
  const [secondsElapsed, setSecondsElapsed] = useState(0);
  const abortCtrlRef = useRef(null);

  // Live timer and progress polling when busy
  useEffect(() => {
    if (!busy) {
      setServerProgress(null);
      setSecondsElapsed(0);
      return;
    }
    const timer = setInterval(() => {
      setSecondsElapsed((s) => s + 1);
    }, 1000);

    const poll = setInterval(() => {
      api.meetingProgress(meetingId)
        .then((res) => {
          if (res?.active && res?.progress) {
            setServerProgress(res.progress);
          }
        })
        .catch(() => {});
    }, 1200);

    return () => {
      clearInterval(timer);
      clearInterval(poll);
    };
  }, [busy, meetingId]);

  const currentModelCount = selectedKeys.size || 2;
  const estimatedWindowSec = durationLimit > 0 ? durationLimit : 600;
  const expectedSecPerModel = Math.max(15, Math.round(estimatedWindowSec * 0.18));
  const expectedTotalSec = executionMode === 'parallel'
    ? expectedSecPerModel * 1.2
    : expectedSecPerModel * currentModelCount;

  let pct = 0;
  let etaText = 'calculating…';

  if (serverProgress && typeof serverProgress.percent === 'number') {
    pct = Math.min(99, Math.max(0, serverProgress.percent));
    etaText = serverProgress.etaFormatted || 'calculating…';
  } else if (busy) {
    const progressFraction = 1 - Math.exp(-secondsElapsed / Math.max(20, expectedTotalSec * 0.6));
    pct = Math.min(96, Math.max(3, Math.round(progressFraction * 100)));
    if (secondsElapsed > 2 && pct > 0) {
      const remainingSec = Math.max(5, Math.round(((100 - pct) / pct) * secondsElapsed));
      if (remainingSec < 60) etaText = `~${remainingSec}s remaining`;
      else {
        const m = Math.floor(remainingSec / 60);
        const s = remainingSec % 60;
        etaText = s > 0 ? `~${m}m ${s}s remaining` : `~${m}m remaining`;
      }
    }
  }

  async function handleCancel() {
    if (abortCtrlRef.current) {
      abortCtrlRef.current.abort();
      abortCtrlRef.current = null;
    }
    if (meetingId) {
      try {
        await api.compareCancel(meetingId);
      } catch (err) {
        console.error('Failed to cancel compare on server:', err);
      }
    }
    setBusy(false);
    onClose?.();
  }

  function toggleModel(key) {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function handleRunCompare(e) {
    e?.preventDefault();
    if (selectedKeys.size < 2) {
      setError('Please select at least 2 models to compare.');
      return;
    }
    setBusy(true);
    setError(null);

    const controller = new AbortController();
    abortCtrlRef.current = controller;

    const modelsToRun = allModels.filter((m) => selectedKeys.has(`${m.sttProvider}:::${m.model}`));
    try {
      const res = await api.compareTranscribe(meetingId, {
        models: modelsToRun,
        durationLimit: durationLimit || undefined,
        executionMode,
        sttPrompt: prompt.trim() || undefined,
      }, controller.signal);
      if (!res.ok) throw new Error(res.error || 'Comparison failed');
      setRuns(res.runs || []);
      setRefIndex(0);
    } catch (err) {
      if (controller.signal.aborted) {
        return;
      }
      setError(err.message || 'Comparison failed');
    } finally {
      abortCtrlRef.current = null;
      setBusy(false);
    }
  }

  async function handleApply(run) {
    if (!window.confirm(`Apply transcription from "${run.label}" to this meeting? This will update the saved transcript.`)) return;
    setApplying(true);
    try {
      await api.applyTranscription(meetingId, { utterances: run.utterances });
      onApplied?.();
      onClose();
    } catch (err) {
      alert(`Failed to apply transcript: ${err.message}`);
    } finally {
      setApplying(false);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-3 sm:p-6 overflow-y-auto">
      <div className="card w-full max-w-5xl md:max-w-6xl max-h-[92vh] flex flex-col bg-surface border border-border shadow-2xl overflow-hidden rounded-xl animate-fade-in my-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-surface-2/40 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="h-8 w-8 rounded-lg bg-primary/10 text-primary grid place-items-center">
              <Icon.Sparkle width={18} height={18} />
            </div>
            <div>
              <h2 className="text-base font-bold text-ink">Compare STT Transcriptions</h2>
              <p className="text-xs text-muted">Test multi-model accuracy & fantasy terminology side by side</p>
            </div>
          </div>
          <button
            onClick={handleCancel}
            className="text-muted hover:text-ink p-1.5 rounded-md hover:bg-surface-3 transition-colors"
            title="Close"
          >
            <span className="text-lg leading-none font-bold">&times;</span>
          </button>
        </div>

        {/* Configuration or Results */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {!runs ? (
            <form onSubmit={handleRunCompare} className="space-y-5 max-w-2xl mx-auto">
              <div className="space-y-2">
                <label className="block text-xs font-semibold uppercase tracking-wider text-muted">
                  1. Select models to benchmark (minimum 2)
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-56 overflow-y-auto p-2 rounded-lg border border-border bg-surface-2/20">
                  {allModels.length === 0 ? (
                    <div className="col-span-full py-4 text-center text-xs text-muted">
                      No transcription models available. Please verify your STT providers in Setup.
                    </div>
                  ) : (
                    allModels.map((m) => {
                      const key = `${m.sttProvider}:::${m.model}`;
                      const isChecked = selectedKeys.has(key);
                      return (
                        <label
                          key={key}
                          className={`flex items-center gap-2.5 p-2 rounded-md border text-xs cursor-pointer transition-colors ${
                            isChecked
                              ? 'bg-primary/10 border-primary/40 text-ink'
                              : 'border-border/60 hover:bg-surface-3 text-muted hover:text-ink'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => toggleModel(key)}
                            className="pcheck h-4 w-4"
                          />
                          <span className="font-medium truncate">{m.label}</span>
                        </label>
                      );
                    })
                  )}
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-semibold uppercase tracking-wider text-muted">
                  2. Audio time range to compare
                </label>
                <div className="relative">
                  <select
                    value={durationLimit}
                    onChange={(e) => setDurationLimit(Number(e.target.value))}
                    disabled={busy}
                    className="input appearance-none pr-9 cursor-pointer text-xs"
                  >
                    {DURATION_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <Icon.Chevron width={14} height={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rotate-90 text-muted" />
                </div>
                <p className="text-[11px] text-muted">
                  Limits transcription from the start of the meeting so you don't transcribe hours of audio just to compare models.
                </p>
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-semibold uppercase tracking-wider text-muted">
                  3. Execution order
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <label
                    className={`flex items-start gap-2.5 p-2.5 rounded-lg border text-xs cursor-pointer transition-colors ${
                      executionMode === 'sequential'
                        ? 'bg-primary/10 border-primary/40 text-ink'
                        : 'border-border/60 hover:bg-surface-3 text-muted hover:text-ink'
                    }`}
                  >
                    <input
                      type="radio"
                      name="executionMode"
                      value="sequential"
                      checked={executionMode === 'sequential'}
                      onChange={() => setExecutionMode('sequential')}
                      className="mt-0.5"
                    />
                    <div>
                      <span className="font-semibold text-ink block">Sequential (One at a time)</span>
                      <span className="text-[11px] text-muted block mt-0.5">
                        Finishes all audio on one model before loading the next. Recommended for single-GPU setups to prevent VRAM thrashing.
                      </span>
                    </div>
                  </label>

                  <label
                    className={`flex items-start gap-2.5 p-2.5 rounded-lg border text-xs cursor-pointer transition-colors ${
                      executionMode === 'parallel'
                        ? 'bg-primary/10 border-primary/40 text-ink'
                        : 'border-border/60 hover:bg-surface-3 text-muted hover:text-ink'
                    }`}
                  >
                    <input
                      type="radio"
                      name="executionMode"
                      value="parallel"
                      checked={executionMode === 'parallel'}
                      onChange={() => setExecutionMode('parallel')}
                      className="mt-0.5"
                    />
                    <div>
                      <span className="font-semibold text-ink block">Parallel (All at once)</span>
                      <span className="text-[11px] text-muted block mt-0.5">
                        Transcribes through all selected models simultaneously. Faster when models run on separate servers or cloud endpoints.
                      </span>
                    </div>
                  </label>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-semibold uppercase tracking-wider text-muted">
                  4. Glossary / D&D diary conditioning (optional)
                </label>
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="e.g. Neverwinter, Faerun, Tiamat, D&D character names, spells, items..."
                  rows={3}
                  className="input text-xs font-mono"
                />
                <p className="text-[11px] text-muted">
                  Passed as guidance vocabulary to prompt-supported models (Whisper, Voxtral, Gemma).
                </p>
              </div>

              {error && (
                <div className="p-3 bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs rounded-lg">
                  {error}
                </div>
              )}

              {busy && (
                <div className="card p-4 bg-surface-2/70 border border-primary/30 rounded-xl space-y-3 animate-fade-in shadow-inner">
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <div className="flex items-center gap-2 font-medium text-ink min-w-0">
                      <span className="h-3.5 w-3.5 rounded-full border-2 border-primary border-t-transparent animate-spin shrink-0" />
                      <span className="truncate">
                        {serverProgress?.currentModel
                          ? `Model ${serverProgress.modelIndex || 1}/${serverProgress.totalModels || currentModelCount}: ${serverProgress.currentModel}`
                          : `Benchmarking ${currentModelCount} models (${executionMode})…`}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 shrink-0 tabular-nums">
                      <span className="text-[11px] text-muted">Elapsed {fmtSeconds(secondsElapsed)}</span>
                      <span className="font-extrabold text-primary text-sm">{pct}%</span>
                    </div>
                  </div>

                  {/* Animated Progress Bar */}
                  <div className="relative w-full h-2.5 rounded-full bg-surface-3 overflow-hidden border border-border/40">
                    <div
                      className="absolute top-0 bottom-0 left-0 bg-gradient-to-r from-primary via-primary to-accent transition-all duration-500 ease-out rounded-full shadow-[0_0_12px_rgba(var(--primary-rgb),0.55)]"
                      style={{ width: `${Math.max(4, pct)}%` }}
                    />
                  </div>

                  <div className="flex items-center justify-between text-[11px] text-muted pt-0.5">
                    <div className="flex items-center gap-1.5">
                      <Icon.Clock width={12} height={12} className="text-primary/80 shrink-0" />
                      <span>ETA: <strong className="text-ink font-semibold">{etaText}</strong></span>
                    </div>
                    <span className="tabular-nums">
                      {serverProgress?.completed != null && serverProgress?.total != null
                        ? `${serverProgress.completed} / ${serverProgress.total} chunks completed`
                        : `${currentModelCount} models · ${durationLimit ? `${durationLimit / 60}m window` : 'Full audio'}`}
                    </span>
                  </div>
                </div>
              )}

              <div className="flex items-center justify-end gap-3 pt-2">
                <button type="button" onClick={handleCancel} className="btn btn-ghost !py-1.5 text-xs text-muted hover:text-ink">
                  {busy ? 'Interrupt & Cancel' : 'Cancel'}
                </button>
                <button
                  type="submit"
                  disabled={busy || selectedKeys.size < 2}
                  className="btn btn-primary !py-1.5 text-xs inline-flex items-center gap-2"
                >
                  {busy ? (
                    <>
                      <span className="h-3.5 w-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />
                      <span>Transcribing… ({pct}%)</span>
                    </>
                  ) : (
                    <>
                      <Icon.Play width={13} height={13} />
                      <span>
                        Run Comparison ({selectedKeys.size} models · {durationLimit ? `${durationLimit / 60}m` : 'Full'})
                      </span>
                    </>
                  )}
                </button>
              </div>
            </form>
          ) : (
            <div className="space-y-4">
              {/* Reference Selector Bar */}
              <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-lg border border-border bg-surface-2/40">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-muted uppercase">Reference Model:</span>
                  <div className="flex flex-wrap gap-1.5">
                    {runs.map((r, idx) => (
                      <button
                        key={idx}
                        onClick={() => setRefIndex(idx)}
                        className={`text-xs px-2.5 py-1 rounded-md font-medium transition-all ${
                          refIndex === idx
                            ? 'bg-primary text-white shadow-sm'
                            : 'bg-surface-3 text-muted hover:text-ink'
                        }`}
                      >
                        {r.label}
                      </button>
                    ))}
                  </div>
                </div>
                <button
                  onClick={() => setRuns(null)}
                  className="btn btn-ghost !py-1 text-xs text-muted hover:text-ink inline-flex items-center gap-1.5"
                >
                  <Icon.Refresh width={12} height={12} />
                  <span>New comparison</span>
                </button>
              </div>

              {/* Side-by-Side Model Columns */}
              <div className="grid grid-flow-col auto-cols-[minmax(320px,1fr)] gap-4 overflow-x-auto pb-4">
                {runs.map((run, colIdx) => {
                  const isRef = colIdx === refIndex;
                  const refRun = runs[refIndex];
                  const totalWords = run.utterances.reduce(
                    (acc, u) => acc + (u.text ? u.text.trim().split(/\s+/).length : 0),
                    0
                  );

                  return (
                    <div
                      key={colIdx}
                      className={`flex flex-col rounded-xl border bg-surface shadow-sm overflow-hidden ${
                        isRef ? 'border-primary/50 ring-1 ring-primary/20' : 'border-border'
                      }`}
                    >
                      {/* Column Header */}
                      <div className="p-3.5 border-b border-border bg-surface-2/30 flex items-start justify-between gap-2">
                        <div>
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-bold text-ink">{run.label}</span>
                            {isRef && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded font-bold uppercase bg-primary text-white">
                                Baseline
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-muted mt-0.5">
                            {run.utterances.length} utterances · {totalWords} words
                            {run.failures?.length > 0 && ` · ${run.failures.length} errors`}
                          </p>
                        </div>
                        <button
                          onClick={() => handleApply(run)}
                          disabled={applying || run.utterances.length === 0}
                          className="btn btn-ghost !py-1 !px-2 text-[11px] font-medium border border-border hover:bg-surface-3"
                          title="Set this model's transcription as the official meeting transcript"
                        >
                          Apply to meeting
                        </button>
                      </div>

                      {/* Utterance List */}
                      <div className="p-3.5 space-y-3 flex-1 overflow-y-auto max-h-[60vh]">
                        {run.utterances.length === 0 ? (
                          <p className="text-xs text-muted italic text-center py-6">
                            No utterances produced by this model.
                          </p>
                        ) : (
                          run.utterances.map((u, uIdx) => {
                            const refU = refRun.utterances[uIdx];
                            const diffTokens = isRef
                              ? null
                              : diffWords(refU?.text || '', u.text || '');

                            return (
                              <div
                                key={uIdx}
                                className="p-2.5 rounded-lg border border-border/50 bg-surface-2/20 text-xs space-y-1"
                              >
                                <div className="flex items-center justify-between text-[11px] text-muted">
                                  <span className="font-semibold text-ink-2">{u.displayName}</span>
                                  <span className="font-mono tabular-nums">
                                    {Math.floor((u.startMs || 0) / 1000)}s
                                  </span>
                                </div>

                                <div className="leading-relaxed">
                                  {isRef ? (
                                    <span className="text-ink">{u.text}</span>
                                  ) : (
                                    diffTokens.map((tok, tIdx) => {
                                      if (tok.type === 'match') {
                                        return <span key={tIdx}>{tok.text} </span>;
                                      }
                                      if (tok.type === 'added') {
                                        return (
                                          <span
                                            key={tIdx}
                                            className="bg-emerald-500/20 text-emerald-300 font-medium px-1 py-0.5 rounded mr-1"
                                          >
                                            {tok.text}
                                          </span>
                                        );
                                      }
                                      if (tok.type === 'removed') {
                                        return (
                                          <span
                                            key={tIdx}
                                            className="bg-rose-500/20 text-rose-300 line-through px-1 py-0.5 rounded mr-1"
                                          >
                                            {tok.text}
                                          </span>
                                        );
                                      }
                                      return null;
                                    })
                                  )}
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
