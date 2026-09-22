import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useGuild } from '../GuildContext.jsx';
import { useSystem } from '../SystemContext.jsx';
import { Page, PageHead } from '../components/Page.jsx';
import { Icon, Empty } from '../components/ui.jsx';
import { ModelPicker } from '../components/ModelPicker.jsx';
import { ConnectionForm, BotStatusBadge } from '../components/Connection.jsx';

const WHISPER = ['tiny', 'base', 'small', 'medium', 'large-v3', 'large-v3-turbo'];
const LANGS = [['auto', 'Auto-detect'], ['en', 'English'], ['de', 'German'], ['es', 'Spanish'], ['fr', 'French'],
  ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'], ['ru', 'Russian'], ['ja', 'Japanese'], ['zh', 'Chinese']];
const SUMMARY_LANGS = [['match', 'Match transcription'], ...LANGS.filter(([c]) => c !== 'auto')];

const PROVIDER_KINDS = [
  { id: 'openai-compatible', label: 'OpenAI-compatible', defaultUrl: 'https://api.openai.com/v1', hint: 'Groq, DeepSeek, Together, OpenRouter, vLLM, OpenAI, etc.' },
  { id: 'gemini', label: 'Google Gemini', defaultUrl: '', hint: 'Uses Google AI Studio SDK' },
  { id: 'ollama', label: 'Ollama', defaultUrl: 'http://localhost:11434', hint: 'Local or network Ollama instance' },
];

const CAP_OPTIONS = [
  { id: 'both', label: 'Summarizer & Transcription (STT)' },
  { id: 'summarizer', label: 'Summarizer only' },
  { id: 'stt', label: 'Transcription (STT) only' },
];

function useCatalog(provider) {
  const [state, setState] = useState({ catalog: null, loading: !!provider });
  const seq = useRef(0);
  const load = useCallback((refresh) => {
    const mine = ++seq.current;
    if (!provider) { setState({ catalog: null, loading: false }); return; }
    setState((s) => ({ ...s, loading: true }));
    api.providerModels(provider, refresh)
      .then((catalog) => { if (seq.current === mine) setState({ catalog, loading: false }); })
      .catch(() => { if (seq.current === mine) setState({ catalog: null, loading: false }); });
  }, [provider]);
  useEffect(() => { load(false); }, [load]);
  return { catalog: state.catalog, loading: state.loading, reload: () => load(true) };
}

function Field({ label, hint, children }) {
  return (
    <div>
      <label className="block text-[13px] font-medium text-ink mb-1.5">{label}</label>
      {children}
      {hint && <p className="text-xs text-muted mt-1.5">{hint}</p>}
    </div>
  );
}

function Card({ title, desc, extra, children }) {
  return (
    <section className="card p-5">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <h2 className="text-sm font-bold text-ink">{title}</h2>
          {desc && <p className="text-xs text-muted mt-0.5">{desc}</p>}
        </div>
        {extra && <div>{extra}</div>}
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function Switch({ checked, onChange, label, desc }) {
  return (
    <label className="flex items-start justify-between gap-4 cursor-pointer select-none">
      <span>
        <span className="block text-[13px] font-medium text-ink">{label}</span>
        {desc && <span className="block text-xs text-muted mt-0.5">{desc}</span>}
      </span>
      <span className="relative shrink-0 mt-0.5">
        <input type="checkbox" checked={checked} onChange={onChange} className="peer sr-only" />
        <span className="block h-6 w-10 rounded-full bg-surface-3 peer-checked:bg-primary transition-colors" />
        <span className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform peer-checked:translate-x-4" />
      </span>
    </label>
  );
}

function Chevron() {
  return <Icon.Chevron width={14} height={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rotate-90 text-muted" />;
}

/* ── Provider Form (Create / Edit) ────────────────────────────────────────── */
function ProviderForm({ initial = null, onSave, onCancel, isNew = false }) {
  const [kind, setKind] = useState(initial?.kind || 'openai-compatible');
  const [id, setId] = useState(initial?.id || '');
  const [name, setName] = useState(initial?.name || '');
  const [baseUrl, setBaseUrl] = useState(initial?.base_url || initial?.baseUrl || '');
  const [apiKey, setApiKey] = useState('');
  const [caps, setCaps] = useState(initial?.caps || 'both');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const selectedKind = PROVIDER_KINDS.find((k) => k.id === kind) || PROVIDER_KINDS[0];

  function handleKindChange(newKind) {
    setKind(newKind);
    const kDef = PROVIDER_KINDS.find((k) => k.id === newKind);
    if (!baseUrl || PROVIDER_KINDS.some((p) => p.defaultUrl === baseUrl)) {
      setBaseUrl(kDef?.defaultUrl || '');
    }
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const payload = {
        name: name.trim(),
        kind,
        caps,
        baseUrl: baseUrl.trim() || null,
        apiKey: apiKey.trim() || undefined,
      };
      if (isNew) {
        payload.id = id.trim().toLowerCase();
        if (!payload.id) throw new Error('Provider ID is required');
        await api.createProvider(payload);
      } else {
        await api.updateProvider(initial.id, payload);
      }
      onSave?.();
    } catch (error) {
      setErr(error.message || 'Failed to save provider');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-lg border border-border bg-surface-1 p-4 space-y-3.5">
      <div className="flex items-center justify-between pb-2 border-b border-border">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted">
          {isNew ? 'Add AI Provider' : `Edit Provider: ${initial.name}`}
        </span>
        <button type="button" onClick={onCancel} className="text-xs text-muted hover:text-ink">Cancel</button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Standard / Type" hint={selectedKind.hint}>
          <div className="relative">
            <select
              value={kind}
              onChange={(e) => handleKindChange(e.target.value)}
              className="input appearance-none pr-9 cursor-pointer"
            >
              {PROVIDER_KINDS.map((k) => (
                <option key={k.id} value={k.id}>{k.label}</option>
              ))}
            </select>
            <Chevron />
          </div>
        </Field>

        <Field label="Capabilities">
          <div className="relative">
            <select
              value={caps}
              onChange={(e) => setCaps(e.target.value)}
              className="input appearance-none pr-9 cursor-pointer"
            >
              {CAP_OPTIONS.map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </select>
            <Chevron />
          </div>
        </Field>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Identifier (slug)" hint={isNew ? 'Unique key used by /setup, e.g. "groq" or "openrouter"' : 'Cannot be changed'}>
          <input
            type="text"
            disabled={!isNew}
            value={id}
            onChange={(e) => setId(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))}
            placeholder="groq"
            required
            className="input disabled:opacity-60 disabled:cursor-not-allowed"
          />
        </Field>

        <Field label="Display Name">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Groq Cloud"
            required
            className="input"
          />
        </Field>
      </div>

      <Field label="Base URL" hint={kind === 'gemini' ? 'Optional for Gemini (defaults to Google AI endpoint)' : selectedKind.defaultUrl ? `e.g. ${selectedKind.defaultUrl}` : undefined}>
        <input
          type="text"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={selectedKind.defaultUrl || 'https://api.example.com/v1'}
          className="input"
        />
      </Field>

      <Field
        label="API Key"
        hint={
          !isNew && initial?.hasKey
            ? 'Key already configured. Enter a new key only to replace it.'
            : kind === 'ollama' ? 'Optional for local Ollama' : 'Stored securely in database, never sent to clients'
        }
      >
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={!isNew && initial?.hasKey ? '••••••••  (leave empty to keep current)' : 'Paste API key…'}
          className="input"
        />
      </Field>

      {err && <p className="text-xs text-error">{err}</p>}

      <div className="flex items-center justify-end gap-2 pt-2">
        <button type="button" onClick={onCancel} disabled={busy} className="btn btn-ghost !py-1.5">Cancel</button>
        <button type="submit" disabled={busy} className="btn btn-primary !py-1.5">
          {busy ? 'Saving…' : (isNew ? 'Create Provider' : 'Save Changes')}
        </button>
      </div>
    </form>
  );
}

/* ── Providers Card (System-wide AI Provider Registry) ───────────────────── */
function ProvidersCard({ providers, onReload, onSelected }) {
  const [editingId, setEditingId] = useState(null);
  const [adding, setAdding] = useState(false);
  const [testingId, setTestingId] = useState(null);
  const [testResult, setTestResult] = useState({});
  const [err, setErr] = useState(null);

  async function handleTest(id) {
    setTestingId(id);
    setTestResult((prev) => ({ ...prev, [id]: null }));
    try {
      const res = await api.testProvider(id);
      setTestResult((prev) => ({
        ...prev,
        [id]: res.ok
          ? { ok: true, msg: `Connected (${res.models} models)` }
          : { ok: false, msg: res.error || 'Connection failed' }
      }));
    } catch (e) {
      setTestResult((prev) => ({ ...prev, [id]: { ok: false, msg: e.message } }));
    } finally {
      setTestingId(null);
    }
  }

  async function handleDelete(id, name) {
    if (!window.confirm(`Delete AI provider "${name || id}"? Guilds using this provider will need to be reconfigured.`)) return;
    try {
      await api.deleteProvider(id);
      await onReload?.();
    } catch (e) {
      setErr(e.message || 'Failed to delete provider');
    }
  }

  return (
    <Card
      title="AI Providers"
      desc="Custom AI providers configured in SQLite. Used for summarization and cloud transcription."
      extra={
        !adding && (
          <button
            onClick={() => { setAdding(true); setEditingId(null); }}
            className="btn btn-primary !py-1.5 inline-flex items-center gap-1.5 text-xs"
          >
            <Icon.Plus width={14} height={14} /> Add provider
          </button>
        )
      }
    >
      {err && <p className="text-xs text-error mb-2">{err}</p>}

      {adding && (
        <ProviderForm
          isNew
          onSave={() => { setAdding(false); onReload?.(); }}
          onCancel={() => setAdding(false)}
        />
      )}

      {providers.length === 0 && !adding ? (
        <div className="rounded-lg border border-dashed border-border p-6 text-center">
          <p className="text-xs text-muted mb-3">No custom providers configured yet. Add your OpenAI, Groq, Gemini, or Ollama credentials to get started.</p>
          <button
            onClick={() => setAdding(true)}
            className="btn btn-primary !py-1.5 inline-flex items-center gap-1.5 text-xs"
          >
            <Icon.Plus width={14} height={14} /> Add your first provider
          </button>
        </div>
      ) : (
        <div className="space-y-2.5">
          {providers.map((p) => {
            if (editingId === p.id) {
              return (
                <ProviderForm
                  key={p.id}
                  initial={p}
                  onSave={() => { setEditingId(null); onReload?.(); }}
                  onCancel={() => setEditingId(null)}
                />
              );
            }

            const isTesting = testingId === p.id;
            const res = testResult[p.id];

            return (
              <div
                key={p.id}
                className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 rounded-lg border border-border bg-surface-2"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[13px] font-semibold text-ink">{p.name || p.id}</span>
                    <code className="text-xs text-muted bg-surface-3 px-1.5 py-0.5 rounded">{p.id}</code>
                    <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-surface-3 text-muted">
                      {p.kind}
                    </span>
                    <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-surface-3 text-muted">
                      {p.caps === 'both' ? 'Summarizer & STT' : p.caps === 'stt' ? 'STT only' : 'Summarizer only'}
                    </span>
                    <span
                      className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full ${
                        p.hasKey ? 'text-accent bg-accent-soft' : 'text-warn bg-warn-soft'
                      }`}
                    >
                      <span style={{ width: 5, height: 5, borderRadius: 5, background: 'currentColor' }} />
                      {p.hasKey ? 'Key set' : 'No key'}
                    </span>
                  </div>
                  {p.base_url && (
                    <p className="text-xs text-muted truncate mt-1">
                      Endpoint: <code className="text-ink-2">{p.base_url}</code>
                    </p>
                  )}
                  {res && (
                    <p className={`text-xs mt-1 font-medium ${res.ok ? 'text-accent' : 'text-error'}`}>
                      {res.msg}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
                  <button
                    type="button"
                    onClick={() => handleTest(p.id)}
                    disabled={isTesting}
                    className="btn btn-ghost !py-1 !px-2.5 text-xs"
                  >
                    {isTesting ? 'Testing…' : 'Test'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setEditingId(p.id); setAdding(false); }}
                    className="btn btn-ghost !py-1 !px-2.5 text-xs"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(p.id, p.name)}
                    className="btn btn-ghost !py-1 !px-2.5 text-xs !text-error"
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

/* ── Local sidecar status + on/off control ───────────────────────────────── */
function SidecarControl({ sys, onChanged }) {
  const sc = sys?.sidecar;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  if (!sc) return null;

  const map = {
    running: { label: 'Running', color: 'var(--accent)', bg: 'var(--accent-soft)' },
    starting: { label: 'Starting…', color: 'var(--warn)', bg: 'var(--warn-soft)' },
    error: { label: 'Stopped', color: 'var(--error)', bg: 'var(--error-soft)' },
    stopped: { label: 'Stopped', color: 'var(--muted)', bg: 'var(--surface-3)' },
  };
  const s = map[sc.state] || map.stopped;
  const running = sc.state === 'running';

  async function act(action) {
    setBusy(true); setErr(null);
    try { await api.sidecarAction(action); await onChanged?.(); }
    catch (e) { setErr(e?.message || `Failed to ${action} sidecar`); }
    finally { setBusy(false); }
  }

  if (!sc.managed) {
    return (
      <div className="rounded-md bg-surface-2 px-3.5 py-3 text-xs text-muted">
        The local whisper sidecar is managed outside this process
        {sc.url ? <> (<code className="text-ink-2">{sc.url}</code>)</> : null}. In Docker it runs as its
        own container and starts/stops with <code className="text-ink-2">docker compose</code>.
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border px-3.5 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[13px] font-medium text-ink">Local sidecar</span>
          <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full" style={{ color: s.color, background: s.bg }}>
            <span style={{ width: 6, height: 6, borderRadius: 6, background: s.color }} />
            {s.label}{sc.external ? ' · external' : ''}
          </span>
          {running && sc.device && <DeviceBadge device={sc.device} model={sc.model} batchSize={sc.batchSize} />}
        </div>
        <div className="flex items-center gap-2">
          {running
            ? <button onClick={() => act('stop')} disabled={busy} className="btn btn-ghost !py-1.5">{busy ? '…' : 'Stop'}</button>
            : <button onClick={() => act('start')} disabled={busy} className="btn btn-primary !py-1.5">{busy ? 'Starting…' : 'Start sidecar'}</button>}
          {running && <button onClick={() => act('restart')} disabled={busy} className="btn btn-ghost !py-1.5">Restart</button>}
        </div>
      </div>
      <p className="text-xs text-muted mt-2">
        {running
          ? 'Transcribing locally on this machine. Turn it off to free CPU/RAM when using a cloud API.'
          : 'Off. Start it to transcribe locally without a cloud API.'}
      </p>
      {running && sc.device === 'cpu' && (
        <p className="text-xs mt-2 rounded-sm px-2.5 py-2" style={{ color: 'var(--warn)', background: 'var(--warn-soft)' }}>
          ⚠ Running on <b>CPU</b> — transcription is roughly 7x slower than GPU and is the usual cause of
          lag on longer meetings. If this machine has an NVIDIA GPU, install the CUDA libraries so the
          sidecar can use it (see the README GPU section).
        </p>
      )}
      {(err || sc.error) && <p className="text-xs text-error mt-1.5">{err || sc.error}</p>}
    </div>
  );
}

function DeviceBadge({ device, model, batchSize }) {
  const gpu = device === 'cuda';
  const color = gpu ? 'var(--accent)' : 'var(--warn)';
  const bg = gpu ? 'var(--accent-soft)' : 'var(--warn-soft)';
  const label = gpu ? 'GPU' : device === 'cpu' ? 'CPU' : device;
  const detail = [model, batchSize ? `batch ${batchSize}` : null].filter(Boolean).join(' · ');
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full"
      style={{ color, background: bg }} title={`STT on ${device}${detail ? ` (${detail})` : ''}`}>
      {label}{detail ? <span className="opacity-70">· {detail}</span> : null}
    </span>
  );
}

/* ── Connection card ─────────────────────────────────────────────────────── */
function ConnectionCard({ sys, onChanged }) {
  const [open, setOpen] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const bot = sys?.bot;
  const conn = sys?.connection;
  if (!sys?.managed) {
    return (
      <Card title="Connection" desc="Discord bot connection.">
        <p className="text-sm text-muted">
          This dashboard is running in read-only mode (no bot process attached), so the Discord
          connection is managed elsewhere. Start Parley with <code className="text-ink-2">npm start</code> to
          edit it here.
        </p>
        {bot && <div className="mt-2"><BotStatusBadge bot={bot} /></div>}
      </Card>
    );
  }
  async function restart() {
    setRestarting(true);
    try { await api.botAction('restart'); await onChanged?.(); }
    finally { setRestarting(false); }
  }
  return (
    <Card title="Connection" desc="Your Discord bot. Changes reconnect instantly.">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {bot && <BotStatusBadge bot={bot} />}
          {bot?.guildCount > 0 && <span className="text-xs text-muted">{bot.guildCount} server{bot.guildCount === 1 ? '' : 's'}</span>}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={restart} disabled={restarting} className="btn btn-ghost !py-1.5">{restarting ? 'Reconnecting…' : 'Reconnect'}</button>
          <button onClick={() => setOpen((o) => !o)} className="btn btn-ghost !py-1.5">{open ? 'Close' : 'Edit credentials'}</button>
        </div>
      </div>
      {bot?.state === 'error' && bot?.error && <p className="text-xs text-error mt-2">{bot.error}</p>}
      {open && (
        <div className="mt-4 pt-4 border-t border-border">
          <ConnectionForm conn={conn} submitLabel="Save & reconnect" onSaved={async () => { setOpen(false); await onChanged?.(); }} />
        </div>
      )}
    </Card>
  );
}

export default function Setup() {
  const { guildId } = useGuild();
  const { status: sys, refresh: refreshSys } = useSystem();
  const [data, setData] = useState(null);
  const [providerList, setProviderList] = useState([]);
  const [msg, setMsg] = useState('');
  const [msgErr, setMsgErr] = useState(false);

  const loadProviders = useCallback(() => {
    api.providers().then(setProviderList).catch(() => setProviderList([]));
  }, []);

  const reload = useCallback(() => {
    loadProviders();
    if (guildId) api.config(guildId).then(setData).catch(() => setData(null));
  }, [guildId, loadProviders]);

  useEffect(() => { reload(); }, [reload]);

  const models = useCatalog(data?.config?.summarizerProvider);
  const fbModels = useCatalog(data?.config?.summarizerFallbackProvider);

  if (!guildId) return (
    <Page max="720px">
      <PageHead title="Settings" subtitle="Discord connection and per-server configuration." />
      <div className="space-y-5">
        <ConnectionCard sys={sys} onChanged={refreshSys} />
        <ProvidersCard providers={providerList} onReload={reload} />
        <div className="mt-5">
          <Empty icon={Icon.Settings} title="No server selected" body="Pick a server from the top bar to configure summarizer, transcription, and delivery." />
        </div>
      </div>
    </Page>
  );

  if (!data) return (
    <Page max="720px">
      <div className="h-8 w-32 skeleton mb-7" />
      <div className="space-y-5">{[0,1,2].map(i => <div key={i} className="h-44 skeleton rounded-[14px]" />)}</div>
    </Page>
  );

  const { config: c, providers = [], sttProviders = [], channels = [] } = data;

  const save = async (patch) => {
    try {
      const r = await api.saveConfig(guildId, patch);
      setData((d) => ({ ...d, config: r.config }));
      setMsg('Saved'); setMsgErr(false);
      if (patch.sttProvider !== undefined) refreshSys?.();
      return true;
    } catch (e) {
      setMsg(e.message); setMsgErr(true); return false;
    } finally {
      setTimeout(() => setMsg(''), 2400);
    }
  };

  const sel = 'input appearance-none pr-9 cursor-pointer';

  return (
    <Page max="720px">
      <PageHead
        title="Settings"
        subtitle="Per-server configuration. Applied instantly, no restart."
        actions={msg && <span className={`text-sm font-medium ${msgErr ? 'text-error' : 'text-accent'}`}>{msg}</span>}
      />

      <div className="space-y-5">
        <ConnectionCard sys={sys} onChanged={refreshSys} />

        <ProvidersCard providers={providerList} onReload={reload} />

        <Card title="Summarizer" desc="Which AI turns transcripts into structured notes.">
          <Field label="Provider" hint={providers.length === 0 ? 'No providers configured yet. Add one in the AI Providers section above.' : undefined}>
            <div className="relative">
              <select
                className={sel}
                value={c.summarizerProvider || ''}
                onChange={(e) => save({ provider: e.target.value, model: '' })}
              >
                {providers.length === 0 && <option value="">No providers configured</option>}
                {providers.map((p) => (
                  <option key={p.provider} value={p.provider}>
                    {p.provider}{p.ok ? '' : ' (no key set)'}
                  </option>
                ))}
              </select>
              <Chevron />
            </div>
          </Field>

          {c.summarizerProvider && (
            <Field label="Model" hint="Type to search the provider's catalog. Any model id it supports works — press Enter to use what you typed.">
              <ModelPicker
                value={c.summarizerModel}
                catalog={models.catalog}
                loading={models.loading}
                onRefresh={models.reload}
                onPick={(id) => save({ provider: c.summarizerProvider, model: id })}
              />
            </Field>
          )}

          <Field label="Fallback" hint="Tried only if the primary fails (quota cap, outage, region block). Choose none to disable.">
            <div className="relative">
              <select
                className={sel}
                value={c.summarizerFallbackProvider || 'none'}
                onChange={(e) => save({ fallbackProvider: e.target.value, fallbackModel: '' })}
              >
                <option value="none">none</option>
                {providers
                  .filter((p) => p.ok && p.provider !== c.summarizerProvider)
                  .map((p) => (
                    <option key={p.provider} value={p.provider}>{p.provider}</option>
                  ))}
              </select>
              <Chevron />
            </div>
            {c.summarizerFallbackProvider && c.summarizerFallbackProvider !== 'none' && (
              <div className="mt-2">
                <ModelPicker
                  value={c.summarizerFallbackModel}
                  catalog={fbModels.catalog}
                  loading={fbModels.loading}
                  onRefresh={fbModels.reload}
                  onPick={(id) => save({ fallbackModel: id })}
                />
              </div>
            )}
          </Field>
        </Card>

        <Card title="Transcription" desc="How spoken audio becomes text.">
          <Field label="Provider" hint={c.sttProvider === 'sidecar' ? 'Local faster-whisper sidecar container' : 'Cloud STT endpoint'}>
            <div className="relative">
              <select
                className={sel}
                value={c.sttProvider || 'sidecar'}
                onChange={(e) => save({ sttProvider: e.target.value, sttModel: e.target.value === 'sidecar' ? null : '' })}
              >
                {sttProviders.map((p) => (
                  <option key={p.provider} value={p.provider}>
                    {p.label || p.provider}{p.ok ? '' : ' (no key set)'}
                  </option>
                ))}
              </select>
              <Chevron />
            </div>
          </Field>

          {c.sttProvider === 'sidecar' ? (
            <>
              <Field label="Whisper model" hint="Larger is more accurate but slower on CPU.">
                <div className="relative">
                  <select
                    className={sel}
                    value={c.whisperModel}
                    onChange={(e) => save({ whisperModel: e.target.value })}
                  >
                    {WHISPER.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <Chevron />
                </div>
              </Field>
              <SidecarControl sys={sys} onChanged={refreshSys} />
            </>
          ) : (
            <>
              <Field label="Model" hint="STT model id (e.g. whisper-1 for OpenAI, or your model name).">
                <input
                  type="text"
                  value={c.sttModel || ''}
                  placeholder="whisper-1"
                  onChange={(e) => save({ sttModel: e.target.value })}
                  className="input"
                />
              </Field>
              {sys?.sidecar?.managed && sys?.sidecar?.running && (
                <SidecarControl sys={sys} onChanged={refreshSys} />
              )}
            </>
          )}

          <Field label="Spoken language">
            <div className="relative">
              <select className={sel} value={c.language} onChange={(e) => save({ language: e.target.value })}>
                {LANGS.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
              </select>
              <Chevron />
            </div>
          </Field>
        </Card>

        <Card title="Delivery" desc="Where and how notes are posted in Discord.">
          <Field label="Notes channel">
            <div className="relative">
              <select className={sel} value={c.notesChannelId || ''} onChange={(e) => save({ notesChannelId: e.target.value || null })}>
                <option value="">(meeting's own channel)</option>
                {channels.map((ch) => <option key={ch.id} value={ch.id}>#{ch.name}</option>)}
              </select>
              <Chevron />
            </div>
          </Field>
          <Field label="Summary language">
            <div className="relative">
              <select className={sel} value={c.summaryLanguage} onChange={(e) => save({ summary_language: e.target.value })}>
                {SUMMARY_LANGS.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
              </select>
              <Chevron />
            </div>
          </Field>
          <Switch
            checked={c.useThread}
            onChange={(e) => save({ useThread: e.target.checked })}
            label="Post notes in a thread"
            desc="Keeps the channel tidy by threading each meeting's notes."
          />
        </Card>

        <Card title="Behavior">
          <Switch
            checked={c.autoJoin}
            onChange={(e) => save({ autoJoin: e.target.checked })}
            label="Auto-join voice"
            desc="Join automatically when two or more people are in a voice channel."
          />
        </Card>
      </div>
    </Page>
  );
}
