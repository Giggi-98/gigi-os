import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clapperboard,
  Clock,
  EyeOff,
  FileVideo,
  FolderTree,
  Link2,
  Pencil,
  RefreshCw,
  RotateCcw,
  ScanSearch,
  Trash2,
  Tv,
  Wand2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Badge,
  Button,
  Card,
  cx,
  Dialog,
  Empty,
  ErrorBox,
  Field,
  Input,
  Kv,
  Meter,
  PageHeader,
  Select,
  Skeleton,
  Tabs,
  useToast,
  type Tone,
} from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ago, bytes, dateTime } from '../lib/format';

type Reason = { delta: number; text: string };
type Plan = {
  library: string;
  libraryRoot: string;
  kind: 'movie' | 'episode';
  anime: boolean;
  name: string;
  year: number | null;
  season: number | null;
  episodes: number[];
  folder: string;
  dest: string;
  existingFolder: boolean;
  matched: { name: string; year: number | null; source: string; ids: Record<string, string> } | null;
  subtitles: { src: string; dest: string }[];
};
type Item = {
  id: string;
  torrentName: string;
  category: string | null;
  fileName: string;
  relPath: string;
  srcPath: string;
  size: number;
  status: string;
  kind: string | null;
  anime: boolean;
  confidence: number | null;
  reasons: Reason[];
  parsed: { title: string; year: number | null; season: number | null; episodes: number[]; group: string | null; resolution: string | null; notes: string[]; animeSignals: string[]; absolute: boolean; special: string | null } | null;
  probe: {
    ok: boolean;
    error?: string;
    duration: number | null;
    video: { codec: string; width: number; height: number; hdr: boolean } | null;
    audio: { codec: string; lang: string | null; channels: number | null }[];
    subtitles: { codec: string; lang: string | null; forced: boolean }[];
    embeddedTitle: string | null;
  } | null;
  match: { local: { name: string; year: number | null; source: string }[]; remote: { name: string; year: number | null; source: string; ids: Record<string, string> }[] } | null;
  plan: Plan | null;
  libraryLabel: string | null;
  override: Record<string, unknown> | null;
  error: string | null;
  jellyfin: { id: string; name: string } | null;
  firstSeen: number;
  importedAt: number | null;
  indexedAt: number | null;
  updatedAt: number;
  history?: { ts: number; actor: string; action: string; details: string | null }[];
};
type Summary = {
  counts: Record<string, number>;
  settings: { autoImport: boolean; threshold: number; lastScan: number | null };
  busy: boolean;
  libraryCheck: { key: string; label: string; path: string; exists: boolean; writable: boolean; dev: number | null }[];
  sources: { qbittorrent: boolean; jellyfin: boolean; qbtPathMap: { from: string; to: string }[]; jfPathMap: { host: string; jf: string }[] };
};

const STATUS: Record<string, { label: string; tone: Tone }> = {
  waiting: { label: 'In attesa', tone: 'idle' },
  review: { label: 'Da rivedere', tone: 'warn' },
  ready: { label: 'Pronto', tone: 'info' },
  conflict: { label: 'Conflitto', tone: 'err' },
  importing: { label: 'Importazione…', tone: 'info' },
  imported: { label: 'Importato', tone: 'accent' },
  indexed: { label: 'In libreria', tone: 'ok' },
  ignored: { label: 'Ignorato', tone: 'idle' },
  error: { label: 'Errore', tone: 'err' },
  missing: { label: 'File mancante', tone: 'err' },
  removed: { label: 'Eliminato', tone: 'idle' },
};

const GROUPS = {
  todo: ['review', 'ready', 'conflict', 'error', 'missing'],
  waiting: ['waiting', 'importing'],
  done: ['imported', 'indexed'],
  ignored: ['ignored', 'removed'],
} as const;
type Group = keyof typeof GROUPS;

const confTone = (c: number | null, threshold: number): Tone => (c === null ? 'idle' : c >= threshold ? 'ok' : c >= 60 ? 'warn' : 'err');

function shortDest(p: Plan | null) {
  if (!p) return '—';
  return p.dest.startsWith(p.libraryRoot) ? p.dest.slice(p.libraryRoot.length + 1) : p.dest;
}

export function MediaAutomationPage() {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [group, setGroup] = useState<Group>('todo');
  const selected = params.get('item');

  const summary = useQuery({ queryKey: ['media-summary'], queryFn: () => api<Summary>('/media/summary'), refetchInterval: 10_000 });
  const items = useQuery({ queryKey: ['media-items'], queryFn: () => api<Item[]>('/media/items?limit=500'), refetchInterval: 10_000 });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['media-summary'] });
    void qc.invalidateQueries({ queryKey: ['media-items'] });
    void qc.invalidateQueries({ queryKey: ['media-item'] });
  };

  const scan = useMutation({
    mutationFn: () => api<{ detected: number; analyzed: number; imported: string[]; indexed: string[]; errors: string[] }>('/media/scan', { method: 'POST' }),
    onSuccess: (r) => {
      refresh();
      toast(r.errors.length ? 'err' : 'ok', `Scansione: ${r.detected} nuovi, ${r.analyzed} analizzati, ${r.imported.length} importati${r.errors.length ? ` · ${r.errors[0]}` : ''}`);
    },
    onError: (e: Error) => toast('err', e.message),
  });
  const settings = useMutation({
    mutationFn: (b: { autoImport?: boolean; threshold?: number }) => api('/media/settings', { method: 'PUT', body: b }),
    onSuccess: () => refresh(),
    onError: (e: Error) => toast('err', e.message),
  });

  const s = summary.data;
  const counts = s?.counts ?? {};
  const n = (ks: readonly string[]) => ks.reduce((a, k) => a + (counts[k] ?? 0), 0);
  const list = useMemo(() => (items.data ?? []).filter((i) => (GROUPS[group] as readonly string[]).includes(i.status)), [items.data, group]);
  const libProblems = s?.libraryCheck.filter((l) => !l.exists || !l.writable) ?? [];

  return (
    <div>
      <PageHeader
        title="Media automation"
        description="Download completati → riconoscimento → proposta → importazione con hardlink → Jellyfin e Apollo. La sorgente in seeding non viene mai toccata."
        actions={
          isAdmin && (
            <>
              <label className="flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-line-strong bg-surface-2 px-3 text-[13px]">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--accent)]"
                  checked={s?.settings.autoImport ?? false}
                  disabled={!s || settings.isPending}
                  onChange={(e) => settings.mutate({ autoImport: e.target.checked })}
                />
                Import automatico ≥ {s?.settings.threshold ?? 85}%
              </label>
              <Button size="sm" variant="primary" onClick={() => scan.mutate()} loading={scan.isPending || s?.busy}>
                <ScanSearch /> Scansiona ora
              </Button>
            </>
          )
        }
      />

      {summary.isError && <ErrorBox error={summary.error} />}
      {s && (!s.sources.qbittorrent || !s.sources.jellyfin) && (
        <Card className="mb-4">
          <div className="flex items-start gap-3 text-[13px]">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
            <div>
              {!s.sources.qbittorrent && <p>qBittorrent non è collegato: nessun download può essere rilevato.</p>}
              {!s.sources.jellyfin && <p>Jellyfin non è collegato: niente ricerca metadati, niente notifica né verifica di indicizzazione.</p>}
            </div>
          </div>
        </Card>
      )}
      {libProblems.length > 0 && (
        <Card className="mb-4 border-warn/40">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
            <div className="min-w-0 text-[13px]">
              <p className="font-medium">Alcune librerie non sono scrivibili dal motore media</p>
              <p className="mt-0.5 text-xs text-muted">Le importazioni verso queste cartelle falliranno senza creare nulla. Serve cambiare il proprietario delle cartelle (operazione da autorizzare).</p>
              <ul className="mt-2 space-y-0.5">
                {libProblems.map((l) => (
                  <li key={l.key} className="font-mono text-xs">
                    {l.label}: {l.path} — {l.exists ? 'non scrivibile' : 'inesistente'}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Card>
      )}

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {[
          ['Da rivedere', counts.review ?? 0, 'text-warn', <Pencil key="r" />],
          ['Pronti', counts.ready ?? 0, 'text-info', <CheckCircle2 key="p" />],
          ['Conflitti / errori', n(['conflict', 'error', 'missing']), n(['conflict', 'error', 'missing']) ? 'text-err' : '', <AlertTriangle key="c" />],
          ['In attesa', n(['waiting', 'importing']), '', <Clock key="w" />],
          ['Importati', counts.imported ?? 0, 'text-accent', <Link2 key="i" />],
          ['In libreria', counts.indexed ?? 0, 'text-ok', <Clapperboard key="l" />],
        ].map(([label, v, cls, icon]) => (
          <div key={label as string} className="rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3" style={{ boxShadow: 'var(--shadow)' }}>
            <div className="flex items-center gap-1.5 text-xs text-muted [&>svg]:size-3.5">
              {icon} {label}
            </div>
            <div className={cx('mt-1 text-2xl font-semibold tabular', cls as string)}>{v as number}</div>
          </div>
        ))}
      </div>

      <Tabs
        value={group}
        onChange={setGroup}
        items={[
          { id: 'todo', label: 'Da gestire', count: n(GROUPS.todo) },
          { id: 'waiting', label: 'In attesa', count: n(GROUPS.waiting) },
          { id: 'done', label: 'Importati', count: n(GROUPS.done) },
          { id: 'ignored', label: 'Ignorati ed eliminati', count: n(GROUPS.ignored) },
        ]}
      />
      <div className="mt-4">
        {items.isError && <ErrorBox error={items.error} />}
        {!items.data && !items.isError && <Skeleton className="h-48" />}
        {items.data && list.length === 0 && (
          <Card>
            <Empty icon={<Wand2 />} title={group === 'todo' ? 'Niente da gestire' : 'Nessun elemento'}>
              {group === 'todo' && `Ultima scansione: ${s?.settings.lastScan ? ago(s.settings.lastScan) : 'mai'}. I download completati vengono controllati ogni 2 minuti.`}
            </Empty>
          </Card>
        )}
        {list.length > 0 && (
          <Card bodyClassName="!p-0">
            <ul className="divide-y divide-line">
              {list.map((i) => (
                <li key={i.id}>
                  <button
                    onClick={() => setParams({ item: i.id })}
                    className={cx('flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2', selected === i.id && 'bg-surface-2')}
                  >
                    <span className="text-muted [&>svg]:size-5">{i.kind === 'movie' ? <FileVideo /> : <Tv />}</span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium" title={i.fileName}>{i.fileName}</div>
                      <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted">
                        {i.plan ? (
                          <>
                            <ArrowRight className="size-3 shrink-0" />
                            <span className="shrink-0">{i.libraryLabel}</span>
                            <span className="truncate font-mono text-[11px]">/ {shortDest(i.plan)}</span>
                          </>
                        ) : (
                          <span>{i.error ?? 'In attesa di analisi'}</span>
                        )}
                      </div>
                    </div>
                    {i.confidence !== null && i.status !== 'indexed' && (
                      <div className="hidden w-28 shrink-0 sm:block">
                        <div className="mb-1 flex justify-between text-[11px] text-muted">
                          <span>confidenza</span>
                          <span className="tabular">{i.confidence}%</span>
                        </div>
                        <Meter value={i.confidence} tone={confTone(i.confidence, s?.settings.threshold ?? 85)} label="Confidenza" />
                      </div>
                    )}
                    <Badge tone={STATUS[i.status]?.tone ?? 'idle'}>{STATUS[i.status]?.label ?? i.status}</Badge>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>

      {s && (
        <details className="mt-6 text-xs text-muted">
          <summary className="cursor-pointer select-none hover:text-fg-2">Configurazione rilevata (librerie e mappature percorsi)</summary>
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <Card title="Librerie di destinazione">
              <dl>
                {s.libraryCheck.map((l) => (
                  <Kv key={l.key} k={l.label} mono>
                    {l.path} {l.exists ? (l.writable ? <Badge tone="ok">scrivibile</Badge> : <Badge tone="warn">sola lettura</Badge>) : <Badge tone="err">assente</Badge>}
                  </Kv>
                ))}
              </dl>
            </Card>
            <Card title="Mappature (dai mount dei container)">
              <dl>
                {s.sources.qbtPathMap.map((m) => (
                  <Kv key={m.from} k={`qBittorrent ${m.from}`} mono>
                    {m.to}
                  </Kv>
                ))}
                {s.sources.jfPathMap.map((m) => (
                  <Kv key={m.host} k={`host ${m.host}`} mono>
                    Jellyfin {m.jf}
                  </Kv>
                ))}
              </dl>
            </Card>
          </div>
        </details>
      )}

      {selected && <ItemDrawer id={selected} threshold={s?.settings.threshold ?? 85} onClose={() => setParams({})} onChanged={refresh} />}
    </div>
  );
}

function ItemDrawer({ id, threshold, onClose, onChanged }: { id: string; threshold: number; onClose: () => void; onChanged: () => void }) {
  const { isAdmin } = useAuth();
  const toast = useToast();
  const q = useQuery({ queryKey: ['media-item', id], queryFn: () => api<Item>(`/media/items/${id}`), refetchInterval: 8_000 });
  const [confirm, setConfirm] = useState(false);
  const [editing, setEditing] = useState(false);
  const [purge, setPurge] = useState(false);
  const [typed, setTyped] = useState('');
  const purgeM = useMutation({
    mutationFn: () => api<{ removed: string[]; skipped: { path: string; reason: string }[] }>(`/media/items/${id}/purge`, { method: 'POST', body: { confirm: typed } }),
    onSuccess: (r) => {
      onChanged();
      setPurge(false);
      toast(r.removed.length ? 'ok' : 'err', r.removed.length ? `Rimosso dalla libreria (${r.removed.length} file); Jellyfin aggiornato` : `Niente da rimuovere${r.skipped[0] ? `: ${r.skipped[0].reason}` : ''}`);
    },
    onError: (e: Error) => toast('err', e.message),
  });

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && !confirm && !editing && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose, confirm, editing]);

  const act = useMutation({
    mutationFn: (a: 'import' | 'ignore' | 'restore' | 'reanalyze') => api<Item>(`/media/items/${id}/${a}`, { method: 'POST' }),
    onSuccess: (r, a) => {
      onChanged();
      setConfirm(false);
      toast('ok', a === 'import' ? `Importato: ${r.plan?.dest.split('/').pop()}` : a === 'ignore' ? 'Elemento ignorato' : a === 'restore' ? 'Elemento ripristinato' : 'Analisi aggiornata');
    },
    onError: (e: Error) => {
      onChanged();
      toast('err', e.message);
    },
  });

  const i = q.data;
  const canImport = isAdmin && i && ['ready', 'review'].includes(i.status) && i.plan;
  const canEdit = isAdmin && i && !['imported', 'indexed', 'importing'].includes(i.status);

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-label="Dettaglio elemento">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative flex h-full w-full max-w-3xl flex-col border-l border-line-strong bg-bg-2 pt-[env(safe-area-inset-top,0px)] shadow-2xl">
        <div className="flex items-start gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              {i && <Badge tone={STATUS[i.status]?.tone ?? 'idle'}>{STATUS[i.status]?.label ?? i.status}</Badge>}
              {i?.anime && <Badge tone="accent">anime</Badge>}
              {i?.category && <Badge>categoria: {i.category}</Badge>}
            </div>
            <h2 className="mt-1.5 text-[15px] font-semibold break-all">{i?.fileName ?? '…'}</h2>
            <p className="mt-0.5 truncate text-xs text-muted">torrent «{i?.torrentName}» · {i ? bytes(i.size) : ''}</p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Chiudi">
            <X />
          </Button>
        </div>
        {isAdmin && i && (
          <div className="flex flex-wrap gap-2 border-b border-line px-5 py-3">
            {canImport && (
              <Button size="sm" variant="primary" onClick={() => setConfirm(true)}>
                <Link2 /> Importa
              </Button>
            )}
            {canEdit && (
              <Button size="sm" onClick={() => setEditing(true)}>
                <Pencil /> Correggi
              </Button>
            )}
            {canEdit && i.status !== 'ignored' && (
              <Button size="sm" variant="ghost" onClick={() => act.mutate('reanalyze')} loading={act.isPending && act.variables === 'reanalyze'}>
                <RefreshCw /> Rianalizza
              </Button>
            )}
            {canEdit && i.status !== 'ignored' && (
              <Button size="sm" variant="ghost" onClick={() => act.mutate('ignore')}>
                <EyeOff /> Ignora
              </Button>
            )}
            {['imported', 'indexed'].includes(i.status) && (
              <Button size="sm" variant="ghost" className="text-err" onClick={() => setPurge(true)}>
                <Trash2 /> Elimina dalla libreria
              </Button>
            )}
            {i.status === 'ignored' && (
              <Button size="sm" onClick={() => act.mutate('restore')}>
                <RotateCcw /> Ripristina
              </Button>
            )}
          </div>
        )}
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {q.isError && <ErrorBox error={q.error} />}
          {!i && !q.isError && <Skeleton className="h-60" />}
          {i?.error && <ErrorBox error={{ message: i.error }} />}
          {i && (
            <>
              <Card title="Destinazione proposta" icon={<FolderTree />}>
                {i.plan ? (
                  <>
                    <div className="rounded-lg bg-surface-2 p-3 font-mono text-xs leading-6">
                      <div className="text-muted">{i.plan.libraryRoot}/</div>
                      {shortDest(i.plan)
                        .split('/')
                        .map((part, idx, arr) => (
                          <div key={idx} style={{ paddingLeft: (idx + 1) * 14 }} className={idx === arr.length - 1 ? 'text-fg' : 'text-fg-2'}>
                            {idx === arr.length - 1 ? '📄 ' : '📁 '}
                            {part}
                            {idx === 0 && i.plan!.existingFolder && <span className="ml-2 font-sans text-[11px] text-ok">cartella esistente</span>}
                          </div>
                        ))}
                      {i.plan.subtitles.map((sub) => (
                        <div key={sub.dest} style={{ paddingLeft: shortDest(i.plan).split('/').length * 14 }} className="text-fg-2">
                          💬 {sub.dest.split('/').pop()}
                        </div>
                      ))}
                    </div>
                    <p className="mt-2 text-xs text-muted">
                      Libreria Jellyfin «{i.libraryLabel}». L’importazione crea un <b className="text-fg-2">hardlink</b>: nessuno spazio aggiuntivo, il file originale resta in{' '}
                      <span className="font-mono">{i.srcPath.split('/').slice(0, -1).join('/')}</span> e continua il seeding.
                    </p>
                  </>
                ) : (
                  <p className="text-xs text-muted">Nessuna destinazione: serve una correzione manuale.</p>
                )}
              </Card>

              <Card
                title="Confidenza"
                actions={
                  i.confidence !== null && (
                    <span className={cx('text-lg font-semibold tabular', i.confidence >= threshold ? 'text-ok' : i.confidence >= 60 ? 'text-warn' : 'text-err')}>{i.confidence}%</span>
                  )
                }
              >
                {i.confidence !== null && <Meter value={i.confidence} tone={confTone(i.confidence, threshold)} label="Confidenza" />}
                <p className="mt-1.5 text-[11px] text-muted">Soglia di import automatico: {threshold}%. Sotto soglia serve una conferma.</p>
                <ul className="mt-3 space-y-1.5">
                  {i.reasons.map((r, k) => (
                    <li key={k} className="flex items-start gap-2 text-[13px]">
                      <span
                        className={cx(
                          'mt-px w-10 shrink-0 text-right font-mono text-xs tabular',
                          r.delta > 0 ? 'text-ok' : r.delta < 0 ? 'text-err' : 'text-muted',
                        )}
                      >
                        {r.delta > 0 ? `+${r.delta}` : r.delta < 0 ? r.delta : '·'}
                      </span>
                      <span className="text-fg-2">{r.text}</span>
                    </li>
                  ))}
                </ul>
              </Card>

              <div className="grid gap-4 lg:grid-cols-2">
                <Card title="Riconoscimento dal nome">
                  {i.parsed ? (
                    <dl>
                      <Kv k="Titolo">{i.parsed.title || '—'}</Kv>
                      <Kv k="Anno">{i.parsed.year ?? '—'}</Kv>
                      <Kv k="Stagione / episodi">
                        {i.parsed.season ?? '—'} / {i.parsed.episodes.join(', ') || '—'}
                      </Kv>
                      <Kv k="Gruppo">{i.parsed.group ?? '—'}</Kv>
                      <Kv k="Risoluzione">{i.parsed.resolution ?? '—'}</Kv>
                      <Kv k="Indizi anime">{i.parsed.animeSignals.length ? i.parsed.animeSignals.join(', ') : 'nessuno'}</Kv>
                    </dl>
                  ) : (
                    <p className="text-xs text-muted">Non ancora analizzato.</p>
                  )}
                  {i.override && <p className="mt-2 text-xs text-accent">Correzione manuale applicata.</p>}
                </Card>
                <Card title="Analisi tecnica (ffprobe)">
                  {i.probe ? (
                    i.probe.ok ? (
                      <dl>
                        <Kv k="Durata">{i.probe.duration ? `${Math.round(i.probe.duration / 60)} min` : '—'}</Kv>
                        <Kv k="Video">{i.probe.video ? `${i.probe.video.codec} ${i.probe.video.width}×${i.probe.video.height}${i.probe.video.hdr ? ' HDR' : ''}` : '—'}</Kv>
                        <Kv k="Audio">{i.probe.audio.map((a) => `${a.lang ?? '?'} ${a.codec}`).join(', ') || '—'}</Kv>
                        <Kv k="Sottotitoli interni">{i.probe.subtitles.map((s) => `${s.lang ?? '?'}${s.forced ? ' (forced)' : ''}`).join(', ') || 'nessuno'}</Kv>
                        <Kv k="Titolo interno">
                          <span title="Il titolo nei metadati del file non è affidabile e non viene usato per l’identificazione">{i.probe.embeddedTitle ?? '—'}</span>
                        </Kv>
                      </dl>
                    ) : (
                      <ErrorBox error={{ message: i.probe.error ?? 'File non leggibile' }} compact />
                    )
                  ) : (
                    <p className="text-xs text-muted">Non ancora analizzato.</p>
                  )}
                </Card>
              </div>

              {i.match && (i.match.remote.length > 0 || i.match.local.length > 0) && (
                <Card title="Corrispondenze trovate" subtitle="Dalla libreria Jellyfin e dai provider di metadati configurati in Jellyfin (TMDb, OMDb).">
                  <ul className="space-y-1">
                    {[...i.match.local.map((c) => ({ ...c, local: true })), ...i.match.remote.map((c) => ({ ...c, local: false }))].map((c, k) => {
                      const chosen = i.plan?.matched && i.plan.matched.name === c.name && i.plan.matched.year === c.year && i.plan.matched.source === c.source;
                      return (
                        <li key={k} className={cx('flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px]', chosen && 'bg-accent-soft')}>
                          {chosen ? <CheckCircle2 className="size-4 text-accent" /> : <span className="size-4" />}
                          <span className="min-w-0 flex-1 truncate">
                            {c.name} {c.year && <span className="text-muted">({c.year})</span>}
                          </span>
                          <Badge tone={c.local ? 'ok' : 'idle'}>{c.local ? 'già in libreria' : c.source}</Badge>
                        </li>
                      );
                    })}
                  </ul>
                </Card>
              )}

              {i.history && i.history.length > 0 && (
                <Card title="Storico">
                  <ul className="space-y-1.5">
                    {i.history.map((h, k) => (
                      <li key={k} className="text-xs">
                        <span className="text-muted tabular">{dateTime(h.ts)}</span> · <span className="text-fg-2">{h.actor}</span> · <b className="font-medium">{h.action}</b>
                        {h.details && <div className="mt-0.5 font-mono text-[11px] break-all text-muted">{h.details}</div>}
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
            </>
          )}
        </div>
      </div>

      {i?.plan && (
        <Dialog
          open={confirm}
          onClose={() => setConfirm(false)}
          title="Importare nella libreria?"
          description="Verrà creato un hardlink: nessuna copia, nessuno spostamento. Il torrent continua il seeding dal file originale."
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirm(false)}>
                Annulla
              </Button>
              <Button variant="primary" onClick={() => act.mutate('import')} loading={act.isPending && act.variables === 'import'}>
                <Link2 /> Importa
              </Button>
            </>
          }
        >
          <dl className="space-y-2 text-xs">
            <div>
              <dt className="text-muted">Da</dt>
              <dd className="font-mono break-all text-fg-2">{i.srcPath}</dd>
            </div>
            <div>
              <dt className="text-muted">A</dt>
              <dd className="font-mono break-all text-fg">{i.plan.dest}</dd>
            </div>
            <div>
              <dt className="text-muted">Confidenza</dt>
              <dd className="text-fg-2">{i.confidence}%</dd>
            </div>
          </dl>
          {(i.confidence ?? 0) < threshold && (
            <p className="mt-3 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">Confidenza sotto la soglia: controlla destinazione e corrispondenza prima di confermare.</p>
          )}
          <p className="mt-3 text-xs text-muted">Dopo l’import GIGI OS chiede a Jellyfin di indicizzare il file e verifica che compaia (e quindi anche in Apollo).</p>
        </Dialog>
      )}
      {i && editing && <OverrideDialog item={i} onClose={() => setEditing(false)} onDone={onChanged} />}
      {i?.plan && (
        <Dialog
          open={purge}
          onClose={() => setPurge(false)}
          title="Eliminare dalla libreria?"
          description="Il file viene cancellato definitivamente dalla libreria e sparisce da Jellyfin e Apollo. Il torrent in qBittorrent non viene toccato."
          footer={
            <>
              <Button variant="ghost" onClick={() => setPurge(false)}>Annulla</Button>
              <Button variant="danger" disabled={typed !== 'ELIMINA'} loading={purgeM.isPending} onClick={() => purgeM.mutate()}><Trash2 /> Elimina</Button>
            </>
          }
        >
          <p className="mb-3 font-mono text-xs break-all text-fg-2">{i.plan.dest}</p>
          <Field label="Per confermare scrivi ELIMINA">{(fid) => <Input id={fid} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />}</Field>
        </Dialog>
      )}
    </div>
  );
}

function OverrideDialog({ item, onClose, onDone }: { item: Item; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const p = item.plan;
  const [kind, setKind] = useState<'movie' | 'episode'>((p?.kind ?? (item.kind === 'movie' ? 'movie' : 'episode')) as 'movie' | 'episode');
  const [anime, setAnime] = useState(p?.anime ?? item.anime);
  const [title, setTitle] = useState(p?.name ?? item.parsed?.title ?? '');
  const [year, setYear] = useState(String(p?.year ?? item.parsed?.year ?? ''));
  const [season, setSeason] = useState(String(p?.season ?? item.parsed?.season ?? 1));
  const [episodes, setEpisodes] = useState((p?.episodes ?? item.parsed?.episodes ?? []).join(', '));
  const m = useMutation({
    mutationFn: () =>
      api<Item>(`/media/items/${item.id}/override`, {
        method: 'POST',
        body: {
          kind,
          anime,
          title: title.trim(),
          year: year.trim() ? Number(year) : null,
          ...(kind === 'episode'
            ? {
                season: Number(season),
                episodes: episodes
                  .split(/[,\s]+/)
                  .filter(Boolean)
                  .map(Number),
              }
            : {}),
        },
      }),
    onSuccess: (r) => {
      onDone();
      toast('ok', `Proposta aggiornata: ${r.plan?.dest.split('/').pop() ?? '—'}`);
      onClose();
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="Correggi riconoscimento"
      description="I dati confermati a mano hanno priorità sull’analisi automatica. Nessun file viene toccato finché non premi «Importa»."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annulla
          </Button>
          <Button variant="primary" onClick={() => m.mutate()} loading={m.isPending}>
            Applica
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Tipo">
            {(id) => (
              <Select id={id} value={kind} onChange={(e) => setKind(e.target.value as 'movie' | 'episode')}>
                <option value="episode">Episodio</option>
                <option value="movie">Film</option>
              </Select>
            )}
          </Field>
          <Field label="Anime">
            {(id) => (
              <Select id={id} value={anime ? '1' : '0'} onChange={(e) => setAnime(e.target.value === '1')}>
                <option value="1">Sì (librerie Anime)</option>
                <option value="0">No</option>
              </Select>
            )}
          </Field>
        </div>
        <Field label="Titolo" help="Usa il titolo come appare in Jellyfin/TMDb.">
          {(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} />}
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Anno">{(id) => <Input id={id} inputMode="numeric" value={year} onChange={(e) => setYear(e.target.value)} placeholder="—" />}</Field>
          {kind === 'episode' && (
            <>
              <Field label="Stagione">{(id) => <Input id={id} inputMode="numeric" value={season} onChange={(e) => setSeason(e.target.value)} />}</Field>
              <Field label="Episodi">{(id) => <Input id={id} value={episodes} onChange={(e) => setEpisodes(e.target.value)} placeholder="es. 1 oppure 1, 2" />}</Field>
            </>
          )}
        </div>
        {m.isError && <ErrorBox error={m.error} compact />}
      </div>
    </Dialog>
  );
}
