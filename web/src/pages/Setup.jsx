import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useSystem } from '../SystemContext.jsx';
import { Page, PageHead } from '../components/Page.jsx';
import { Icon } from '../components/ui.jsx';
import { ConnectionForm, BotStatusBadge } from '../components/Connection.jsx';

const PROVIDER_KINDS = [
  { id: 'openai-compatible', label: 'OpenAI-compatible', defaultUrl: 'https://api.openai.com/v1', hint: 'Groq, DeepSeek, Together, OpenRouter, vLLM, OpenAI, etc.' },
  { id: 'gemini', label: 'Google Gemini', defaultUrl: '', hint: 'Uses Google AI Studio SDK' },
  { id: 'ollama', label: 'Ollama', defaultUrl: 'http://localhost:11434', hint: 'Local or network Ollama instance' },
];

const PROVIDER_CAPS = [
  { id: 'both', label: 'Summarizer & Transcription (STT)' },
  { id: 'summarizer', label: 'Summarizer only' },
  { id: 'stt', label: 'Transcription (STT) only' },
];

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

function Chevron() {
  return <Icon.Chevron width={14} height={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rotate-90 text-muted" />;
}

/* ── Provider Form (Create / Edit) ────────────────────────────────────────── */
function ProviderForm({ initial = null, onSave, onCancel, isNew = false }) {
  const [kind, setKind] = useState(initial?.kind || 'openai-compatible');
  const [caps, setCaps] = useState(initial?.caps || 'both');
  const [id, setId] = useState(initial?.id || '');
  const [name, setName] = useState(initial?.name || '');
  const [baseUrl, setBaseUrl] = useState(initial?.base_url || initial?.baseUrl || '');
  const [apiKey, setApiKey] = useState('');
  const [modelsStr, setModelsStr] = useState(() => {
    if (!initial?.models) return '';
    if (Array.isArray(initial.models)) return initial.models.join(', ');
    try {
      const parsed = JSON.parse(initial.models);
      if (Array.isArray(parsed)) return parsed.join(', ');
    } catch { /* use raw */ }
    return String(initial.models);
  });
  const [detecting, setDetecting] = useState(false);
  const [detectMsg, setDetectMsg] = useState(null);
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

  async function handleDetect() {
    setDetecting(true);
    setDetectMsg(null);
    try {
      const res = await api.detectModels({
        id: (initial?.id || id || '').trim() || undefined,
        kind,
        baseUrl: baseUrl.trim() || undefined,
        apiKey: apiKey.trim() || undefined,
      });
      if (res.ok && res.models?.length) {
        setModelsStr(res.models.join(', '));
        setDetectMsg({ ok: true, text: `Found ${res.models.length} models: ${res.models.slice(0, 3).join(', ')}${res.models.length > 3 ? '…' : ''}` });
      } else {
        setDetectMsg({ ok: false, text: res.error || 'No models discovered from endpoint. You can write model names manually.' });
      }
    } catch (e) {
      setDetectMsg({ ok: false, text: e.message || 'Detection failed. You can write model names manually.' });
    } finally {
      setDetecting(false);
    }
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const parsedModels = modelsStr.trim()
        ? modelsStr.split(/[,\n]+/).map((s) => s.trim()).filter(Boolean)
        : null;

      const payload = {
        name: name.trim(),
        kind,
        caps: caps || 'both',
        baseUrl: baseUrl.trim() || null,
        apiKey: apiKey.trim() || undefined,
        models: parsedModels,
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

        <Field label="Capabilities" hint="Whether this endpoint does summarization, audio transcription (STT), or both">
          <div className="relative">
            <select
              value={caps}
              onChange={(e) => setCaps(e.target.value)}
              className="input appearance-none pr-9 cursor-pointer"
            >
              {PROVIDER_CAPS.map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </select>
            <Chevron />
          </div>
        </Field>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Identifier (slug)" hint={isNew ? 'Unique key used by /setup, e.g. "groq" or "vllm"' : 'Cannot be changed'}>
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
            : kind === 'ollama' ? 'Optional for local Ollama' : 'Optional for local endpoints; stored securely in database'
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

      <Field
        label="Exposed Models"
        hint="Comma-separated list of model names or IDs. If left blank, models will be fetched live on demand when configuring."
      >
        <div className="space-y-1.5">
          <div className="flex gap-2">
            <input
              type="text"
              value={modelsStr}
              onChange={(e) => setModelsStr(e.target.value)}
              placeholder="e.g. llama3.2, deepseek-r1:8b"
              className="input flex-1"
            />
            <button
              type="button"
              onClick={handleDetect}
              disabled={detecting}
              className="btn btn-ghost !py-1.5 shrink-0 text-xs inline-flex items-center gap-1.5"
              title="Query endpoint for available models"
            >
              <Icon.Refresh width={13} height={13} className={detecting ? 'animate-spin' : ''} />
              {detecting ? 'Detecting…' : 'Detect models'}
            </button>
          </div>
          {detectMsg && (
            <p className={`text-xs ${detectMsg.ok ? 'text-accent' : 'text-warn'}`}>
              {detectMsg.text}
            </p>
          )}
        </div>
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
                    {p.caps && (
                      <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-surface-3 text-muted">
                        {p.caps === 'both' ? 'summarizer + stt' : p.caps}
                      </span>
                    )}
                    {p.models && (
                      <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-surface-3 text-muted">
                        {Array.isArray(p.models)
                          ? `${p.models.length} model${p.models.length === 1 ? '' : 's'}`
                          : (String(p.models).trim().startsWith('[')
                              ? `${JSON.parse(p.models).length} models`
                              : `${String(p.models).split(',').length} models`)}
                      </span>
                    )}
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
  const { status: sys, refresh: refreshSys } = useSystem();
  const [providerList, setProviderList] = useState([]);

  const reload = useCallback(() => {
    api.providers().then(setProviderList).catch(() => setProviderList([]));
  }, []);

  useEffect(() => { reload(); }, [reload]);

  return (
    <Page max="720px">
      <PageHead
        title="Settings"
        subtitle="Connect your bot, configure AI providers, and view system status."
      />

      <div className="space-y-5">
        <ConnectionCard sys={sys} onChanged={refreshSys} />
        <ProvidersCard providers={providerList} onReload={reload} />
      </div>
    </Page>
  );
}
