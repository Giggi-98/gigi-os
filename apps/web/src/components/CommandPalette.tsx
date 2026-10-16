// Ctrl+K (D-030): pagine, app, container, torrent, media da rivedere, titoli Jellyfin e azioni rapide in base al ruolo.
// Combobox ARIA scritta in casa: nessuna dipendenza. Le azioni non eseguono nulla da sole: aprono la conferma esistente.
// Va montata solo da aperta: le sue query (container, torrent, media) non girano in background.
import { useQuery } from '@tanstack/react-query';
import { Clapperboard, CornerDownLeft, Download, ExternalLink, Film, Loader2, RotateCw, Search, Wand2 } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type LauncherApp } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fuzzyScore } from '../lib/fuzzy';
import { byType, useContainers, useIntegrations, useResource } from '../lib/queries';
import { AppIcon } from './AppTile';
import { cx, Dot, containerTone } from './ui';

export type PaletteItem = { id: string; group: string; label: string; hint?: string; keywords?: string; icon: ReactNode; run: () => void };
type JfHit = { id: string; name: string; type: string; year: number | null; seriesName: string | null; season: number | null; episode: number | null; serverId: string | null };

const GROUP_ORDER = ['Pagine', 'App', 'Azioni', 'Container', 'Titoli Jellyfin', 'Torrent', 'Media da rivedere'];
const PER_GROUP = 6;

function useDebounced<T>(v: T, ms: number) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

const openUrl = (url: string) => window.open(url, '_blank', 'noopener,noreferrer');

export function CommandPalette({ open, onClose, pages }: { open: boolean; onClose: () => void; pages: { to: string; label: string; icon: ReactNode; group: string }[] }) {
  const nav = useNavigate();
  const { isOperator } = useAuth();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const debounced = useDebounced(q.trim(), 250);

  const containers = useContainers();
  const launcher = useQuery({ queryKey: ['launcher'], queryFn: () => api<LauncherApp[]>('/launcher'), enabled: open, staleTime: 30_000 });
  const integrations = useIntegrations();
  const qb = byType(integrations.data, 'qbittorrent');
  const jf = byType(integrations.data, 'jellyfin');
  const torrents = useResource<{ hash: string; name: string; state: string }[]>(open ? qb : undefined, 'torrents', '', 30_000);
  const review = useQuery({
    queryKey: ['palette-media'],
    queryFn: () => api<{ id: string; fileName: string; status: string }[]>('/media/items?limit=500'),
    enabled: open,
    staleTime: 30_000,
    retry: 0,
  });
  const jfSearch = useQuery({
    queryKey: ['palette-jf', jf?.id, debounced],
    queryFn: ({ signal }) => api<JfHit[]>(`/integrations/${jf!.id}/resources/search?q=${encodeURIComponent(debounced)}`, { signal }),
    enabled: open && !!jf && jf.enabled && jf.status !== 'unconfigured' && debounced.length >= 2,
    staleTime: 60_000,
    retry: 0,
  });

  useEffect(() => {
    if (!open) return;
    setQ('');
    setActive(0);
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  const go = (to: string) => () => nav(to);
  const all = useMemo<PaletteItem[]>(() => {
    const out: PaletteItem[] = pages.map((p) => ({ id: `p:${p.to}`, group: 'Pagine', label: p.label, hint: p.group, icon: p.icon, run: go(p.to) }));
    for (const a of launcher.data ?? [])
      out.push({ id: `a:${a.id}`, group: 'App', label: a.name, hint: a.url.replace(/^https?:\/\//, ''), keywords: a.group, icon: <AppIcon app={a} size="sm" />, run: () => openUrl(a.url) });
    for (const c of containers.data ?? []) {
      out.push({
        id: `c:${c.name}`,
        group: 'Container',
        label: c.name,
        hint: c.image,
        keywords: c.composeProject ?? '',
        icon: <span className="flex size-7 items-center justify-center"><Dot tone={containerTone(c.state, c.health)} /></span>,
        run: go(`/docker?c=${encodeURIComponent(c.name)}`),
      });
      if (isOperator && c.controllable)
        out.push({
          id: `r:${c.name}`,
          group: 'Azioni',
          label: c.state === 'running' ? `Riavvia ${c.name}` : `Avvia ${c.name}`,
          hint: 'apre la conferma',
          keywords: c.state === 'running' ? 'restart riavvio' : 'start avvio',
          icon: <RotateCw className="size-4 text-muted" />,
          run: go(`/docker?c=${encodeURIComponent(c.name)}&a=${c.state === 'running' ? 'restart' : 'start'}`),
        });
    }
    for (const t of torrents.data ?? [])
      out.push({ id: `t:${t.hash}`, group: 'Torrent', label: t.name, hint: t.state, icon: <Download className="size-4 text-muted" />, run: go(`/download?q=${encodeURIComponent(t.name)}`) });
    for (const m of (review.data ?? []).filter((x) => ['review', 'ready', 'conflict', 'error'].includes(x.status)))
      out.push({ id: `m:${m.id}`, group: 'Media da rivedere', label: m.fileName, hint: m.status, icon: <Wand2 className="size-4 text-muted" />, run: go(`/media-automation?item=${m.id}`) });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, launcher.data, containers.data, torrents.data, review.data, isOperator]);

  const results = useMemo(() => {
    const query = q.trim();
    const scored = all
      .filter((i) => query || i.group === 'Pagine' || i.group === 'App')
      .map((i) => ({ i, s: query ? Math.max(fuzzyScore(query, i.label), i.keywords ? fuzzyScore(query, i.keywords) * 0.6 : 0) : 1 }))
      .filter((x) => x.s > 0);
    const byGroup = new Map<string, { i: PaletteItem; s: number }[]>();
    for (const x of scored) byGroup.set(x.i.group, [...(byGroup.get(x.i.group) ?? []), x]);
    if (query.length >= 2 && jf && jfSearch.data)
      byGroup.set(
        'Titoli Jellyfin',
        jfSearch.data.map((h) => ({
          s: 1,
          i: {
            id: `j:${h.id}`,
            group: 'Titoli Jellyfin',
            label: h.type === 'Episode' && h.seriesName ? `${h.seriesName} · ${h.season !== null ? `S${String(h.season).padStart(2, '0')}` : ''}E${String(h.episode ?? 0).padStart(2, '0')} ${h.name}` : h.name,
            hint: [h.type === 'Movie' ? 'film' : h.type === 'Series' ? 'serie' : 'episodio', h.year].filter(Boolean).join(' · '),
            icon: h.type === 'Movie' ? <Film className="size-4 text-muted" /> : <Clapperboard className="size-4 text-muted" />,
            run: () => openUrl(`${jf.webUrl.replace(/\/+$/, '')}/web/#/details?id=${h.id}${h.serverId ? `&serverId=${h.serverId}` : ''}`),
          },
        })),
      );
    return GROUP_ORDER.flatMap((g) =>
      (byGroup.get(g) ?? [])
        .sort((a, b) => b.s - a.s)
        .slice(0, query ? PER_GROUP : g === 'Pagine' ? 20 : 12)
        .map((x) => x.i),
    );
  }, [all, q, jf, jfSearch.data]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;
  const pick = (i: PaletteItem | undefined) => {
    if (!i) return;
    onClose();
    i.run();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(results.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(results.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(results[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };
  const searching = jfSearch.isFetching && debounced.length >= 2;
  let lastGroup = '';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-3 pt-[max(12px,env(safe-area-inset-top))] sm:pt-[12vh]" role="dialog" aria-modal="true" aria-label="Cerca in GIGI OS">
      <div className="absolute inset-0 bg-black/55" onClick={onClose} />
      <div className="relative flex max-h-[min(70vh,560px)] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-2xl">
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Search className="size-4 shrink-0 text-muted" aria-hidden />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Cerca pagine, app, container, torrent, film…"
            className="h-12 min-w-0 flex-1 bg-transparent text-[15px] placeholder:text-muted"
            // Il riquadro della palette indica già il focus; la regola globale *:focus-visible non è in un layer e vincerebbe sulle utility
            style={{ outline: 'none' }}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={results[active] ? `${listId}-${active}` : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
          />
          {searching && <Loader2 className="size-4 animate-spin text-muted" aria-label="Ricerca in corso" />}
          <kbd className="hidden rounded border border-line px-1.5 py-0.5 text-[10px] text-muted sm:block">Esc</kbd>
        </div>
        <div ref={listRef} id={listId} role="listbox" aria-label="Risultati" className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {results.length === 0 && <p className="px-3 py-6 text-center text-sm text-muted">{searching ? 'Cerco in Jellyfin…' : 'Nessun risultato'}</p>}
          {results.map((r, idx) => {
            const header = r.group !== lastGroup;
            lastGroup = r.group;
            return (
              <div key={r.id}>
                {header && <div className="px-2.5 pt-2.5 pb-1 text-[11px] font-medium tracking-wide text-muted uppercase" role="presentation">{r.group}</div>}
                <div
                  id={`${listId}-${idx}`}
                  data-index={idx}
                  role="option"
                  aria-selected={idx === active}
                  onMouseMove={() => setActive(idx)}
                  onClick={() => pick(r)}
                  className={cx('flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-1.5', idx === active ? 'bg-accent-soft' : '')}
                >
                  <span className="flex size-7 shrink-0 items-center justify-center [&>svg]:size-4">{r.icon}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px]">{r.label}</span>
                    {r.hint && <span className="block truncate text-[11px] text-muted">{r.hint}</span>}
                  </span>
                  {idx === active &&
                    (r.group === 'App' || r.group === 'Titoli Jellyfin' ? (
                      <ExternalLink className="size-3.5 shrink-0 text-muted" aria-hidden />
                    ) : (
                      <CornerDownLeft className="size-3.5 shrink-0 text-muted" aria-hidden />
                    ))}
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-3 border-t border-line px-3 py-2 text-[11px] text-muted">
          <span>
            <kbd className="font-sans">↑↓</kbd> scegli · <kbd className="font-sans">Invio</kbd> apri
          </span>
          {!jf && <span className="ml-auto">Collega Jellyfin per cercare i titoli</span>}
          {jf && <span className="ml-auto">I titoli Jellyfin compaiono da 2 lettere</span>}
        </div>
      </div>
    </div>
  );
}

/** Scorciatoie globali: Ctrl+K / Cmd+K ovunque, «/» quando non si sta scrivendo. */
export function usePaletteShortcut(open: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
      if ((e.key === 'k' || e.key === 'K') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        open();
      } else if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        open();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
}

