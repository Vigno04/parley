import { useState, useMemo, useEffect, useRef } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { useGuild } from '../GuildContext.jsx';
import { api } from '../api.js';
import { Icon, Avatar } from '../components/ui.jsx';

/**
 * Word-level diff comparison between a reference text and a candidate text.
 * Returns an array of tokens with type: 'match' | 'added' | 'removed'
 */
function diffWords(refText = '', candText = '') {
  const refWords = (refText || '').trim().split(/\s+/).filter(Boolean);
  const candWords = (candText || '').trim().split(/\s+/).filter(Boolean);

  if (refWords.length === 0 && candWords.length === 0) return [];
  if (refWords.length === 0) {
    return candWords.map((w) => ({ type: 'added', text: w }));
  }
  if (candWords.length === 0) {
    return refWords.map((w) => ({ type: 'removed', text: w }));
  }

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

function fmtMs(ms = 0) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
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

export default function Testing() {
  const [searchParams, setSearchParams] = useSearchParams();
  const meetingIdParam = searchParams.get('meetingId');
  const { guildId } = useGuild();

  const [meetings, setMeetings] = useState([]);
  const [selectedMeetingId, setSelectedMeetingId] = useState(meetingIdParam ? Number(meetingIdParam) : null);
  const [meetingData, setMeetingData] = useState(null);
  const [providers, setProviders] = useState([]);
  const [loadingMeeting, setLoadingMeeting] = useState(false);

  // Benchmarking parameters
  const [selectedKeys, setSelectedKeys] = useState(() => new Set());
  const [durationLimit, setDurationLimit] = useState(300); // 5 min
  const [executionMode, setExecutionMode] = useState('sequential'); // 'sequential' | 'parallel'
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [runs, setRuns] = useState(null);
  const [refIndex, setRefIndex] = useState(0);
  const [applying, setApplying] = useState(false);
  const [showDiffs, setShowDiffs] = useState(true);
  const [tableSearch, setTableSearch] = useState('');
  const [serverProgress, setServerProgress] = useState(null);
  const [secondsElapsed, setSecondsElapsed] = useState(0);
  const abortCtrlRef = useRef(null);

  // Single shared audio player (never loads audio until user clicks Play)
  const audioRef = useRef(null);
  const [activeAudioUrl, setActiveAudioUrl] = useState(null);
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);

  const DURATION_OPTIONS = [
    { value: 60, label: 'First 1 minute (Fastest ~15s)' },
    { value: 180, label: 'First 3 minutes' },
    { value: 300, label: 'First 5 minutes (Recommended)' },
    { value: 600, label: 'First 10 minutes' },
    { value: 900, label: 'First 15 minutes' },
    { value: 1800, label: 'First 30 minutes' },
    { value: 0, label: 'Entire meeting (All audio chunks)' },
  ];

  // Clean up single audio player on unmount
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = '';
      }
    };
  }, []);

  function handleTogglePlay(url) {
    if (!url) return;
    if (!audioRef.current) {
      const a = new Audio();
      a.playbackRate = playbackSpeed;
      a.onended = () => {
        setIsPlayingAudio(false);
        setActiveAudioUrl(null);
      };
      a.onerror = () => {
        setIsPlayingAudio(false);
        setActiveAudioUrl(null);
      };
      a.onpause = () => {
        setIsPlayingAudio(false);
      };
      a.onplay = () => {
        setIsPlayingAudio(true);
      };
      audioRef.current = a;
    }

    if (activeAudioUrl === url && isPlayingAudio) {
      audioRef.current.pause();
      setIsPlayingAudio(false);
    } else {
      audioRef.current.src = url;
      audioRef.current.playbackRate = playbackSpeed;
      audioRef.current.play()
        .then(() => {
          setActiveAudioUrl(url);
          setIsPlayingAudio(true);
        })
        .catch((err) => {
          console.warn('Playback failed:', err);
          setIsPlayingAudio(false);
        });
    }
  }

  function handleToggleSpeed() {
    const next = playbackSpeed === 1 ? 1.25 : playbackSpeed === 1.25 ? 1.5 : playbackSpeed === 1.5 ? 2 : 1;
    setPlaybackSpeed(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  }

  // 1. Load meetings for the current guild
  useEffect(() => {
    if (!guildId) return;
    api.meetings(guildId)
      .then((res) => {
        const list = Array.isArray(res) ? res : res?.meetings || [];
        setMeetings(list);
        if (!selectedMeetingId && list.length > 0) {
          const lastTested = localStorage.getItem('parley_testing_last_meeting_id');
          const lastMeeting = lastTested ? list.find((m) => String(m.id) === String(lastTested)) : null;
          if (lastMeeting) {
            setSelectedMeetingId(lastMeeting.id);
            return;
          }
          const withAudio = list.find((m) => m.hasAudio || m.pcm_count > 0 || m.status === 'done');
          if (withAudio) {
            setSelectedMeetingId(withAudio.id);
          } else {
            setSelectedMeetingId(list[0].id);
          }
        }
      })
      .catch((err) => console.error('Failed to load meetings:', err));
  }, [guildId]);

  // Keep URL searchParams and last selected meeting synced with selectedMeetingId
  useEffect(() => {
    if (selectedMeetingId) {
      setSearchParams({ meetingId: String(selectedMeetingId) }, { replace: true });
      try {
        localStorage.setItem('parley_testing_last_meeting_id', String(selectedMeetingId));
      } catch {}
    }
  }, [selectedMeetingId, setSearchParams]);

  // 2. Load providers via sttProviders endpoint
  useEffect(() => {
    api.sttProviders()
      .then((res) => {
        const list = Array.isArray(res?.providers) ? res.providers : [];
        if (list.length > 0) setProviders(list);
      })
      .catch((err) => console.error('Failed to load sttProviders:', err));
  }, []);

  // 3. Load meeting details, cached benchmark runs, and check active server benchmark status
  useEffect(() => {
    if (!selectedMeetingId) {
      setMeetingData(null);
      setRuns(null);
      setBusy(false);
      setServerProgress(null);
      return;
    }
    setLoadingMeeting(true);
    setError(null);

    // 3a. Restore cached runs and parameters from localStorage if available
    const cacheKey = `parley_testing_runs_${selectedMeetingId}`;
    try {
      const cachedRaw = localStorage.getItem(cacheKey);
      if (cachedRaw) {
        const cached = JSON.parse(cachedRaw);
        if (cached && Array.isArray(cached.runs) && cached.runs.length > 0) {
          setRuns(cached.runs);
          if (typeof cached.refIndex === 'number') setRefIndex(cached.refIndex);
          if (cached.durationLimit !== undefined) setDurationLimit(cached.durationLimit);
          if (cached.executionMode) setExecutionMode(cached.executionMode);
          if (cached.prompt) setPrompt(cached.prompt);
          if (Array.isArray(cached.selectedKeys) && cached.selectedKeys.length > 0) {
            setSelectedKeys(new Set(cached.selectedKeys));
          }
        } else {
          setRuns(null);
        }
      } else {
        setRuns(null);
      }
    } catch (e) {
      console.warn('Failed to parse cached benchmark runs:', e);
      setRuns(null);
    }

    // 3b. Query server for active benchmark status or recent in-memory runs
    api.compareStatus(selectedMeetingId)
      .then((status) => {
        if (status?.active) {
          setBusy(true);
          if (status.progress) {
            setServerProgress(status.progress);
            if (typeof status.progress.elapsedSeconds === 'number') {
              setSecondsElapsed(status.progress.elapsedSeconds);
            }
          }
        } else if (status?.runs && Array.isArray(status.runs) && status.runs.length > 0) {
          setRuns(status.runs);
          setBusy(false);
          try {
            localStorage.setItem(cacheKey, JSON.stringify({
              runs: status.runs,
              refIndex: 0,
              durationLimit,
              executionMode,
              prompt,
              selectedKeys: Array.from(selectedKeys),
            }));
          } catch {}
        }
      })
      .catch((err) => console.warn('Failed to fetch compare status:', err));

    // 3c. Fetch meeting metadata (no giant audio track listing upfront!)
    api.meeting(selectedMeetingId)
      .then((mRes) => {
        setMeetingData(mRes);
        if (mRes?.config?.sttPrompt && !prompt) {
          setPrompt(mRes.config.sttPrompt);
        }
      })
      .catch((err) => {
        setError(err.message || 'Failed to load meeting');
      })
      .finally(() => {
        setLoadingMeeting(false);
      });
  }, [selectedMeetingId]);

  // Extract all model options from providers
  const allModels = useMemo(() => {
    const list = [];
    const source = (meetingData?.sttProviders && meetingData.sttProviders.length > 0)
      ? meetingData.sttProviders
      : providers;

    for (const p of source) {
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
  }, [meetingData?.sttProviders, providers]);

  // Auto-select first two models if none selected
  useEffect(() => {
    if (selectedKeys.size === 0 && allModels.length >= 2) {
      const keys = new Set([
        `${allModels[0].sttProvider}:::${allModels[0].model}`,
        `${allModels[1].sttProvider}:::${allModels[1].model}`,
      ]);
      setSelectedKeys(keys);
    }
  }, [allModels]);

  // Progress polling, live timer & automatic reconnection to background benchmark
  useEffect(() => {
    if (!busy || !selectedMeetingId) {
      return;
    }
    const timer = setInterval(() => {
      setSecondsElapsed((s) => s + 1);
    }, 1000);

    const poll = setInterval(() => {
      api.compareStatus(selectedMeetingId)
        .then((res) => {
          if (!res?.ok) return;

          if (res.active) {
            if (res.progress) {
              setServerProgress(res.progress);
              if (typeof res.progress.elapsedSeconds === 'number') {
                setSecondsElapsed(res.progress.elapsedSeconds);
              }
            }
          } else {
            // Background job finished or was cancelled
            setBusy(false);
            setServerProgress(null);
            if (res.runs && Array.isArray(res.runs) && res.runs.length > 0) {
              setRuns(res.runs);
              setRefIndex(0);
              try {
                localStorage.setItem(`parley_testing_runs_${selectedMeetingId}`, JSON.stringify({
                  runs: res.runs,
                  refIndex: 0,
                  durationLimit,
                  executionMode,
                  prompt,
                  selectedKeys: Array.from(selectedKeys),
                }));
              } catch {}
            } else if (res.error) {
              setError(res.error);
            }
          }
        })
        .catch(() => {});
    }, 1200);

    return () => {
      clearInterval(timer);
      clearInterval(poll);
    };
  }, [busy, selectedMeetingId, durationLimit, executionMode, prompt, selectedKeys]);

  // Keep active view choices synced in localStorage
  useEffect(() => {
    if (!runs || !selectedMeetingId) return;
    try {
      const cacheKey = `parley_testing_runs_${selectedMeetingId}`;
      const existing = localStorage.getItem(cacheKey);
      const parsed = existing ? JSON.parse(existing) : {};
      localStorage.setItem(cacheKey, JSON.stringify({
        ...parsed,
        runs,
        refIndex,
        durationLimit,
        executionMode,
        prompt,
        selectedKeys: Array.from(selectedKeys),
      }));
    } catch {}
  }, [runs, refIndex, selectedMeetingId]);

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
    if (selectedMeetingId) {
      try {
        await api.compareCancel(selectedMeetingId);
      } catch (err) {
        console.error('Failed to cancel benchmark on server:', err);
      }
    }
    setBusy(false);
    setServerProgress(null);
  }

  function handleNewTest() {
    if (audioRef.current) {
      audioRef.current.pause();
    }
    setIsPlayingAudio(false);
    setActiveAudioUrl(null);
    setRuns(null);
    if (selectedMeetingId) {
      try {
        localStorage.removeItem(`parley_testing_runs_${selectedMeetingId}`);
      } catch {}
    }
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
    if (!selectedMeetingId) {
      setError('Please select a meeting to test.');
      return;
    }
    if (selectedKeys.size < 2) {
      setError('Please select at least 2 models to compare.');
      return;
    }
    setBusy(true);
    setError(null);
    setRuns(null);
    setSecondsElapsed(0);
    setServerProgress(null);

    // Clear stale cached runs in localStorage for this new run
    try {
      localStorage.removeItem(`parley_testing_runs_${selectedMeetingId}`);
    } catch {}

    const controller = new AbortController();
    abortCtrlRef.current = controller;

    const modelsToRun = allModels.filter((m) => selectedKeys.has(`${m.sttProvider}:::${m.model}`));
    try {
      const res = await api.compareTranscribe(selectedMeetingId, {
        models: modelsToRun,
        durationLimit: durationLimit || undefined,
        executionMode,
        sttPrompt: prompt.trim() || undefined,
      }, controller.signal);
      if (!res.ok) throw new Error(res.error || 'Comparison failed');
      const finalRuns = res.runs || [];
      setRuns(finalRuns);
      setRefIndex(0);
      try {
        localStorage.setItem(`parley_testing_runs_${selectedMeetingId}`, JSON.stringify({
          runs: finalRuns,
          refIndex: 0,
          durationLimit,
          executionMode,
          prompt,
          selectedKeys: Array.from(selectedKeys),
        }));
      } catch {}
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err.message || 'Comparison failed');
    } finally {
      abortCtrlRef.current = null;
      setBusy(false);
      setServerProgress(null);
    }
  }

  async function handleApply(run) {
    if (!window.confirm(`Apply transcription from "${run.label}" to this meeting? This will update the saved transcript.`)) return;
    setApplying(true);
    try {
      await api.applyTranscription(selectedMeetingId, { utterances: run.utterances });
      alert(`Applied "${run.label}" transcript successfully!`);
    } catch (err) {
      alert(`Failed to apply transcript: ${err.message}`);
    } finally {
      setApplying(false);
    }
  }

  const selectedMeeting = meetings.find((m) => m.id === selectedMeetingId) || meetingData?.meeting;
  const hasAudioOnDisk = !!(meetingData?.hasAudio || selectedMeeting?.hasAudio || (selectedMeeting?.pcm_count && selectedMeeting.pcm_count > 0));

  // Compute unified rows for the side-by-side comparison table
  const tableRows = useMemo(() => {
    if (!runs || runs.length === 0) return [];

    const rowsMap = new Map();

    for (const r of runs) {
      for (const u of r.utterances || []) {
        const key = `${u.userId}:::${u.startMs}`;
        if (!rowsMap.has(key)) {
          rowsMap.set(key, {
            key,
            userId: u.userId,
            displayName: u.displayName || u.userId,
            startMs: u.startMs,
            endMs: u.endMs,
            audioUrl: u.audioUrl || (u.userId && u.startMs != null ? api.audioClipUrl(selectedMeetingId, u.userId, u.startMs) : null),
            modelTexts: {},
          });
        }
      }
    }

    const rows = Array.from(rowsMap.values());
    rows.sort((a, b) => a.startMs - b.startMs);

    for (const row of rows) {
      runs.forEach((r, rIdx) => {
        const match = r.utterances?.find((u) => u.userId === row.userId && u.startMs === row.startMs);
        row.modelTexts[rIdx] = match?.text || '';
      });
    }

    return rows;
  }, [runs, selectedMeetingId]);

  const filteredRows = useMemo(() => {
    if (!tableSearch.trim()) return tableRows;
    const q = tableSearch.toLowerCase().trim();
    return tableRows.filter((row) => {
      if (row.displayName?.toLowerCase().includes(q)) return true;
      for (const text of Object.values(row.modelTexts)) {
        if (text?.toLowerCase().includes(q)) return true;
      }
      return false;
    });
  }, [tableRows, tableSearch]);

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
      {/* Page Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border/80 pb-5">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-xl bg-primary/10 text-primary flex items-center justify-center shadow-inner">
              <Icon.Flask width={20} height={20} />
            </div>
            <div>
              <h1 className="font-display text-xl font-black text-ink tracking-tight">STT Model Testing & Benchmarks</h1>
              <p className="text-xs text-muted">Transcribe meeting audio with multiple models and compare results in a side-by-side table</p>
            </div>
          </div>
        </div>

        {selectedMeetingId && (
          <div className="flex items-center gap-2">
            <Link
              to={`/meetings/${selectedMeetingId}`}
              className="btn btn-ghost !py-1.5 text-xs text-muted hover:text-ink inline-flex items-center gap-1.5 border border-border"
            >
              <Icon.ArrowUpRight width={13} height={13} />
              <span>Open meeting notes</span>
            </Link>
          </div>
        )}
      </div>

      {/* Meeting Picker Bar */}
      <div className="card p-4 bg-surface border border-border flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-xs font-bold uppercase tracking-wider text-muted shrink-0">
            Select Meeting:
          </label>
          <div className="relative min-w-[260px] sm:min-w-[340px]">
            <select
              value={selectedMeetingId || ''}
              onChange={(e) => setSelectedMeetingId(Number(e.target.value))}
              disabled={busy}
              className="input appearance-none pr-9 py-2 text-xs font-medium cursor-pointer w-full"
            >
              {meetings.length === 0 && <option value="">No meetings found</option>}
              {meetings.map((m) => {
                const dateStr = m.started_at ? new Date(m.started_at).toLocaleDateString() : '';
                const title = m.channel_name ? `#${m.channel_name}` : `Meeting #${m.id}`;
                return (
                  <option key={m.id} value={m.id}>
                    {title} {dateStr ? `(${dateStr})` : ''} — {m.hasAudio || m.pcm_count > 0 ? '🎵 Audio on disk' : 'No audio'}
                  </option>
                );
              })}
            </select>
            <Icon.Chevron width={14} height={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rotate-90 text-muted" />
          </div>
        </div>

        {/* Audio Status Chip */}
        <div className="flex items-center gap-3 text-xs">
          {loadingMeeting ? (
            <span className="text-muted flex items-center gap-1.5">
              <span className="h-3 w-3 rounded-full border-2 border-primary border-t-transparent animate-spin" />
              Loading meeting info…
            </span>
          ) : hasAudioOnDisk ? (
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-md bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 font-medium">
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
              <span>Audio recordings available on disk</span>
            </div>
          ) : (
            <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-amber-500/10 border border-amber-500/20 text-amber-400 font-medium">
              <Icon.Alert width={13} height={13} />
              <span>No audio recordings found on disk for this meeting</span>
            </div>
          )}
        </div>
      </div>

      {/* Live Benchmark Running Card (visible whenever busy) */}
      {busy && (
        <div className="card p-5 bg-surface border-2 border-primary/40 rounded-xl space-y-3.5 shadow-lg animate-fade-in">
          <div className="flex items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2.5 font-medium text-ink min-w-0">
              <span className="h-4 w-4 rounded-full border-2 border-primary border-t-transparent animate-spin shrink-0" />
              <span className="truncate font-semibold text-sm">
                {serverProgress?.currentModel
                  ? `Transcribing on ${serverProgress.currentModel} (Model ${serverProgress.modelIndex || 1}/${serverProgress.totalModels || currentModelCount})`
                  : `Running STT Benchmark (${currentModelCount} models)…`}
              </span>
            </div>
            <div className="flex items-center gap-3 shrink-0 tabular-nums">
              <span className="text-xs text-muted">Elapsed {fmtSeconds(secondsElapsed)}</span>
              <span className="font-extrabold text-primary text-lg">{pct}%</span>
            </div>
          </div>

          {/* Progress bar */}
          <div className="relative w-full h-3.5 rounded-full bg-surface-3 overflow-hidden border border-border/50">
            <div
              className="absolute top-0 bottom-0 left-0 bg-gradient-to-r from-primary via-primary to-accent transition-all duration-500 ease-out rounded-full shadow-[0_0_12px_rgba(var(--primary-rgb),0.55)]"
              style={{ width: `${Math.max(4, pct)}%` }}
            />
          </div>

          <div className="flex items-center justify-between text-xs text-muted pt-0.5">
            <div className="flex items-center gap-1.5">
              <Icon.Clock width={14} height={14} className="text-primary shrink-0" />
              <span>Estimated remaining: <strong className="text-ink font-semibold">{etaText}</strong></span>
            </div>
            <div className="flex items-center gap-4">
              <span className="tabular-nums font-mono text-xs">
                {serverProgress?.completed != null && serverProgress?.total != null
                  ? `${serverProgress.completed} / ${serverProgress.total} chunks`
                  : `${currentModelCount} models`}
              </span>
              <button
                type="button"
                onClick={handleCancel}
                className="btn btn-ghost !py-1 !px-2.5 text-xs text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 border border-rose-500/20"
              >
                Cancel Benchmark
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Configuration Card (when not viewing runs) */}
      {!runs && (
        <form onSubmit={handleRunCompare} className="card p-6 bg-surface border border-border shadow-sm space-y-6">
          <div className="border-b border-border/60 pb-3">
            <h2 className="text-sm font-bold text-ink">Benchmark Configuration</h2>
            <p className="text-xs text-muted">Choose at least 2 transcription models to test against this meeting's audio recordings</p>
          </div>

          {/* Model Selector */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-bold uppercase tracking-wider text-ink-2">
                1. Select AI Models to Compare (Minimum 2)
              </label>
              <span className="text-[11px] text-muted font-medium">
                {selectedKeys.size} model{selectedKeys.size === 1 ? '' : 's'} selected
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 p-3 rounded-xl border border-border bg-surface-2/30 max-h-64 overflow-y-auto">
              {allModels.length === 0 ? (
                <div className="col-span-full py-6 text-center text-xs text-muted">
                  No transcription models available. Please verify your STT providers in Setup or Server Settings.
                </div>
              ) : (
                allModels.map((m) => {
                  const key = `${m.sttProvider}:::${m.model}`;
                  const isChecked = selectedKeys.has(key);
                  return (
                    <label
                      key={key}
                      className={`flex items-center gap-2.5 p-2.5 rounded-lg border text-xs cursor-pointer transition-all ${
                        isChecked
                          ? 'bg-primary/10 border-primary/50 text-ink shadow-sm'
                          : 'border-border/60 hover:bg-surface-3 text-muted hover:text-ink'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleModel(key)}
                        disabled={busy}
                        className="pcheck h-4 w-4 shrink-0"
                      />
                      <div className="min-w-0">
                        <span className="font-semibold block truncate">{m.label}</span>
                        <span className="text-[10px] text-muted block capitalize">{m.sttProvider}</span>
                      </div>
                    </label>
                  );
                })
              )}
            </div>
          </div>

          {/* Time range & execution mode */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {/* Range */}
            <div className="space-y-1.5">
              <label className="block text-xs font-bold uppercase tracking-wider text-ink-2">
                2. Audio Time Range Window
              </label>
              <div className="relative">
                <select
                  value={durationLimit}
                  onChange={(e) => setDurationLimit(Number(e.target.value))}
                  disabled={busy}
                  className="input appearance-none pr-9 py-2 text-xs cursor-pointer w-full"
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
                Transcribes audio from the start of the meeting. Limiting duration keeps benchmarks fast and responsive.
              </p>
            </div>

            {/* Execution mode */}
            <div className="space-y-1.5">
              <label className="block text-xs font-bold uppercase tracking-wider text-ink-2">
                3. Execution Strategy
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label
                  className={`flex items-start gap-2 p-2 rounded-lg border text-xs cursor-pointer transition-colors ${
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
                    disabled={busy}
                    className="mt-0.5"
                  />
                  <div>
                    <span className="font-semibold block">Sequential</span>
                    <span className="text-[10px] text-muted block">One model at a time (GPU safe)</span>
                  </div>
                </label>

                <label
                  className={`flex items-start gap-2 p-2 rounded-lg border text-xs cursor-pointer transition-colors ${
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
                    disabled={busy}
                    className="mt-0.5"
                  />
                  <div>
                    <span className="font-semibold block">Parallel</span>
                    <span className="text-[10px] text-muted block">Simultaneous execution</span>
                  </div>
                </label>
              </div>
            </div>
          </div>

          {/* Prompt glossary */}
          <div className="space-y-1.5">
            <label className="block text-xs font-bold uppercase tracking-wider text-ink-2">
              4. Glossary / Vocabulary Conditioning (Optional)
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g. Neverwinter, Faerun, Tiamat, D&D character names, spells, items, specialized acronyms..."
              rows={2}
              disabled={busy}
              className="input text-xs font-mono w-full"
            />
            <p className="text-[11px] text-muted">
              Vocabulary guidance injected into models that support prompt conditioning (Whisper, LLM STT, Voxtral).
            </p>
          </div>

          {/* Error notice */}
          {error && (
            <div className="p-3 bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs rounded-xl flex items-center gap-2">
              <Icon.Alert width={16} height={16} className="shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end pt-2 gap-3">
            {busy && (
              <button
                type="button"
                onClick={handleCancel}
                className="btn btn-ghost !py-2 text-xs text-rose-400 hover:text-rose-300 hover:bg-rose-500/10"
              >
                Cancel Benchmark
              </button>
            )}
            <button
              type="submit"
              disabled={busy || selectedKeys.size < 2 || !hasAudioOnDisk}
              className="btn btn-primary !py-2 !px-5 text-xs inline-flex items-center gap-2 font-semibold shadow-md"
            >
              {busy ? (
                <>
                  <span className="h-3.5 w-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />
                  <span>Running Comparison ({pct}%)…</span>
                </>
              ) : (
                <>
                  <Icon.Play width={13} height={13} />
                  <span>Run Model Comparison</span>
                </>
              )}
            </button>
          </div>
        </form>
      )}

      {/* Comparison Results & Side-by-Side Table */}
      {runs && (
        <div className="space-y-6 animate-fade-in">
          {/* Models Overview Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {runs.map((run, idx) => {
              const isRef = idx === refIndex;
              const totalWords = run.utterances.reduce(
                (acc, u) => acc + (u.text ? u.text.trim().split(/\s+/).length : 0),
                0
              );
              return (
                <div
                  key={idx}
                  className={`card p-4 bg-surface rounded-xl border transition-all ${
                    isRef ? 'border-primary shadow-sm ring-1 ring-primary/30' : 'border-border'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-xs font-bold text-ink truncate">{run.label}</span>
                    {isRef && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded font-bold uppercase bg-primary text-white shrink-0">
                        Baseline
                      </span>
                    )}
                  </div>
                  <div className="mt-2.5 space-y-1 text-xs">
                    <div className="flex items-center justify-between text-muted">
                      <span>Transcribed Clips:</span>
                      <strong className="text-ink font-semibold tabular-nums">{run.utterances.length}</strong>
                    </div>
                    <div className="flex items-center justify-between text-muted">
                      <span>Total Words:</span>
                      <strong className="text-ink font-semibold tabular-nums">{totalWords}</strong>
                    </div>
                    {run.failures?.length > 0 && (
                      <div className="flex items-center justify-between text-rose-400">
                        <span>Errors:</span>
                        <strong className="font-semibold tabular-nums">{run.failures.length}</strong>
                      </div>
                    )}
                  </div>
                  <div className="mt-3 pt-2.5 border-t border-border/60">
                    <button
                      type="button"
                      onClick={() => handleApply(run)}
                      disabled={applying || run.utterances.length === 0}
                      className="btn btn-ghost w-full !py-1 text-[11px] font-semibold border border-border hover:bg-surface-3"
                    >
                      Apply to meeting
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Table Container */}
          <div className="card overflow-hidden bg-surface border border-border shadow-sm">
            {/* Table Toolbar Controls */}
            <div className="p-4 border-b border-border/80 flex flex-wrap items-center justify-between gap-4 bg-surface-2/30">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-xs font-bold uppercase tracking-wider text-muted shrink-0">
                  Baseline (Reference):
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {runs.map((r, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => setRefIndex(idx)}
                      className={`text-xs px-2.5 py-1 rounded-lg font-semibold transition-all ${
                        refIndex === idx
                          ? 'bg-primary text-white shadow-sm'
                          : 'bg-surface text-muted hover:text-ink hover:bg-surface-3 border border-border/60'
                      }`}
                    >
                      {refIndex === idx ? '★ ' : ''}{r.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-xs text-ink cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={showDiffs}
                    onChange={(e) => setShowDiffs(e.target.checked)}
                    className="pcheck h-4 w-4"
                  />
                  <span className="font-medium">Highlight Word Differences</span>
                </label>

                <button
                  type="button"
                  onClick={handleToggleSpeed}
                  className="btn btn-ghost !py-1 text-xs border border-border tabular-nums"
                  title="Audio playback speed"
                >
                  Speed: {playbackSpeed}x
                </button>

                <input
                  type="text"
                  value={tableSearch}
                  onChange={(e) => setTableSearch(e.target.value)}
                  placeholder="Filter table text…"
                  className="input text-xs !py-1 !px-2.5 w-44"
                />

                <button
                  type="button"
                  onClick={handleNewTest}
                  className="btn btn-ghost !py-1 text-xs text-muted hover:text-ink border border-border inline-flex items-center gap-1.5"
                >
                  <Icon.Refresh width={12} height={12} />
                  <span>New test</span>
                </button>
              </div>
            </div>

            {/* The Unified Comparison Table */}
            <div className="overflow-x-auto max-h-[75vh]">
              <table className="w-full border-collapse text-left text-xs">
                <thead className="bg-surface-2/90 sticky top-0 z-10 backdrop-blur-sm border-b border-border shadow-sm">
                  <tr>
                    <th className="py-3 px-3 w-12 text-muted font-bold text-center border-r border-border/40">#</th>
                    <th className="py-3 px-4 min-w-[200px] font-bold text-ink border-r border-border/60">
                      Audio Clip & Speaker
                    </th>
                    {runs.map((r, rIdx) => {
                      const isRef = rIdx === refIndex;
                      const totalWords = r.utterances.reduce(
                        (acc, u) => acc + (u.text ? u.text.trim().split(/\s+/).length : 0),
                        0
                      );
                      return (
                        <th
                          key={rIdx}
                          className={`py-3 px-4 min-w-[280px] font-bold border-r border-border/60 last:border-r-0 ${
                            isRef ? 'bg-primary/5 text-primary' : 'text-ink'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="truncate">{r.label}</span>
                                {isRef && (
                                  <span className="text-[9px] uppercase px-1.5 py-0.5 rounded font-black bg-primary text-white">
                                    Baseline
                                  </span>
                                )}
                              </div>
                              <div className="text-[10px] text-muted font-normal mt-0.5">
                                {r.utterances.length} clips · {totalWords} words
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => handleApply(r)}
                              disabled={applying || r.utterances.length === 0}
                              className="btn btn-ghost !py-1 !px-2 text-[10px] font-semibold border border-border hover:bg-surface-3 shrink-0"
                              title="Apply this model's transcript to the meeting"
                            >
                              Apply
                            </button>
                          </div>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {filteredRows.length === 0 ? (
                    <tr>
                      <td colSpan={2 + runs.length} className="py-12 text-center text-xs text-muted italic">
                        {tableSearch ? 'No audio utterances matched your search query.' : 'No transcribed utterances in this range.'}
                      </td>
                    </tr>
                  ) : (
                    filteredRows.map((row, rowIdx) => {
                      const isRowPlaying = isPlayingAudio && activeAudioUrl === row.audioUrl;
                      return (
                        <tr
                          key={row.key}
                          className={`hover:bg-surface-2/40 transition-colors ${
                            isRowPlaying ? 'bg-primary/5' : rowIdx % 2 === 1 ? 'bg-surface-2/15' : ''
                          }`}
                        >
                          {/* # */}
                          <td className="py-3 px-3 text-center text-muted font-mono tabular-nums border-r border-border/40">
                            {rowIdx + 1}
                          </td>

                          {/* Audio Clip & Speaker */}
                          <td className="py-3 px-4 border-r border-border/60 align-top">
                            <div className="flex items-start gap-2.5">
                              <button
                                type="button"
                                onClick={() => handleTogglePlay(row.audioUrl)}
                                disabled={!row.audioUrl}
                                className={`h-7 w-7 rounded-full flex items-center justify-center shrink-0 mt-0.5 transition-all ${
                                  isRowPlaying
                                    ? 'bg-primary text-white shadow-md shadow-primary/40 scale-105'
                                    : 'bg-surface-3 hover:bg-primary/20 hover:text-primary text-ink border border-border'
                                }`}
                                title={isRowPlaying ? 'Pause clip' : 'Play audio clip'}
                              >
                                {isRowPlaying ? (
                                  <Icon.Pause width={12} height={12} />
                                ) : (
                                  <Icon.Play width={12} height={12} className="ml-0.5" />
                                )}
                              </button>
                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <Avatar name={row.displayName} size={18} />
                                  <span className="font-semibold text-ink truncate text-xs">{row.displayName}</span>
                                </div>
                                <div className="text-[10px] text-muted font-mono tabular-nums mt-0.5">
                                  {fmtMs(row.startMs)}
                                </div>
                              </div>
                            </div>
                          </td>

                          {/* Model Transcriptions */}
                          {runs.map((r, rIdx) => {
                            const isRef = rIdx === refIndex;
                            const text = row.modelTexts[rIdx] || '';
                            const refText = row.modelTexts[refIndex] || '';

                            let diffTokens = null;
                            if (showDiffs && !isRef && text && refText) {
                              diffTokens = diffWords(refText, text);
                            }

                            return (
                              <td
                                key={rIdx}
                                className={`py-3 px-4 border-r border-border/60 last:border-r-0 align-top leading-relaxed text-xs ${
                                  isRef ? 'bg-primary/[0.02]' : ''
                                }`}
                              >
                                {!text ? (
                                  <span className="text-muted/70 italic text-[11px]">— No speech transcribed</span>
                                ) : diffTokens ? (
                                  <div>
                                    {diffTokens.map((tok, tIdx) => {
                                      if (tok.type === 'match') {
                                        return <span key={tIdx}>{tok.text} </span>;
                                      }
                                      if (tok.type === 'added') {
                                        return (
                                          <mark
                                            key={tIdx}
                                            className="bg-emerald-500/20 text-emerald-300 font-semibold px-1 py-0.5 rounded mx-0.5 border border-emerald-500/30"
                                            title="Added / differing word vs baseline"
                                          >
                                            {tok.text}
                                          </mark>
                                        );
                                      }
                                      if (tok.type === 'removed') {
                                        return (
                                          <del
                                            key={tIdx}
                                            className="line-through text-rose-400/80 bg-rose-500/10 px-1 py-0.5 rounded mx-0.5 border border-rose-500/20"
                                            title="Missing in this model vs baseline"
                                          >
                                            {tok.text}
                                          </del>
                                        );
                                      }
                                      return null;
                                    })}
                                  </div>
                                ) : (
                                  <span className="text-ink">{text}</span>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
