import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useGuild } from '../GuildContext.jsx';
import { Page, PageHead } from '../components/Page.jsx';
import { Icon, Empty } from '../components/ui.jsx';
import { ModelPicker } from '../components/ModelPicker.jsx';

function Field({ label, hint, children }) {
  return (
    <div>
      <label className="block text-[13px] font-medium text-ink mb-1.5">{label}</label>
      {children}
      {hint && <p className="text-xs text-muted mt-1.5">{hint}</p>}
    </div>
  );
}

function Card({ title, desc, extra, disabled, badge, children }) {
  return (
    <section className={`card p-5 transition-all ${disabled ? 'opacity-40 pointer-events-none select-none' : ''}`}>
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-bold text-ink">{title}</h2>
            {badge}
          </div>
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
      <span className="relative inline-flex items-center shrink-0 mt-0.5">
        <input type="checkbox" checked={checked} onChange={onChange} className="sr-only peer" />
        <span className="w-9 h-5 bg-surface-3 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary transition-colors" />
      </span>
    </label>
  );
}

function Chevron() {
  return (
    <Icon.Chevron
      width={14}
      height={14}
      className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rotate-90 text-muted"
    />
  );
}

function ProviderModelRow({ providerValue, modelValue, providerOptions, label, providerHint, modelHint, onSave }) {
  const [catalog, setCatalog] = useState(null);
  const [loadingCatalog, setLoadingCatalog] = useState(false);

  async function fetchCatalog(providerId, refresh = false) {
    if (!providerId || providerId === 'sidecar') return;
    setLoadingCatalog(true);
    try {
      const res = await api.providerModels(providerId, refresh);
      setCatalog(res);
    } catch (e) {
      setCatalog({ models: [], error: e.message });
    } finally {
      setLoadingCatalog(false);
    }
  }

  useEffect(() => {
    setCatalog(null);
    if (providerValue && providerValue !== 'sidecar') fetchCatalog(providerValue);
  }, [providerValue]);

  return (
    <div className="space-y-3">
      <Field label={label} hint={providerHint}>
        <div className="relative">
          <select
            value={providerValue || ''}
            onChange={(e) => onSave({ provider: e.target.value || null, model: null })}
            className="input appearance-none pr-9 cursor-pointer"
          >
            <option value="">— None / default —</option>
            {providerOptions.map((p) => (
              <option key={p.provider} value={p.provider} disabled={!p.ok}>
                {p.name || p.label || p.provider}{!p.ok ? ' (not configured)' : ''}
              </option>
            ))}
          </select>
          <Chevron />
        </div>
      </Field>

      {providerValue && (
        <Field label="Model" hint={modelHint}>
          <ModelPicker
            value={typeof modelValue === 'object' && modelValue !== null ? (modelValue.id || '') : (modelValue || '')}
            catalog={catalog}
            loading={loadingCatalog}
            onPick={(m) => onSave({ model: typeof m === 'object' && m !== null ? (m.id || '') : m })}
            onRefresh={() => fetchCatalog(providerValue, true)}
          />
        </Field>
      )}
    </div>
  );
}

function PromptEditor({ value, defaultValue, onSave }) {
  const current = value ?? defaultValue;
  const [draft, setDraft] = useState(current);
  const [busy, setBusy] = useState(false);
  const changed = draft !== current;
  useEffect(() => { setDraft(current); }, [current]);

  async function savePrompt(next) {
    setBusy(true);
    const ok = await onSave({ summaryPrompt: next });
    if (ok) setDraft(next ?? defaultValue);
    setBusy(false);
  }

  return (
    <Field label="Summary prompt" hint="Instructions sent to the summarizer before the meeting details and transcript. Keep the JSON output shape if you want structured notes and todos.">
      <textarea
        className="input min-h-64 font-mono text-xs resize-y"
        aria-label="Summary prompt"
        value={draft || ''}
        onChange={(e) => setDraft(e.target.value)}
        maxLength={20000}
      />
      <div className="flex flex-wrap gap-2 mt-2">
        <button
          type="button"
          className="btn btn-primary !py-1.5"
          disabled={busy || !changed || !draft?.trim()}
          onClick={() => savePrompt(draft?.trim())}
        >
          Save prompt
        </button>
        <button
          type="button"
          className="btn btn-ghost !py-1.5"
          disabled={busy || value == null}
          onClick={() => savePrompt(null)}
        >
          Restore default
        </button>
        {changed && (
          <button
            type="button"
            className="btn btn-ghost !py-1.5"
            disabled={busy}
            onClick={() => setDraft(current)}
          >
            Discard changes
          </button>
        )}
      </div>
    </Field>
  );
}

function DisplayNameManager({ guildId, members }) {
  const [displayNames, setDisplayNames] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [draftName, setDraftName] = useState('');

  useEffect(() => {
    async function load() {
      try {
        const names = await api.displayNames.list(guildId);
        setDisplayNames(names);
      } catch (e) {
        console.error('Failed to load display names:', e);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [guildId]);

  async function saveName(userId, displayName) {
    try {
      const updated = await api.displayNames.set(guildId, userId, displayName);
      setDisplayNames(updated);
      setEditing(null);
    } catch (e) {
      console.error('Failed to save display name:', e);
    }
  }

  if (loading) return <div className="h-44 skeleton rounded-[14px]" />;

  return (
    <Card title="Display Name Overrides" desc="Customize how members appear in transcripts and summaries">
      <div className="space-y-3">
        {members.map((m) => {
          const current = displayNames.find((d) => d.user_id === m.id);
          const isEditing = editing === m.id;
          return (
            <div key={m.id} className="flex items-center gap-3">
              <div className="flex-1">
                <p className="text-sm font-medium text-ink">{m.displayName}</p>
                {current ? (
                  <p className="text-xs text-muted">Currently: {current.display_name}</p>
                ) : (
                  <p className="text-xs text-muted">No custom name set</p>
                )}
              </div>
              {isEditing ? (
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    placeholder="Enter custom name"
                    className="input !py-1.5"
                  />
                  <button
                    type="button"
                    className="btn btn-primary !py-1.5"
                    onClick={() => saveName(m.id, draftName)}
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost !py-1.5"
                    onClick={() => setEditing(null)}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="btn btn-ghost !py-1.5"
                    onClick={() => {
                      setEditing(m.id);
                      setDraftName(current?.display_name || '');
                    }}
                  >
                    {current ? 'Edit' : 'Set'}
                  </button>
                  {current && (
                    <button
                      type="button"
                      className="btn btn-ghost !py-1.5 text-error"
                      onClick={() => saveName(m.id, null)}
                    >
                      Remove
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

export default function ServerSettings() {
  const { guildId, guilds } = useGuild();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [msgErr, setMsgErr] = useState(false);

  const currentGuild = guilds.find((g) => g.id === guildId);

  const reload = useCallback(() => {
    if (!guildId) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    api.config(guildId)
      .then((res) => {
        setData(res);
      })
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [guildId]);

  useEffect(() => {
    reload();
  }, [reload]);

  if (!guildId) {
    return (
      <Page max="720px">
        <PageHead
          title="Server Settings"
          subtitle="Configure AI models, channels, language and behavior for the selected server."
        />
        <Empty
          icon={Icon.Sliders || Icon.Settings}
          title="No server selected"
          body="Pick a server from the top bar to configure its settings."
        />
      </Page>
    );
  }

  if (loading || !data) {
    return (
      <Page max="720px">
        <div className="h-8 w-44 skeleton mb-2" />
        <div className="h-4 w-72 skeleton mb-7" />
        <div className="space-y-5">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-44 skeleton rounded-[14px]" />
          ))}
        </div>
      </Page>
    );
  }

  const { config: c } = data;
  const isSummarizerEnabled = c?.summarizerEnabled !== false;
  const providers = data?.providers || [];
  const sttProviders = data?.sttProviders || [];
  const channels = data?.channels || [];
  const members = data?.members || [];
  const languages = data?.languages || [];

  const summarizerProviders = providers.filter(
    (p) => p.provider !== 'sidecar' && (p.caps === 'summarizer' || p.caps === 'both' || !p.caps)
  );

  const currentSttProv = sttProviders.find((p) => p.provider === (c?.sttProvider || 'sidecar'));
  const sttModels = currentSttProv?.models || [];
  const sidecarEntry = sttProviders.find((p) => p.provider === 'sidecar');
  const whisperModels = sidecarEntry?.models || [];

  const retentionOptions = data?.recordingRetentionOptions
    ? data.recordingRetentionOptions.map((opt) => ({
        value: opt,
        label: data.recordingRetentionLabels?.[opt] || opt,
      }))
    : [
        { value: 'immediately', label: 'Delete immediately (as soon as processed)' },
        { value: '1d', label: 'Keep for 1 day' },
        { value: '3d', label: 'Keep for 3 days' },
        { value: '7d', label: 'Keep for 7 days' },
        { value: '14d', label: 'Keep for 14 days' },
        { value: '30d', label: 'Keep for 30 days' },
        { value: '90d', label: 'Keep for 90 days' },
        { value: 'never', label: 'Never delete (keep indefinitely)' },
      ];

  const save = async (patch) => {
    try {
      const r = await api.saveConfig(guildId, patch);
      setData((d) => ({ ...d, config: r.config }));
      setMsg('Saved');
      setMsgErr(false);
      return true;
    } catch (e) {
      setMsg(e.message);
      setMsgErr(true);
      return false;
    } finally {
      setTimeout(() => setMsg(''), 2400);
    }
  };

  return (
    <Page max="720px">
      <PageHead
        title={currentGuild ? `${currentGuild.name} Settings` : 'Server Settings'}
        subtitle="Per-server configuration. Applied instantly without restarting the bot."
        actions={
          msg && (
            <span className={`text-sm font-medium ${msgErr ? 'text-error' : 'text-accent'}`}>
              {msg}
            </span>
          )
        }
      />

      <div className="space-y-5">
        {/* 1. Speech-to-Text (STT) Settings First */}
        <Card title="Speech-to-Text (STT)" desc="Transcription engine that converts voice recordings into text.">
          <Field label="STT provider" hint="The sidecar runs locally via faster-whisper; cloud providers send audio to a remote API.">
            <div className="relative">
              <select
                value={c?.sttProvider || 'sidecar'}
                onChange={(e) => save({ sttProvider: e.target.value })}
                className="input appearance-none pr-9 cursor-pointer"
              >
                {sttProviders.map((p) => (
                  <option key={p.provider} value={p.provider} disabled={!p.ok}>
                    {p.label || p.provider}{!p.ok ? ' (not configured)' : ''}
                  </option>
                ))}
              </select>
              <Chevron />
            </div>
          </Field>

          {(c?.sttProvider === 'sidecar' || !c?.sttProvider) && whisperModels.length > 0 && (
            <Field label="Whisper model size" hint="Larger models are more accurate but slower and use more memory. 'small' is a good default.">
              <div className="relative">
                <select
                  value={c?.whisperModel || 'small'}
                  onChange={(e) => save({ whisperModel: e.target.value })}
                  className="input appearance-none pr-9 cursor-pointer"
                >
                  {whisperModels.map((m) => {
                    const mid = typeof m === 'string' ? m : (m?.id || m?.name || '');
                    return <option key={mid} value={mid}>{mid}</option>;
                  })}
                </select>
                <Chevron />
              </div>
            </Field>
          )}

          {c?.sttProvider && c.sttProvider !== 'sidecar' && (
            <Field label="STT model" hint="Model used for transcription with the selected cloud provider.">
              {sttModels.length > 0 ? (
                <div className="relative">
                  <select
                    value={c?.sttModel || ''}
                    onChange={(e) => save({ sttModel: e.target.value || null })}
                    className="input appearance-none pr-9 cursor-pointer"
                  >
                    <option value="">— Provider default —</option>
                    {sttModels.map((m) => {
                      const mid = typeof m === 'string' ? m : (m?.id || m?.name || '');
                      return <option key={mid} value={mid}>{mid}</option>;
                    })}
                  </select>
                  <Chevron />
                </div>
              ) : (
                <input
                  type="text"
                  value={c?.sttModel || ''}
                  onChange={(e) => save({ sttModel: e.target.value || null })}
                  placeholder="e.g. whisper-1"
                  className="input"
                />
              )}
            </Field>
          )}

          <Field label="Transcription language" hint="The spoken language in your voice channels. 'Auto-detect' works well for single-language meetings but can struggle when speakers switch languages.">
            <div className="relative">
              <select
                value={c?.language || 'auto'}
                onChange={(e) => save({ language: e.target.value })}
                className="input appearance-none pr-9 cursor-pointer"
              >
                <option value="auto">Auto-detect</option>
                {languages.map((l) => (
                  <option key={l.code} value={l.code}>{l.name}</option>
                ))}
              </select>
              <Chevron />
            </div>
          </Field>

          <Field
            label="Transcription vocabulary / glossary (D&D diary)"
            hint="Proper nouns, fantasy character names, locations, and specialized jargon to guide speech-to-text models (Whisper, Voxtral, Gemma)."
          >
            <textarea
              className="input min-h-20 font-mono text-xs resize-y"
              value={c?.sttPrompt || ''}
              onChange={(e) => save({ sttPrompt: e.target.value || null })}
              placeholder="e.g. Neverwinter, Faerun, Tiamat, Waterdeep, Strahd, Baldur's Gate..."
            />
          </Field>

          <div className="pt-3 border-t border-border">
            <Switch
              checked={c?.autoTranscribe !== false}
              onChange={(e) => save({ autoTranscribe: e.target.checked })}
              label="Start transcription immediately"
              desc="Automatically begin speech-to-text transcription as soon as a meeting finishes recording. Turn off to keep audio and transcribe manually on demand."
            />
          </div>
        </Card>

        {/* Recording retention */}
        <Card
          title="Recording retention"
          desc="How long audio recordings are preserved on disk after meetings end. Keeping audio lets you re-transcribe meetings with different models later."
        >
          <Field
            label="Audio retention period"
            hint="Set to 'Delete immediately' to save disk space, or keep recordings if you plan to re-transcribe later."
          >
            <div className="relative">
              <select
                value={c?.recordingRetention || 'immediately'}
                onChange={(e) => save({ recordingRetention: e.target.value })}
                className="input appearance-none pr-9 cursor-pointer"
              >
                {retentionOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <Chevron />
            </div>
          </Field>
        </Card>

        {/* 2. Summarization Stuff Second */}
        <Card
          title="Summarizer"
          desc="The AI model that reads your transcripts and writes the meeting notes."
        >
          <div className="pb-4 border-b border-border">
            <Switch
              checked={isSummarizerEnabled}
              onChange={(e) => save({ summarizerEnabled: e.target.checked })}
              label="Enable AI Summarizer"
              desc="Automatically generate meeting notes, topics, and action items from transcripts."
            />
          </div>

          {!isSummarizerEnabled && (
            <div className="p-3 bg-surface-2 rounded-lg border border-border flex items-start gap-2.5 text-xs text-muted">
              <Icon.Alert width={16} height={16} className="text-muted shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-ink">Summarizer is disabled for this server</p>
                <p className="mt-0.5">Parley will still record voice and transcribe speech, but will not generate AI meeting notes.</p>
              </div>
            </div>
          )}

          <div className={isSummarizerEnabled ? 'space-y-4' : 'space-y-4 opacity-40 pointer-events-none select-none transition-all'}>
            <ProviderModelRow
              label="Primary provider"
              providerValue={c?.summarizerProvider}
              modelValue={c?.summarizerModel}
              providerOptions={summarizerProviders}
              providerHint="Configured providers from global Settings."
              modelHint="Model used for generating meeting summaries."
              onSave={(patch) => {
                const update = {};
                if (patch.provider !== undefined) update.provider = patch.provider;
                if (patch.model !== undefined) update.model = patch.model;
                save(update);
              }}
            />

            <div className="border-t border-border pt-4">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted mb-3">Fallback (optional)</p>
              <ProviderModelRow
                label="Fallback provider"
                providerValue={c?.summarizerFallbackProvider}
                modelValue={c?.summarizerFallbackModel}
                providerOptions={summarizerProviders}
                providerHint="Used only if the primary provider fails during a meeting."
                modelHint="Model for the fallback summarizer."
                onSave={(patch) => {
                  const update = {};
                  if (patch.provider !== undefined) update.fallbackProvider = patch.provider || 'none';
                  if (patch.model !== undefined) update.fallbackModel = patch.model;
                  save(update);
                }}
              />
            </div>

            <div className="border-t border-border pt-4">
              <Field label="Summary language" hint="The language the AI writes the notes in. 'Match transcription' mirrors whatever language was spoken.">
                <div className="relative">
                  <select
                    value={c?.summaryLanguage || 'en'}
                    onChange={(e) => save({ summary_language: e.target.value })}
                    className="input appearance-none pr-9 cursor-pointer"
                  >
                    <option value="match">Match transcription</option>
                    {languages.map((l) => (
                      <option key={l.code} value={l.code}>{l.name}</option>
                    ))}
                  </select>
                  <Chevron />
                </div>
              </Field>
            </div>

            <div className="border-t border-border pt-4">
              <PromptEditor key={guildId} value={c?.summaryPrompt} defaultValue={data?.defaultSummaryPrompt} onSave={save} />
            </div>
          </div>
        </Card>

        {/* Notes & Posting (Linked to Summarizer) */}
        <Card
          title="Notes & Posting"
          desc="Where and how the bot posts meeting summaries after a session ends."
          disabled={!isSummarizerEnabled}
          badge={!isSummarizerEnabled ? <span className="text-[10px] font-medium uppercase tracking-wider bg-surface-3 px-2 py-0.5 rounded text-muted">Disabled</span> : null}
        >
          {!isSummarizerEnabled && (
            <p className="text-xs text-muted -mt-1 mb-2">Requires AI Summarizer to be enabled.</p>
          )}

          <Field label="Notes channel" hint="The text channel where summaries are posted. Leave unset to post in the same channel as /join.">
            <div className="relative">
              <select
                value={c?.notesChannelId || ''}
                onChange={(e) => save({ notesChannelId: e.target.value || null })}
                className="input appearance-none pr-9 cursor-pointer"
              >
                <option value="">— Same channel as /join —</option>
                {channels.map((ch) => (
                  <option key={ch.id} value={ch.id}>#{ch.name}</option>
                ))}
              </select>
              <Chevron />
            </div>
          </Field>

          <Switch
            checked={!!c?.useThread}
            onChange={(e) => save({ useThread: e.target.checked })}
            label="Post in a thread"
            desc="Creates a thread for each meeting summary instead of posting directly in the channel."
          />
        </Card>

        {/* 3. Behavior Third */}
        <Card title="Behavior" desc="Automatic recording and convenience settings.">
          <Switch
            checked={!!c?.autoJoin}
            onChange={(e) => save({ autoJoin: e.target.checked })}
            label="Auto-join voice"
            desc="Join automatically when two or more people are in a voice channel. Equivalent to /setup autojoin."
          />
        </Card>

        {/* 4. User & Bot Blacklist */}
        <BlacklistCard
          guildId={guildId}
          blacklist={c?.userBlacklist || []}
          members={members}
          onSave={save}
        />
      </div>
    </Page>
  );
}

function BlacklistCard({ guildId, blacklist = [], members = [], onSave }) {
  const [inputVal, setInputVal] = useState('');
  const [selectedMember, setSelectedMember] = useState('');
  const [memberList, setMemberList] = useState(members);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [hasPulled, setHasPulled] = useState(false);

  useEffect(() => {
    setMemberList(members);
  }, [members]);

  const refreshMembers = async () => {
    if (!guildId || loadingMembers) return;
    setLoadingMembers(true);
    try {
      const res = await api.guildMembers(guildId, true);
      if (res?.members) {
        setMemberList(res.members);
      }
    } catch (e) {
      console.error('Failed to fetch members:', e);
    } finally {
      setLoadingMembers(false);
      setHasPulled(true);
    }
  };

  const handleDropdownOpen = () => {
    if (!hasPulled && !loadingMembers) {
      refreshMembers();
    }
  };

  const currentList = Array.isArray(blacklist) ? blacklist : [];

  const handleAdd = (val) => {
    const trimmed = (val || '').trim();
    if (!trimmed) return;
    const clean = trimmed.replace(/[<@!>]/g, '');
    if (!clean) return;
    if (currentList.some((x) => x.toLowerCase() === clean.toLowerCase())) return;
    const next = [...currentList, clean];
    onSave({ userBlacklist: next });
    setInputVal('');
    setSelectedMember('');
  };

  const handleRemove = (item) => {
    const next = currentList.filter((x) => x !== item);
    onSave({ userBlacklist: next });
  };

  return (
    <Card
      title="User & Bot Blacklist"
      desc="Ignore specific users or bots completely (ideal for music bots like FredBoat, Lofi, etc.)."
    >
      <div className="space-y-3">
        <p className="text-xs text-muted leading-relaxed">
          Blacklisted accounts will <strong>never have audio recorded</strong>, will <strong>not appear as attendees</strong> in meetings or transcripts, and will <strong>not be counted</strong> toward auto-join or auto-leave. It's like they do not exist.
        </p>

        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1 flex items-center gap-1.5">
            <div className="relative flex-1">
              <select
                value={selectedMember}
                onFocus={handleDropdownOpen}
                onClick={handleDropdownOpen}
                onChange={(e) => {
                  setSelectedMember(e.target.value);
                  if (e.target.value) handleAdd(e.target.value);
                }}
                className="input appearance-none pr-9 cursor-pointer text-sm w-full"
              >
                <option value="">
                  {loadingMembers
                    ? '— Pulling members from Discord… —'
                    : (memberList.length > 0 ? '— Pick server member / bot to blacklist —' : '— No members found (click ↻ to pull) —')}
                </option>
                {memberList.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.isBot ? '🤖 ' : '👤 '} {m.displayName} (@{m.username})
                  </option>
                ))}
              </select>
              <Chevron />
            </div>
            <button
              type="button"
              onClick={refreshMembers}
              disabled={loadingMembers}
              title="Pull / refresh members from Discord"
              aria-label="Pull / refresh members from Discord"
              className="btn btn-secondary !py-2 px-2.5 shrink-0 flex items-center justify-center text-muted hover:text-ink transition-colors"
            >
              <Icon.Refresh width={14} height={14} className={loadingMembers ? 'animate-spin text-accent' : ''} />
            </button>
          </div>
          <div className="flex gap-2 flex-1">
            <input
              type="text"
              placeholder="Or enter User ID / username..."
              value={inputVal}
              onChange={(e) => setInputVal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAdd(inputVal);
                }
              }}
              className="input text-sm flex-1"
            />
            <button
              type="button"
              onClick={() => handleAdd(inputVal)}
              disabled={!inputVal.trim()}
              className="btn btn-secondary !py-1.5 px-3 text-xs shrink-0"
            >
              Add
            </button>
          </div>
        </div>

        {currentList.length > 0 ? (
          <div className="flex flex-wrap gap-2 pt-1">
            {currentList.map((entry) => {
              const matched = memberList.find(
                (m) => m.id === entry || m.username.toLowerCase() === entry.toLowerCase()
              );
              return (
                <span
                  key={entry}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-surface-2 border border-border text-xs text-ink"
                >
                  <span className="font-mono text-muted text-[11px]">{matched?.isBot ? '🤖' : '🚫'}</span>
                  <span className="font-medium">
                    {matched ? `${matched.displayName} (@${matched.username})` : entry}
                  </span>
                  {matched && <span className="text-[10px] text-faint">({entry})</span>}
                  <button
                    type="button"
                    onClick={() => handleRemove(entry)}
                    className="ml-1 text-muted hover:text-error transition-colors text-sm leading-none"
                    title="Remove from blacklist"
                    aria-label={`Remove ${entry} from blacklist`}
                  >
                    ×
                  </button>
                </span>
              );
            })}
          </div>
        ) : (
          <p className="text-xs text-muted/80 italic pt-1">
            No users or bots blacklisted on this server yet.
          </p>
        )}
      </div>
    </Card>
  );
}
