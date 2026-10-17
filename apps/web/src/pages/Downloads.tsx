import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Download,
  ExternalLink,
  FileUp,
  Gauge,
  Link2,
  Pause,
  Play,
  RefreshCw,
  Search,
  Settings2,
  Tag,
  Trash2,
  Upload,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Badge, Button, Card, cx, Dialog, Empty, ErrorBox, Field, Input, Meter, PageHeader, Select, Skeleton, Tabs, useToast, type Tone } from '../components/ui';
import { api, ApiError, type Integration } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ago, bytes, duration, eta, rate } from '../lib/format';
import { byType, useIntegrations, useResource } from '../lib/queries';
import { refreshLibraryViews } from './LibraryDelete';

type Torrent = {
  hash: string;
  name: string;
  state: string;
  progress: number;
  size: number;
  dlspeed: number;
  upspeed: number;
  eta: number;
  category: string;
  savePath: string;
  addedOn: number;
  completedOn: number | null;
  ratio: number;
  seeds: number;
  leechs: number;
  complete: boolean;
  uploaded: number | null;
  seedingTime: number | null;
  ratioLimit: number;
  seedingTimeLimit: number;
  stopped: boolean;
};
type MediaItem = { torrentHash: string; status: string };
type SearchResult = { name: string; url: string; size: number; seeders: number; leechers: number; engine: string; plugin: string | null; info: string | null; published: number | null };

const STATE: Record<string, [string, Tone]> = {
  downloading: ['Download', 'info'],
  forcedDL: ['Download forzato', 'info'],
  metaDL: ['Metadati', 'info'],
  forcedMetaDL: ['Metadati', 'info'],
  stalledDL: ['In stallo', 'warn'],
  uploading: ['Seeding', 'ok'],
  forcedUP: ['Seeding forzato', 'ok'],
  stalledUP: ['Seeding (nessun peer)', 'ok'],
  stoppedDL: ['Fermo', 'idle'],
  pausedDL: ['Fermo', 'idle'],
  stoppedUP: ['Completato · seeding fermo', 'idle'],
  pausedUP: ['Completato · seeding fermo', 'idle'],
  queuedDL: ['In coda', 'idle'],
  queuedUP: ['In coda (seed)', 'idle'],
  checkingDL: ['Verifica', 'info'],
  checkingUP: ['Verifica', 'info'],
  checkingResumeData: ['Verifica', 'info'],
  moving: ['Spostamento', 'info'],
  missingFiles: ['File mancanti', 'err'],
  error: ['Errore', 'err'],
};

const MEDIA: Record<string, [string, Tone]> = {
  indexed: ['In libreria', 'ok'],
  imported: ['Importato', 'accent'],
  ready: ['Pronto da importare', 'info'],
  review: ['Da rivedere', 'warn'],
  waiting: ['In analisi', 'idle'],
  conflict: ['Conflitto', 'err'],
  error: ['Errore import', 'err'],
};

type Tab = 'torrents' | 'search' | 'add' | 'seeding';

export function DownloadsPage() {
  const ints = useIntegrations();
  const qb = byType(ints.data, 'qbittorrent');
  const [tab, setTab] = useState<Tab>('torrents');
  const tr = useResource<{ dlSpeed: number; upSpeed: number; dlSession: number; upSession: number; connection: string }>(qb, 'transfer', '', 3_000);

  if (ints.isError) return <ErrorBox error={ints.error} />;
  if (!ints.data) return <Skeleton className="h-60" />;
  if (!qb || qb.status === 'unconfigured')
    return (
      <div>
        <PageHeader title="Download" />
        <Card>
          <Empty title="qBittorrent non è collegato" action={<Link to="/integrazioni?add=qbittorrent"><Button variant="primary" size="sm">Collega qBittorrent</Button></Link>} />
        </Card>
      </div>
    );

  return (
    <div>
      <PageHeader
        title="Download"
        description="Gestione di qBittorrent: torrent, ricerca, aggiunta e seeding. Le librerie non dipendono dal seeding: i file importati sono hardlink."
        actions={
          tr.data && (
            <div className="flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs">
              <span className="flex items-center gap-1 tabular">
                <ArrowDown className="size-3.5 text-info" /> {rate(tr.data.dlSpeed)}
              </span>
              <span className="flex items-center gap-1 tabular">
                <ArrowUp className="size-3.5 text-accent" /> {rate(tr.data.upSpeed)}
              </span>
              <Badge tone={tr.data.connection === 'connected' ? 'ok' : 'warn'}>{tr.data.connection === 'connected' ? 'connesso' : tr.data.connection}</Badge>
            </div>
          )
        }
      />
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { id: 'torrents', label: 'Torrent' },
          { id: 'search', label: 'Cerca' },
          { id: 'add', label: 'Aggiungi' },
          { id: 'seeding', label: 'Seeding' },
        ]}
      />
      <div className="mt-4">
        {tab === 'torrents' && <TorrentsTab qb={qb} />}
        {tab === 'search' && <SearchTab qb={qb} onAdded={() => setTab('torrents')} />}
        {tab === 'add' && <AddTab qb={qb} onAdded={() => setTab('torrents')} />}
        {tab === 'seeding' && <SeedingTab qb={qb} />}
      </div>
    </div>
  );
}

function useAction(qb: Integration) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, body }: { name: string; body: unknown }) => api<{ result: unknown }>(`/integrations/${qb.id}/actions/${name}`, { method: 'POST', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['resource', qb.id] });
      setTimeout(() => void qc.invalidateQueries({ queryKey: ['resource', qb.id] }), 1500);
    },
  });
}

function useCategories(qb: Integration) {
  return useResource<{ name: string; savePath: string }[]>(qb, 'categories', '', 60_000);
}

function TorrentsTab({ qb }: { qb: Integration }) {
  const { isOperator } = useAuth();
  const toast = useToast();
  const t = useResource<Torrent[]>(qb, 'torrents', '', 3_000);
  const media = useQuery({ queryKey: ['media-items'], queryFn: () => api<MediaItem[]>('/media/items?limit=1000'), refetchInterval: 15_000, retry: 0 });
  const act = useAction(qb);
  const [filter, setFilter] = useState('all');
  // Da Ctrl+K: /download?q=<nome> apre l'elenco già filtrato.
  const [params] = useSearchParams();
  const [q, setQ] = useState(() => params.get('q') ?? '');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<null | { kind: 'delete' | 'limits' | 'category'; hashes: string[] }>(null);

  const mediaByHash = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const i of media.data ?? []) m.set(i.torrentHash, [...(m.get(i.torrentHash) ?? []), i.status]);
    return m;
  }, [media.data]);

  const rows = useMemo(() => {
    let r = t.data ?? [];
    if (filter === 'downloading') r = r.filter((x) => !x.complete);
    else if (filter === 'seeding') r = r.filter((x) => x.complete && !x.stopped);
    else if (filter === 'stopped') r = r.filter((x) => x.stopped);
    else if (filter.startsWith('cat:')) r = r.filter((x) => x.category === filter.slice(4));
    if (q.trim()) r = r.filter((x) => x.name.toLowerCase().includes(q.trim().toLowerCase()));
    return r;
  }, [t.data, filter, q]);
  const cats = useMemo(() => [...new Set((t.data ?? []).map((x) => x.category).filter(Boolean))].sort(), [t.data]);

  const run = (name: string, body: Record<string, unknown>, ok: string) =>
    act.mutate({ name, body }, { onSuccess: () => toast('ok', ok), onError: (e) => toast('err', (e as Error).message) });

  const toggleAll = () => setSel((s) => (s.size === rows.length ? new Set() : new Set(rows.map((r) => r.hash))));
  const selected = [...sel].filter((h) => rows.some((r) => r.hash === h));

  if (t.isError) return <ErrorBox error={t.error} />;
  if (!t.data) return <Skeleton className="h-60" />;

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted" />
          <Input className="pl-8" placeholder="Cerca nei torrent…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Cerca nei torrent" />
        </div>
        <Select className="w-auto" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filtro">
          <option value="all">Tutti ({t.data.length})</option>
          <option value="downloading">In download</option>
          <option value="seeding">In seeding</option>
          <option value="stopped">Fermi</option>
          {cats.map((c) => (
            <option key={c} value={`cat:${c}`}>
              Categoria: {c}
            </option>
          ))}
        </Select>
        {isOperator && selected.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-accent/40 bg-accent-soft px-2 py-1">
            <span className="px-1 text-xs font-medium">{selected.length} selezionati</span>
            <Button size="sm" variant="ghost" onClick={() => run('control', { op: 'start', hashes: selected }, 'Avviati')}>
              <Play /> Avvia
            </Button>
            <Button size="sm" variant="ghost" onClick={() => run('control', { op: 'stop', hashes: selected }, 'Fermati')}>
              <Pause /> Ferma
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'limits', hashes: selected })}>
              <Gauge /> Limiti
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'category', hashes: selected })}>
              <Tag /> Categoria
            </Button>
            <Button size="sm" variant="ghost" className="text-err" onClick={() => setDialog({ kind: 'delete', hashes: selected })}>
              <Trash2 /> Elimina
            </Button>
          </div>
        )}
      </div>
      <Card bodyClassName="!p-0">
        {rows.length === 0 ? (
          <Empty icon={<Download />} title="Nessun torrent" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[920px] text-left text-[13px]">
              <thead className="border-b border-line text-xs text-muted">
                <tr>
                  {isOperator && (
                    <th className="w-10 py-2 pr-2 pl-4">
                      <input type="checkbox" className="size-4 [--check:var(--accent)]" checked={sel.size > 0 && selected.length === rows.length} onChange={toggleAll} aria-label="Seleziona tutti" />
                    </th>
                  )}
                  <th className={cx('py-2 font-medium', !isOperator && 'pl-4')}>Nome</th>
                  <th className="px-3 py-2 font-medium">Stato</th>
                  <th className="w-40 px-3 py-2 font-medium">Avanzamento</th>
                  <th className="px-3 py-2 text-right font-medium">Velocità</th>
                  <th className="px-3 py-2 text-right font-medium">Ratio · seed</th>
                  <th className="px-3 py-2 font-medium">Libreria</th>
                  {isOperator && <th className="px-4 py-2 text-right font-medium">Azioni</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((x) => {
                  const [label, tone] = STATE[x.state] ?? [x.state, 'idle'];
                  const m = mediaByHash.get(x.hash);
                  const best = m ? (['indexed', 'imported', 'ready', 'review', 'waiting', 'conflict', 'error'].find((s) => m.includes(s)) ?? null) : null;
                  const seeding = x.complete && !x.stopped;
                  return (
                    <tr key={x.hash} className={cx('border-b border-line/60 last:border-0', sel.has(x.hash) && 'bg-accent-soft/40')}>
                      {isOperator && (
                        <td className="py-2.5 pr-2 pl-4">
                          <input
                            type="checkbox"
                            className="size-4 [--check:var(--accent)]"
                            checked={sel.has(x.hash)}
                            onChange={() => setSel((s) => { const n = new Set(s); if (n.has(x.hash)) n.delete(x.hash); else n.add(x.hash); return n; })}
                            aria-label={`Seleziona ${x.name}`}
                          />
                        </td>
                      )}
                      <td className={cx('max-w-[340px] py-2.5', !isOperator && 'pl-4')}>
                        <div className="truncate font-medium" title={x.name}>{x.name}</div>
                        <div className="truncate text-[11px] text-muted">
                          {x.category ? <Badge className="mr-1">{x.category}</Badge> : <span className="mr-1">senza categoria ·</span>}
                          {bytes(x.size)} · aggiunto {ago(x.addedOn)}
                        </div>
                      </td>
                      <td className="px-3">
                        <Badge tone={tone}>{label}</Badge>
                      </td>
                      <td className="px-3">
                        <div className="mb-1 flex justify-between text-[11px] text-muted tabular">
                          <span>{Math.floor(x.progress * 1000) / 10}%</span>
                          {!x.complete && !x.stopped && <span>{eta(x.eta)}</span>}
                        </div>
                        <Meter value={x.progress * 100} tone={x.complete ? 'ok' : 'info'} label={x.name} />
                      </td>
                      <td className={cx('px-3 text-right text-xs tabular', x.dlspeed + x.upspeed === 0 && 'text-muted')}>
                        ↓ {rate(x.dlspeed)}
                        <br />↑ {rate(x.upspeed)}
                      </td>
                      <td className="px-3 text-right text-xs tabular">
                        <div>{x.ratio.toFixed(2)}{x.ratioLimit >= 0 && <span className="text-muted"> / {x.ratioLimit}</span>}</div>
                        <div className="text-muted">
                          {x.seedingTime ? duration(x.seedingTime) : '—'}
                          {x.seedingTimeLimit >= 0 && ` / ${duration(x.seedingTimeLimit * 60)}`}
                        </div>
                      </td>
                      <td className="px-3">{best ? <Badge tone={MEDIA[best][1]}>{MEDIA[best][0]}</Badge> : <span className="text-xs text-muted">—</span>}</td>
                      {isOperator && (
                        <td className="px-4 text-right whitespace-nowrap">
                          {x.complete ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              title={seeding ? 'Ferma il seeding (i file restano)' : 'Riprendi il seeding'}
                              onClick={() => run('control', { op: seeding ? 'stop' : 'start', hashes: [x.hash] }, seeding ? 'Seeding fermato' : 'Seeding ripreso')}
                            >
                              {seeding ? <Pause /> : <Upload />} {seeding ? 'Ferma seed' : 'Seed'}
                            </Button>
                          ) : (
                            <Button size="sm" variant="ghost" onClick={() => run('control', { op: x.stopped ? 'start' : 'stop', hashes: [x.hash] }, x.stopped ? 'Avviato' : 'Fermato')}>
                              {x.stopped ? <Play /> : <Pause />} {x.stopped ? 'Avvia' : 'Ferma'}
                            </Button>
                          )}
                          <Button size="icon" variant="ghost" aria-label="Limiti di condivisione" title="Limiti di condivisione" onClick={() => setDialog({ kind: 'limits', hashes: [x.hash] })}>
                            <Gauge />
                          </Button>
                          <Button size="icon" variant="ghost" aria-label="Ricontrolla i file" title="Ricontrolla i file" onClick={() => run('control', { op: 'recheck', hashes: [x.hash] }, 'Verifica avviata')}>
                            <RefreshCw />
                          </Button>
                          <Button size="icon" variant="ghost" aria-label="Elimina" title="Elimina" className="hover:text-err" onClick={() => setDialog({ kind: 'delete', hashes: [x.hash] })}>
                            <Trash2 />
                          </Button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {dialog?.kind === 'delete' && <DeleteDialog qb={qb} torrents={t.data.filter((x) => dialog.hashes.includes(x.hash))} onClose={() => { setDialog(null); setSel(new Set()); }} />}
      {dialog?.kind === 'limits' && <LimitsDialog qb={qb} torrents={t.data.filter((x) => dialog.hashes.includes(x.hash))} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'category' && <CategoryDialog qb={qb} hashes={dialog.hashes} onClose={() => { setDialog(null); setSel(new Set()); }} />}
    </>
  );
}

function DeleteDialog({ qb, torrents, onClose }: { qb: Integration; torrents: Torrent[]; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const act = useAction(qb);
  // Gli operatori rimuovono solo il torrent: eliminare file o libreria resta agli admin (D-028).
  const { isAdmin } = useAuth();
  const [mode, setMode] = useState<'everywhere' | 'files' | 'torrent'>(isAdmin ? 'everywhere' : 'torrent');
  const [typed, setTyped] = useState('');
  const [blocked, setBlocked] = useState<string[] | null>(null);
  const [force, setForce] = useState(false);
  const hashes = torrents.map((t) => t.hash);
  // Anteprima: quali copie in libreria (stesso inode) spariranno con «Elimina ovunque»
  const preview = useQuery({
    queryKey: ['purge-plan', hashes.join(',')],
    queryFn: () => api<{ torrents: { hash: string; name: string; library: { path: string; size: number }[] }[] }>('/downloads/purge-plan', { method: 'POST', body: { hashes } }),
    enabled: isAdmin && mode !== 'torrent',
    retry: false,
  });
  const libCopies = preview.data?.torrents.flatMap((t) => t.library) ?? [];
  const purge = useMutation({
    mutationFn: () =>
      api<{ torrentsDeleted: boolean; torrentError: string | null; libraryRemoved: string[]; skipped: { path: string; reason: string }[]; jellyfin: 'removed' | 'pending' | 'unconfigured' | 'unchanged' }>('/downloads/purge', {
        method: 'POST',
        body: { hashes, confirm: typed },
      }),
    onSuccess: (r) => {
      refreshLibraryViews(qc);
      if (r.torrentError) toast('err', `Libreria ripulita, ma qBittorrent: ${r.torrentError}`);
      else
        toast(
          'ok',
          `Eliminato ovunque: ${torrents.length} torrent, ${r.libraryRemoved.length} file dalla libreria${r.skipped.length ? ` (${r.skipped.length} non toccati)` : ''}${
            r.jellyfin === 'removed' ? '; sparito da Jellyfin e Apollo' : r.jellyfin === 'pending' ? '; Jellyfin sta aggiornando la libreria' : ''
          }`,
        );
      onClose();
    },
    onError: (e: Error) => toast('err', e.message),
  });
  const submit = () => {
    if (mode === 'everywhere') return purge.mutate();
    act.mutate(
      { name: 'delete', body: { hashes, deleteFiles: mode === 'files', force: blocked ? force : false } },
      {
        onSuccess: () => {
          toast('ok', mode === 'files' ? 'Torrent e file scaricati eliminati (la libreria resta)' : 'Torrent rimossi da qBittorrent (file conservati)');
          onClose();
        },
        onError: (e) => {
          const b = (e as ApiError).body as { code?: string; files?: string[] } | undefined;
          if (b?.code === 'not_imported') setBlocked(b.files ?? []);
          else toast('err', (e as Error).message);
        },
      },
    );
  };
  const options: [typeof mode, string, string][] = [
    ['everywhere', 'Elimina ovunque', 'Torrent, file scaricati e le loro copie in libreria: spariscono anche da Jellyfin e Apollo e lo spazio si libera.'] as [typeof mode, string, string],
    ['files', 'Elimina torrent e file scaricati', 'La copia in libreria resta: il titolo rimane in Jellyfin e Apollo.'] as [typeof mode, string, string],
    ['torrent', 'Rimuovi solo da qBittorrent', isAdmin ? 'Tutti i file restano dove sono.' : 'Tutti i file restano dove sono. Le eliminazioni dei file sono riservate agli amministratori.'] as [typeof mode, string, string],
  ].filter(([m]) => isAdmin || m === 'torrent');
  const pending = act.isPending || purge.isPending;
  return (
    <Dialog
      open
      onClose={onClose}
      title={torrents.length === 1 ? 'Eliminare il torrent?' : `Eliminare ${torrents.length} torrent?`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Annulla</Button>
          <Button variant="danger" onClick={submit} loading={pending} disabled={(mode === 'everywhere' && typed !== 'ELIMINA') || (!!blocked && !force)}>
            <Trash2 /> {mode === 'everywhere' ? 'Elimina ovunque' : 'Elimina'}
          </Button>
        </>
      }
    >
      <ul className="mb-3 max-h-28 space-y-0.5 overflow-y-auto text-xs">
        {torrents.map((t) => <li key={t.hash} className="truncate text-fg-2">• {t.name}</li>)}
      </ul>
      <div role="radiogroup" aria-label="Cosa eliminare" className="space-y-2">
        {options.map(([id, label, help]) => (
          <label key={id} className={cx('flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 text-[13px]', mode === id ? 'border-err/50 bg-err-soft/40' : 'border-line hover:border-line-strong')}>
            <input type="radio" name="delete-mode" className="mt-0.5 size-4 [--check:var(--err)]" checked={mode === id} onChange={() => { setMode(id); setBlocked(null); setForce(false); }} />
            <span>
              <span className="font-medium">{label}</span>
              <span className="block text-xs text-muted">{help}</span>
            </span>
          </label>
        ))}
      </div>
      {mode === 'files' && libCopies.length > 0 && (
        <div className="mt-3 rounded-lg border border-warn/30 bg-warn-soft px-3 py-2 text-xs text-warn">
          <span className="font-medium">Il titolo resta in Jellyfin e Apollo:</span> {libCopies.length === 1 ? '1 copia in libreria' : `${libCopies.length} copie in libreria`} ({bytes(libCopies.reduce((n, l) => n + l.size, 0))}) non {libCopies.length === 1 ? 'viene toccata' : 'vengono toccate'}. Per toglierlo scegli «Elimina ovunque».
        </div>
      )}
      {mode === 'everywhere' && (
        <div className="mt-3 rounded-lg border border-line bg-surface-2 px-3 py-2 text-xs">
          {preview.isPending && <span className="text-muted">Cerco le copie in libreria…</span>}
          {preview.isError && <span className="text-warn">Impossibile controllare la libreria: {(preview.error as Error).message}</span>}
          {preview.data && libCopies.length === 0 && (
            <span className="text-fg-2">
              <span className="font-medium">Nessuna copia in libreria.</span> Questo torrent non è nella libreria di Jellyfin: lì non cambia niente. Per togliere un titolo già in libreria usa Media → «Elimina dalla libreria».
            </span>
          )}
          {libCopies.length > 0 && (
            <>
              <div className="font-medium text-fg-2">In libreria spariranno anche da Jellyfin e Apollo ({bytes(libCopies.reduce((n, l) => n + l.size, 0))}):</div>
              <ul className="mt-1 max-h-24 space-y-0.5 overflow-y-auto text-muted">
                {libCopies.map((l) => <li key={l.path} className="truncate" title={l.path}>• {l.path.split('/').slice(-2).join('/')}</li>)}
              </ul>
            </>
          )}
        </div>
      )}
      {mode === 'everywhere' && (
        <div className="mt-3">
          <Field label="Operazione definitiva: per confermare scrivi ELIMINA" help="Vengono eliminati solo i file di libreria che sono lo stesso file del torrent (stesso inode).">
            {(id) => <Input id={id} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />}
          </Field>
        </div>
      )}
      {blocked && (
        <div className="mt-3 rounded-lg border border-err/30 bg-err-soft p-3 text-xs text-err">
          <p className="font-medium">Questi file non sono ancora nella libreria e verrebbero persi:</p>
          <ul className="mt-1 space-y-0.5">{blocked.map((f) => <li key={f} className="truncate">• {f}</li>)}</ul>
          <label className="mt-2 flex items-center gap-2 text-fg">
            <input type="checkbox" className="size-4 [--check:var(--err)]" checked={force} onChange={(e) => setForce(e.target.checked)} />
            Ho capito, elimina comunque
          </label>
        </div>
      )}
    </Dialog>
  );
}

function LimitsDialog({ qb, torrents, onClose }: { qb: Integration; torrents: Torrent[]; onClose: () => void }) {
  const toast = useToast();
  const act = useAction(qb);
  const first = torrents[0];
  const mode = (v: number) => (v === -2 ? 'global' : v === -1 ? 'none' : 'custom');
  const [rMode, setRMode] = useState(mode(first?.ratioLimit ?? -2));
  const [ratio, setRatio] = useState(String(first && first.ratioLimit >= 0 ? first.ratioLimit : 2));
  const [tMode, setTMode] = useState(mode(first?.seedingTimeLimit ?? -2));
  const [hours, setHours] = useState(String(first && first.seedingTimeLimit >= 0 ? Math.round(first.seedingTimeLimit / 60) : 72));
  const submit = () =>
    act.mutate(
      {
        name: 'shareLimits',
        body: {
          hashes: torrents.map((t) => t.hash),
          ratio: rMode === 'global' ? -2 : rMode === 'none' ? -1 : Number(ratio),
          minutes: tMode === 'global' ? -2 : tMode === 'none' ? -1 : Math.round(Number(hours) * 60),
        },
      },
      { onSuccess: () => { toast('ok', 'Limiti aggiornati'); onClose(); }, onError: (e) => toast('err', (e as Error).message) },
    );
  return (
    <Dialog
      open
      onClose={onClose}
      title="Limiti di condivisione"
      description={torrents.length === 1 ? first?.name : `${torrents.length} torrent selezionati`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Annulla</Button>
          <Button variant="primary" onClick={submit} loading={act.isPending}>Salva</Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Ratio">
            {(id) => (
              <Select id={id} value={rMode} onChange={(e) => setRMode(e.target.value)}>
                <option value="global">Come impostazione globale</option>
                <option value="none">Nessun limite</option>
                <option value="custom">Ferma a ratio…</option>
              </Select>
            )}
          </Field>
          <Field label="Valore">{(id) => <Input id={id} inputMode="decimal" value={ratio} onChange={(e) => setRatio(e.target.value)} disabled={rMode !== 'custom'} />}</Field>
          <Field label="Tempo di seeding">
            {(id) => (
              <Select id={id} value={tMode} onChange={(e) => setTMode(e.target.value)}>
                <option value="global">Come impostazione globale</option>
                <option value="none">Nessun limite</option>
                <option value="custom">Ferma dopo ore…</option>
              </Select>
            )}
          </Field>
          <Field label="Ore">{(id) => <Input id={id} inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value)} disabled={tMode !== 'custom'} />}</Field>
        </div>
        <p className="text-xs text-muted">Al raggiungimento del limite qBittorrent ferma il torrent secondo l’azione globale (in GIGI OS impostata su «ferma», mai «rimuovi»).</p>
      </div>
    </Dialog>
  );
}

function CategoryDialog({ qb, hashes, onClose }: { qb: Integration; hashes: string[]; onClose: () => void }) {
  const toast = useToast();
  const act = useAction(qb);
  const cats = useCategories(qb);
  const [cat, setCat] = useState('');
  return (
    <Dialog
      open
      onClose={onClose}
      title="Cambia categoria"
      description="La categoria guida la libreria di destinazione proposta dal motore media. qBittorrent può spostare i file nella cartella della categoria."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Annulla</Button>
          <Button
            variant="primary"
            loading={act.isPending}
            onClick={() => act.mutate({ name: 'setCategory', body: { hashes, category: cat } }, { onSuccess: () => { toast('ok', 'Categoria aggiornata'); onClose(); }, onError: (e) => toast('err', (e as Error).message) })}
          >
            Applica
          </Button>
        </>
      }
    >
      <Field label="Categoria">
        {(id) => (
          <Select id={id} value={cat} onChange={(e) => setCat(e.target.value)}>
            <option value="">Nessuna</option>
            {cats.data?.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
    </Dialog>
  );
}

const SEARCH_CATS: [string, string, string][] = [
  ['all', 'Tutto', ''],
  ['anime', 'Anime', 'Anime'],
  ['movies', 'Film', 'Film'],
  ['tv', 'Serie TV', 'Serie TV'],
  ['music', 'Musica', ''],
  ['software', 'Software', ''],
  ['books', 'Libri', ''],
];

function SearchTab({ qb, onAdded }: { qb: Integration; onAdded: () => void }) {
  const { isOperator } = useAuth();
  const toast = useToast();
  const plugins = useResource<{ name: string; fullName: string; enabled: boolean }[]>(qb, 'plugins', '', 300_000);
  const cats = useCategories(qb);
  const act = useAction(qb);
  const [pattern, setPattern] = useState('');
  const [category, setCategory] = useState('all');
  const [minSeeds, setMinSeeds] = useState(1);
  const [state, setState] = useState<{ id: number | null; status: string; results: SearchResult[]; total: number; error: string | null }>({ id: null, status: 'idle', results: [], total: 0, error: null });
  const [pick, setPick] = useState<SearchResult | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const searchIdRef = useRef<number | null>(null);

  const stop = (id: number | null) => {
    clearTimeout(timer.current);
    if (id !== null) void api(`/integrations/${qb.id}/actions/searchStop`, { method: 'POST', body: { id } }).catch(() => undefined);
  };
  useEffect(() => () => stop(searchIdRef.current), []); // eslint-disable-line react-hooks/exhaustive-deps

  const poll = (id: number, started: number) => {
    timer.current = setTimeout(async () => {
      try {
        const r = await api<{ result: { status: string; total: number; results: SearchResult[] } }>(`/integrations/${qb.id}/actions/searchResults`, { method: 'POST', body: { id } });
        const done = r.result.status === 'Stopped' || Date.now() - started > 45_000;
        setState((s) => (s.id === id ? { ...s, status: done ? 'done' : 'running', results: r.result.results, total: r.result.total } : s));
        if (!done) poll(id, started);
        else stop(id);
      } catch (e) {
        setState((s) => ({ ...s, status: 'done', error: (e as Error).message }));
      }
    }, 1200);
  };

  const start = async () => {
    stop(state.id);
    setState({ id: null, status: 'starting', results: [], total: 0, error: null });
    try {
      const r = await api<{ result: { id: number } }>(`/integrations/${qb.id}/actions/searchStart`, { method: 'POST', body: { pattern, category } });
      searchIdRef.current = r.result.id;
      setState({ id: r.result.id, status: 'running', results: [], total: 0, error: null });
      poll(r.result.id, Date.now());
    } catch (e) {
      setState({ id: null, status: 'idle', results: [], total: 0, error: (e as Error).message });
    }
  };

  const enabled = plugins.data?.filter((p) => p.enabled) ?? [];
  const shown = state.results.filter((r) => r.seeders >= minSeeds);
  const defaultCat = SEARCH_CATS.find((c) => c[0] === category)?.[2] ?? '';

  if (!isOperator) return <Card><Empty title="La ricerca è riservata a operatori e amministratori" /></Card>;

  return (
    <div className="space-y-4">
      <Card>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
        >
          <div className="min-w-56 flex-1">
            <Field label="Cerca">{(id) => <Input id={id} value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="Titolo, episodio, anno…" autoFocus />}</Field>
          </div>
          <div className="w-40">
            <Field label="Categoria">
              {(id) => (
                <Select id={id} value={category} onChange={(e) => setCategory(e.target.value)}>
                  {SEARCH_CATS.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <Button type="submit" variant="primary" loading={state.status === 'starting' || state.status === 'running'} disabled={pattern.trim().length < 2}>
            <Search /> Cerca
          </Button>
        </form>
        <p className="mt-3 text-xs text-muted">
          Ricerca tramite il motore di qBittorrent con i plugin installati ({enabled.map((p) => p.fullName).join(', ') || '—'}). Usala solo per contenuti che hai il diritto di scaricare.
        </p>
      </Card>

      {state.error && <ErrorBox error={{ message: state.error }} />}
      {state.status !== 'idle' && (
        <Card
          bodyClassName="!p-0"
          title={state.status === 'running' || state.status === 'starting' ? `Ricerca in corso… ${state.results.length} risultati` : `${shown.length} risultati`}
          actions={
            <label className="flex items-center gap-2 text-xs text-muted">
              Seeder minimi
              <Select className="h-7 w-auto text-xs" value={minSeeds} onChange={(e) => setMinSeeds(Number(e.target.value))}>
                {[0, 1, 5, 20, 100].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </label>
          }
        >
          {shown.length === 0 ? (
            <Empty icon={<Search />} title={state.status === 'done' ? 'Nessun risultato' : 'In attesa dei risultati…'} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-[13px]">
                <thead className="border-y border-line text-xs text-muted">
                  <tr>
                    <th className="px-4 py-2 font-medium">Nome</th>
                    <th className="px-3 py-2 text-right font-medium">Dimensione</th>
                    <th className="px-3 py-2 text-right font-medium">Seed / leech</th>
                    <th className="px-3 py-2 font-medium">Fonte</th>
                    <th className="px-4 py-2 text-right font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {shown.slice(0, 200).map((r, i) => (
                    <tr key={`${r.url}-${i}`} className="border-b border-line/60 last:border-0">
                      <td className="max-w-[440px] px-4 py-2">
                        <div className="truncate font-medium" title={r.name}>{r.name}</div>
                        {r.published && <div className="text-[11px] text-muted">pubblicato {ago(r.published)}</div>}
                      </td>
                      <td className="px-3 text-right tabular">{r.size > 0 ? bytes(r.size) : '—'}</td>
                      <td className="px-3 text-right tabular">
                        <span className={cx(r.seeders >= 20 ? 'text-ok' : r.seeders >= 5 ? 'text-fg' : 'text-warn')}>{r.seeders}</span>
                        <span className="text-muted"> / {r.leechers}</span>
                      </td>
                      <td className="px-3 text-xs text-muted">
                        {r.info ? (
                          <a href={r.info} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 hover:text-fg">
                            {r.engine} <ExternalLink className="size-3" />
                          </a>
                        ) : (
                          r.engine
                        )}
                      </td>
                      <td className="px-4 text-right">
                        <Button size="sm" onClick={() => setPick(r)}>
                          <Download /> Scarica
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
      {pick && (
        <AddConfirm
          qb={qb}
          title={pick.name}
          detail={`${pick.size > 0 ? bytes(pick.size) : 'dimensione sconosciuta'} · ${pick.seeders} seeder · ${pick.engine}`}
          categories={cats.data ?? []}
          defaultCategory={defaultCat}
          body={{ urls: [pick.url], ...(pick.plugin ? { plugin: pick.plugin } : {}) }}
          onClose={() => setPick(null)}
          onDone={() => {
            setPick(null);
            toast('ok', 'Aggiunto a qBittorrent');
            onAdded();
          }}
          pending={act.isPending}
        />
      )}
    </div>
  );
}

function AddConfirm({
  qb,
  title,
  detail,
  categories,
  defaultCategory,
  body,
  onClose,
  onDone,
}: {
  qb: Integration;
  title: string;
  detail: string;
  categories: { name: string; savePath: string }[];
  defaultCategory: string;
  body: Record<string, unknown>;
  onClose: () => void;
  onDone: () => void;
  pending?: boolean;
}) {
  const act = useAction(qb);
  const [cat, setCat] = useState(defaultCategory);
  const [stopped, setStopped] = useState(false);
  return (
    <Dialog
      open
      onClose={onClose}
      title="Aggiungere a qBittorrent?"
      description={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Annulla</Button>
          <Button variant="primary" loading={act.isPending} onClick={() => act.mutate({ name: 'add', body: { ...body, category: cat, stopped } }, { onSuccess: onDone })}>
            <Download /> {act.isPending ? 'Verifica in corso…' : 'Aggiungi'}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-xs text-muted">{detail}</p>
      <p className="mb-3 text-[11px] text-muted">GIGI OS conferma l’aggiunta solo quando il torrent compare davvero in qBittorrent (fino a 20 secondi).</p>
      <div className="space-y-3">
        <Field label="Categoria" help={cat ? `Salvato in ${categories.find((c) => c.name === cat)?.savePath ?? '—'}` : 'Senza categoria il motore media deduce il tipo dal nome.'}>
          {(id) => (
            <Select id={id} value={cat} onChange={(e) => setCat(e.target.value)}>
              <option value="">Nessuna</option>
              {categories.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" className="size-4 [--check:var(--accent)]" checked={stopped} onChange={(e) => setStopped(e.target.checked)} />
          Aggiungi fermo (avvio manuale)
        </label>
        {act.isError && <ErrorBox error={act.error} compact />}
      </div>
    </Dialog>
  );
}

function AddTab({ qb, onAdded }: { qb: Integration; onAdded: () => void }) {
  const { isOperator } = useAuth();
  const toast = useToast();
  const cats = useCategories(qb);
  const act = useAction(qb);
  const [links, setLinks] = useState('');
  const [file, setFile] = useState<{ name: string; b64: string } | null>(null);
  const [cat, setCat] = useState('');
  const [stopped, setStopped] = useState(false);

  if (!isOperator) return <Card><Empty title="Riservato a operatori e amministratori" /></Card>;

  const onFile = (f: File | undefined) => {
    if (!f) return setFile(null);
    if (f.size > 4 * 1024 * 1024) return toast('err', 'File .torrent troppo grande (max 4 MB)');
    const reader = new FileReader();
    reader.onload = () => setFile({ name: f.name, b64: String(reader.result).split(',')[1] ?? '' });
    reader.readAsDataURL(f);
  };
  const urls = links.split('\n').map((l) => l.trim()).filter(Boolean);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Link magnet o URL" icon={<Link2 />}>
        <textarea
          className="h-36 w-full rounded-lg border border-line-strong bg-bg-2 p-3 font-mono text-xs text-fg placeholder:text-muted focus:border-accent focus:outline-none"
          placeholder={'magnet:?xt=urn:btih:…\nUn link per riga (max 20)'}
          value={links}
          onChange={(e) => setLinks(e.target.value)}
          aria-label="Link magnet"
          spellCheck={false}
        />
      </Card>
      <Card title="File .torrent" icon={<FileUp />}>
        <label className="flex h-36 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line-strong bg-bg-2 text-xs text-muted hover:border-accent">
          <FileUp className="size-6" />
          {file ? <span className="text-fg-2">{file.name}</span> : <span>Scegli un file .torrent</span>}
          <input type="file" accept=".torrent,application/x-bittorrent" className="sr-only" onChange={(e) => onFile(e.target.files?.[0])} />
        </label>
      </Card>
      <Card className="lg:col-span-2">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-56">
            <Field label="Categoria">
              {(id) => (
                <Select id={id} value={cat} onChange={(e) => setCat(e.target.value)}>
                  <option value="">Nessuna</option>
                  {cats.data?.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <label className="flex h-9 items-center gap-2 text-[13px]">
            <input type="checkbox" className="size-4 [--check:var(--accent)]" checked={stopped} onChange={(e) => setStopped(e.target.checked)} />
            Aggiungi fermo
          </label>
          <Button
            variant="primary"
            className="ml-auto"
            disabled={!urls.length && !file}
            loading={act.isPending}
            onClick={() =>
              act.mutate(
                { name: 'add', body: { urls, ...(file ? { torrentBase64: file.b64, fileName: file.name } : {}), category: cat, stopped } },
                {
                  onSuccess: () => {
                    toast('ok', 'Aggiunto a qBittorrent');
                    setLinks('');
                    setFile(null);
                    onAdded();
                  },
                  onError: (e) => toast('err', (e as Error).message),
                },
              )
            }
          >
            <Download /> Aggiungi
          </Button>
        </div>
      </Card>
    </div>
  );
}

function SeedingTab({ qb }: { qb: Integration }) {
  const { isAdmin } = useAuth();
  const toast = useToast();
  const s = useResource<{ ratioEnabled: boolean; ratio: number; timeEnabled: boolean; minutes: number; action: number; upLimit: number }>(qb, 'seeding', '', 60_000);
  const act = useAction(qb);
  const [form, setForm] = useState<{ ratioEnabled: boolean; ratio: string; timeEnabled: boolean; hours: string } | null>(null);
  useEffect(() => {
    if (s.data && !form)
      setForm({
        ratioEnabled: s.data.ratioEnabled,
        ratio: String(s.data.ratio > 0 ? s.data.ratio : 2),
        timeEnabled: s.data.timeEnabled,
        hours: String(s.data.minutes > 0 ? Math.round(s.data.minutes / 60) : 168),
      });
  }, [s.data, form]);
  if (s.isError) return <ErrorBox error={s.error} />;
  if (!s.data || !form) return <Skeleton className="h-40" />;
  const ACTIONS = ['ferma il torrent', 'rimuove il torrent', 'attiva il super seeding', 'rimuove torrent e file'];
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Limiti globali di seeding" icon={<Settings2 />}>
        <div className="space-y-4">
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" className="size-4 [--check:var(--accent)]" disabled={!isAdmin} checked={form.ratioEnabled} onChange={(e) => setForm({ ...form, ratioEnabled: e.target.checked })} />
            Ferma al raggiungimento del ratio
            <Input className="ml-auto w-24" inputMode="decimal" value={form.ratio} disabled={!isAdmin || !form.ratioEnabled} onChange={(e) => setForm({ ...form, ratio: e.target.value })} aria-label="Ratio" />
          </label>
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" className="size-4 [--check:var(--accent)]" disabled={!isAdmin} checked={form.timeEnabled} onChange={(e) => setForm({ ...form, timeEnabled: e.target.checked })} />
            Ferma dopo ore di seeding
            <Input className="ml-auto w-24" inputMode="numeric" value={form.hours} disabled={!isAdmin || !form.timeEnabled} onChange={(e) => setForm({ ...form, hours: e.target.value })} aria-label="Ore" />
          </label>
          {isAdmin && (
            <Button
              variant="primary"
              loading={act.isPending}
              onClick={() =>
                act.mutate(
                  { name: 'seedingPrefs', body: { ratioEnabled: form.ratioEnabled, ratio: Number(form.ratio), timeEnabled: form.timeEnabled, minutes: Math.round(Number(form.hours) * 60) } },
                  { onSuccess: () => toast('ok', 'Limiti di seeding aggiornati'), onError: (e) => toast('err', (e as Error).message) },
                )
              }
            >
              Salva
            </Button>
          )}
        </div>
      </Card>
      <Card title="Come funziona">
        <ul className="space-y-2 text-xs text-muted">
          <li className="flex gap-2">
            <CheckCircle2 className="size-4 shrink-0 text-ok" />
            <span>Fermare il seeding non tocca la libreria: i file importati sono hardlink e restano disponibili in Jellyfin e Apollo.</span>
          </li>
          <li className="flex gap-2">
            <CheckCircle2 className="size-4 shrink-0 text-ok" />
            <span>Al raggiungimento di un limite il torrent viene <b className="text-fg-2">fermato</b>. Salvando da qui, l’azione è sempre «ferma», mai rimozione automatica.</span>
          </li>
          <li className="flex gap-2">
            <CheckCircle2 className="size-4 shrink-0 text-ok" />
            <span>Ogni torrent può avere limiti propri (icona <Gauge className="inline size-3.5 align-[-2px]" /> nella tabella), che prevalgono su quelli globali.</span>
          </li>
          <li>Azione attualmente configurata in qBittorrent: <b className="text-fg-2">{ACTIONS[s.data.action] ?? `codice ${s.data.action}`}</b>.</li>
        </ul>
        {s.data.action !== 0 && <p className="mt-3 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">L’azione attuale non è «ferma»: salvando i limiti da qui verrà impostata su «ferma».</p>}
      </Card>
    </div>
  );
}
