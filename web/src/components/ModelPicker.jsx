import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './ui.jsx';

// Searchable model combobox. The list is the provider's full live catalog
// (hundreds of ids for gateways like OpenRouter), so selection is search-first:
// type to filter, arrows to move, Enter to take the highlighted row. Any id the
// provider supports can still be typed by hand — Enter with no match commits the
// raw text, which is how a brand-new model works before catalogs catch up.

const MAX_ROWS = 250; // keep the dropdown light; refine the query to reach the rest

function contextLabel(tokens) {
  if (!Number.isFinite(tokens) || tokens <= 0) return '';
  if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

// Mirrors searchModels() on the server: every token must appear in the id or
// label; exact, then prefix, then id-substring matches rank first.
function rank(models, query) {
  const q = query.trim().toLowerCase();
  if (!q) return models;
  const tokens = q.split(/\s+/);
  const hits = [];
  models.forEach((m, i) => {
    const id = (typeof m.id === 'string' ? m.id : (m.id?.id || m.id?.name || String(m.id || ''))).toLowerCase();
    const labelStr = typeof m.label === 'string' ? m.label : (m.label?.name || m.label?.id || id);
    const hay = `${id} ${labelStr.toLowerCase()}`;
    if (!tokens.every((t) => hay.includes(t))) return;
    hits.push({ m, i, score: id === q ? 0 : id.startsWith(q) ? 1 : id.includes(q) ? 2 : 3 });
  });
  hits.sort((a, b) => (a.score - b.score) || (a.i - b.i));
  return hits.map((h) => h.m);
}

export function ModelPicker({ value, catalog, loading = false, onPick, onRefresh }) {
  const rawModels = catalog?.models || [];
  const models = useMemo(() => {
    return (Array.isArray(rawModels) ? rawModels : []).map((m) => {
      if (!m) return null;
      if (typeof m === 'string') return { id: m, label: m, context: null };
      const id = typeof m.id === 'string'
        ? m.id
        : (typeof m.id === 'object' && m.id ? (m.id.id || m.id.name || '') : (m.name || ''));
      const label = typeof m.label === 'string'
        ? m.label
        : (typeof m.label === 'object' && m.label ? (m.label.label || m.label.name || m.label.id || id) : id);
      return {
        id: String(id || '').trim(),
        label: String(label || id || '').trim(),
        context: Number.isFinite(m.context) ? m.context : null,
      };
    }).filter((m) => m && m.id);
  }, [rawModels]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const boxRef = useRef(null);
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const id = useRef(`mp-${Math.random().toString(36).slice(2)}`).current;

  const displayVal = typeof value === 'object' && value !== null ? (value.id || '') : (value || '');

  const results = useMemo(() => rank(models, query), [models, query]);
  const shown = results.slice(0, MAX_ROWS);

  useEffect(() => { setActive(0); }, [query]);

  // Clicking outside cancels: the input doubles as a search box, so a stray
  // click must never save a half-typed filter as the model id.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (!boxRef.current?.contains(e.target)) close(); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Keep the highlighted row visible while arrowing through a long catalog.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector('[data-active="1"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  function close() { setOpen(false); setQuery(''); }
  function commit(raw) {
    const rawVal = typeof raw === 'object' && raw !== null ? (raw.id || raw.name) : raw;
    const v = String(rawVal || '').trim();
    close();
    if (v && v !== displayVal) onPick(v);
  }

  function onKeyDown(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((a) => Math.min(shown.length - 1, Math.max(0, a + step)));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (open && shown[active]) commit(shown[active].id);
      else commit(query || displayVal);
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); close(); inputRef.current?.blur(); return; }
    if (e.key === 'Tab') close();
  }

  const source = catalog?.source;
  const hint = loading ? 'Loading catalog…'
    : source === 'live' ? `${models.length} model${models.length === 1 ? '' : 's'} available`
    : catalog?.error ? `Catalog unavailable (${catalog.error}) — showing known models` : '';

  return (
    <div ref={boxRef} className="relative">
      <div className="relative">
        <input
          ref={inputRef}
          className="input pr-16"
          role="combobox"
          aria-expanded={open}
          aria-controls={id}
          aria-autocomplete="list"
          aria-activedescendant={open && shown[active] ? `${id}-${active}` : undefined}
          value={open ? query : displayVal}
          placeholder={open ? 'Search models…' : (displayVal || 'Pick a model…')}
          onFocus={() => setOpen(true)}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onKeyDown={onKeyDown}
        />
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
          {onRefresh && (
            <button type="button" title="Reload the provider's model list"
              className="p-1 rounded text-muted hover:text-ink"
              onClick={() => { onRefresh(); setOpen(true); inputRef.current?.focus(); }}>
              <Icon.Refresh width={14} height={14} className={loading ? 'animate-spin' : ''} />
            </button>
          )}
          <button type="button" tabIndex={-1} aria-label="Toggle model list"
            className="p-1 rounded text-muted hover:text-ink"
            onClick={() => { if (open) close(); else { setOpen(true); inputRef.current?.focus(); } }}>
            <Icon.Chevron width={14} height={14} className="rotate-90" />
          </button>
        </div>
      </div>

      {open && (
        <div id={id} role="listbox" ref={listRef}
          className="absolute z-20 mt-1 w-full max-h-72 overflow-y-auto card shadow-lg p-1">
          {shown.length === 0 && (
            <p className="px-2.5 py-2 text-xs text-muted">
              {models.length ? 'No match. Press Enter to use it anyway.' : 'No catalog. Type an id and press Enter.'}
            </p>
          )}
          {shown.map((m, i) => {
            const isValue = m.id === value;
            const ctx = contextLabel(m.context);
            return (
              <button key={m.id} type="button" id={`${id}-${i}`} role="option"
                aria-selected={isValue} data-active={i === active ? '1' : '0'}
                onMouseEnter={() => setActive(i)}
                onClick={() => commit(m.id)}
                className={`w-full text-left px-2.5 py-1.5 rounded-[7px] flex items-center gap-2
                  ${i === active ? 'bg-surface-3' : ''} ${isValue ? 'text-accent' : 'text-ink'}`}>
                <span className="flex-1 min-w-0">
                  <span className="block text-[13px] font-medium truncate">{m.id}</span>
                  {m.label && m.label !== m.id && (
                    <span className="block text-[11px] text-muted truncate">{m.label}</span>
                  )}
                </span>
                {ctx && <span className="chip shrink-0">{ctx}</span>}
                {isValue && <Icon.Check width={13} height={13} className="shrink-0" />}
              </button>
            );
          })}
          {results.length > shown.length && (
            <p className="px-2.5 py-1.5 text-xs text-muted">
              +{results.length - shown.length} more — keep typing to narrow.
            </p>
          )}
        </div>
      )}
      {hint && <p className="text-xs text-muted mt-1.5">{hint}</p>}
    </div>
  );
}
