// «Elimina dalla libreria» (D-038): un titolo di Jellyfin con i suoi file, gli accessori e i torrent che li condividono.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Search, ShieldCheck, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card, cx, Dialog, Empty, ErrorBox, Field, Input, Skeleton, useToast } from '../components/ui';
import { api, type Integration } from '../lib/api';
import { ago, bytes } from '../lib/format';
import { useResource } from '../lib/queries';

type Plan = {
  item: { id: string; name: string; type: string; year: number | null; seriesName: string | null; season: number | null; episode: number | null };
  episodes: number | null;
  videos: { path: string; size: number; ino: number; dev: number; nlink: number }[];
  sidecars: { path: string; size: number }[];
  extras: { path: string; size: number }[];
  dirs: string[];
  skipped: { path: string; reason: string }[];
  unmapped: string[];
  size: number;
  freed: number;
  torrents: { hash: string; name: string }[];
  torrentsError: string | null;
};
type Result = { title: string; mode: 'trash' | 'delete'; videos: number; freed: number; size: number; torrentsDeleted: number; torrentError: string | null; jellyfin: 'removed' | 'pending' | 'unconfigured' };
type Hit = { id: string; name: string; type: string; year: number | null; seriesName: string | null; season: number | null; episode: number | null };

const TYPE: Record<string, string> = { Movie: 'Film', Series: 'Serie', Season: 'Stagione', Episode: 'Episodio', Video: 'Video' };
const pad = (n: number | null) => String(n ?? 0).padStart(2, '0');
export const titleOf = (i: Hit) =>
  i.type === 'Episode' ? `${i.seriesName ?? ''} · S${pad(i.season)}E${pad(i.episode)} · ${i.name}` : i.type === 'Season' && i.seriesName ? `${i.seriesName} · ${i.name}` : `${i.name}${i.year ? ` (${i.year})` : ''}`;

/** Ricerca dei titoli in Jellyfin con il pulsante per eliminarli (solo amministratori). */
export function LibraryCard({ jf }: { jf: Integration }) {
  const [q, setQ] = useState('');
  const [target, setTarget] = useState<string | null>(null);
  const term = q.trim();
  const hits = useResource<Hit[]>(term.length >= 2 ? jf : undefined, 'search', `q=${encodeURIComponent(term)}`, 0);
  return (
    <Card title="Elimina dalla libreria" icon={<Trash2 />} subtitle="Cerca un film, una serie o un episodio: spariranno da Jellyfin e da Apollo." className="xl:col-span-3">
      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Titolo…" aria-label="Cerca un titolo in Jellyfin" className="pl-8" />
      </div>
      {term.length >= 2 && (
        <div className="mt-3">
          {hits.isError && <ErrorBox error={hits.error} compact />}
          {!hits.data && !hits.isError && <Skeleton className="h-16" />}
          {hits.data?.length === 0 && <Empty title="Nessun titolo trovato" />}
          <ul className="divide-y divide-line">
            {hits.data?.map((h) => (
              <li key={h.id} className="flex items-center gap-3 py-2 text-[13px]">
                <Badge tone="idle">{TYPE[h.type] ?? h.type}</Badge>
                <span className="min-w-0 flex-1 truncate" title={titleOf(h)}>{titleOf(h)}</span>
                <Button size="sm" variant="ghost" onClick={() => setTarget(h.id)} aria-label={`Elimina ${titleOf(h)}`}>
                  <Trash2 /> Elimina
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {target && <LibraryDeleteDialog jfId={target} onClose={() => setTarget(null)} />}
    </Card>
  );
}

const short = (p: string) => p.split('/').slice(-2).join('/');

/** Dopo un'eliminazione: liste di Jellyfin (aggiunti di recente, ricerca) ricaricate subito e di nuovo dopo qualche secondo. */
export function refreshLibraryViews(qc: ReturnType<typeof useQueryClient>) {
  const go = () => {
    void qc.invalidateQueries({ queryKey: ['resource'] });
    void qc.invalidateQueries({ queryKey: ['media-items'] });
    void qc.invalidateQueries({ queryKey: ['library-check'] });
  };
  go();
  for (const ms of [5_000, 20_000, 60_000]) setTimeout(go, ms);
}

export function LibraryDeleteDialog({ jfId, onClose }: { jfId: string; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const plan = useQuery({ queryKey: ['library-plan', jfId], queryFn: () => api<Plan>(`/media/library/${jfId}/plan`), retry: false, staleTime: 0, gcTime: 0 });
  const [mode, setMode] = useState<'trash' | 'delete'>('trash');
  const [keep, setKeep] = useState<Set<string>>(new Set());
  const [typed, setTyped] = useState('');
  const p = plan.data;
  const torrents = p?.torrents.filter((t) => !keep.has(t.hash)).map((t) => t.hash) ?? [];
  const run = useMutation({
    mutationFn: () =>
      api<Result>(`/media/library/${jfId}/delete`, {
        method: 'POST',
        body: { confirm: typed, mode, torrents, expect: p!.videos.map(({ path, ino, dev }) => ({ path, ino, dev })) },
      }),
    onSuccess: (r) => {
      const where = r.jellyfin === 'removed' ? 'sparito da Jellyfin e Apollo' : r.jellyfin === 'pending' ? 'Jellyfin sta aggiornando la libreria, sparirà a breve' : 'Jellyfin non è collegato';
      const what = r.mode === 'trash' ? 'nel cestino' : `eliminato (${bytes(r.freed)} liberati)`;
      toast(r.torrentError ? 'err' : 'ok', `${r.title}: ${what}, ${where}${r.torrentsDeleted ? `; ${r.torrentsDeleted} torrent rimossi` : ''}${r.torrentError ? `. qBittorrent: ${r.torrentError}` : ''}`);
      refreshLibraryViews(qc);
      onClose();
    },
  });
  const files = p ? p.videos.length + p.sidecars.length + p.extras.length : 0;
  return (
    <Dialog
      open
      onClose={onClose}
      title={p ? `Eliminare «${titleOf(p.item)}»?` : 'Elimina dalla libreria'}
      description={p ? `${TYPE[p.item.type] ?? p.item.type}${p.episodes !== null ? ` · ${p.episodes} episodi` : ''} · ${files} file, ${bytes(p.size)}` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Annulla</Button>
          <Button variant="danger" onClick={() => run.mutate()} loading={run.isPending} disabled={!p || !p.videos.length || typed !== 'ELIMINA'}>
            <Trash2 /> {mode === 'trash' ? 'Sposta nel cestino' : 'Elimina definitivamente'}
          </Button>
        </>
      }
    >
      {plan.isError && <ErrorBox error={plan.error} compact />}
      {!p && !plan.isError && <Skeleton className="h-40" />}
      {p && (
        <div className="space-y-3 text-[13px]">
          <div>
            <div className="mb-1 text-xs font-medium text-muted">File video</div>
            <ul className="max-h-28 space-y-0.5 overflow-y-auto text-xs">
              {p.videos.map((v) => (
                <li key={v.path} className="flex gap-2">
                  <span className="min-w-0 flex-1 truncate text-fg-2" title={v.path}>{short(v.path)}</span>
                  <span className="shrink-0 tabular-nums text-muted">{bytes(v.size)}</span>
                </li>
              ))}
            </ul>
            {(p.sidecars.length > 0 || p.extras.length > 0 || p.dirs.length > 0) && (
              <p className="mt-1 text-xs text-muted">
                Con loro: {p.sidecars.length + p.extras.length} accessori (sottotitoli, .nfo, immagini){p.dirs.length ? ` e ${p.dirs.length === 1 ? 'la cartella che resta vuota' : `${p.dirs.length} cartelle che restano vuote`}` : ''}.
              </p>
            )}
          </div>
          {p.unmapped.length > 0 && <p className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">{p.unmapped.length} file sono fuori dalle cartelle che GIGI OS raggiunge e resteranno dove sono.</p>}
          {p.skipped.length > 0 && <p className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">Non toccati: {p.skipped.map((s) => `${short(s.path)} (${s.reason})`).join('; ')}</p>}

          {(p.torrents.length > 0 || p.torrentsError) && (
            <div>
              <div className="mb-1 text-xs font-medium text-muted">In qBittorrent con gli stessi file</div>
              {p.torrentsError && <p className="text-xs text-warn">Impossibile controllare i torrent: {p.torrentsError}</p>}
              <ul className="space-y-1">
                {p.torrents.map((t) => (
                  <li key={t.hash}>
                    <label className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        className="size-4 [--check:var(--err)]"
                        checked={!keep.has(t.hash)}
                        onChange={() => setKeep((k) => { const n = new Set(k); n.has(t.hash) ? n.delete(t.hash) : n.add(t.hash); return n; })}
                      />
                      <span className="min-w-0 truncate">Rimuovi anche <span className="font-medium">{t.name}</span> con i file scaricati</span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div role="radiogroup" aria-label="Come eliminare" className="space-y-2">
            {([
              ['trash', 'Sposta nel cestino', 'Sparisce subito da Jellyfin e Apollo; lo ripristini dal file manager (cestino). Lo spazio si libera svuotando il cestino.'],
              ['delete', 'Elimina definitivamente', `Non si può annullare. Libera ${bytes(p.freed + (torrents.length ? p.videos.filter((v) => v.nlink > 1).reduce((n, v) => n + v.size, 0) : 0))}${p.videos.some((v) => v.nlink > 1) && !torrents.length ? ' (i file condivisi con un torrent restano finché c’è il torrent)' : ''}.`],
            ] as const).map(([id, label, help]) => (
              <label key={id} className={cx('flex cursor-pointer items-start gap-2.5 rounded-xl border p-3', mode === id ? 'border-err/50 bg-err-soft/40' : 'border-line hover:border-line-strong')}>
                <input type="radio" name="library-delete-mode" className="mt-0.5 size-4 [--check:var(--err)]" checked={mode === id} onChange={() => setMode(id)} />
                <span>
                  <span className="font-medium">{label}</span>
                  <span className="block text-xs text-muted">{help}</span>
                </span>
              </label>
            ))}
          </div>
          <Field label="Per confermare scrivi ELIMINA">{(id) => <Input id={id} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />}</Field>
          {run.isError && <ErrorBox error={run.error} compact />}
        </div>
      )}
    </Dialog>
  );
}

type Check = {
  checkedAt: number;
  total: number;
  unmapped: number;
  ghosts: { id: string; title: string; path: string }[];
  unlinked: { id: string; type: string; title: string; seriesId: string | null; seriesName: string | null; size: number; path: string }[];
};

/**
 * Controllo della libreria: cosa c'è in Jellyfin senza più un torrent (resta finché non lo si elimina da qui)
 * e schede di Jellyfin rimaste senza file.
 */
export function LibraryCheckCard() {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['library-check'], queryFn: () => api<Check>('/media/library/check'), staleTime: 60_000 });
  const [target, setTarget] = useState<string | null>(null);
  const fix = useMutation({
    mutationFn: () => api<{ ghosts: number; jellyfin: string }>('/media/library/fix-ghosts', { method: 'POST' }),
    onSuccess: (r) => {
      toast('ok', r.jellyfin === 'removed' ? `${r.ghosts} schede tolte da Jellyfin` : 'Jellyfin sta aggiornando la libreria');
      refreshLibraryViews(qc);
    },
    onError: (e: Error) => toast('err', e.message),
  });
  // Episodi raggruppati per serie: si elimina la serie (il dialogo mostra esattamente quali file)
  const rows: { id: string; label: string; detail: string; size: number }[] = [];
  const bySeries = new Map<string, { name: string; n: number; size: number }>();
  for (const u of q.data?.unlinked ?? []) {
    if (u.type === 'Episode' && u.seriesId) {
      const g = bySeries.get(u.seriesId) ?? { name: u.seriesName ?? 'Serie', n: 0, size: 0 };
      g.n++;
      g.size += u.size;
      bySeries.set(u.seriesId, g);
    } else rows.push({ id: u.id, label: u.title, detail: 'Film', size: u.size });
  }
  for (const [id, g] of bySeries) rows.push({ id, label: g.name, detail: g.n === 1 ? '1 episodio' : `${g.n} episodi`, size: g.size });
  const d = q.data;
  return (
    <Card
      title="Controllo libreria"
      icon={<ShieldCheck />}
      subtitle={d ? `${d.total} titoli in Jellyfin · controllato ${ago(d.checkedAt)}` : 'Confronto tra Jellyfin, file sul disco e torrent.'}
      className="xl:col-span-3"
      actions={
        <Button size="sm" variant="ghost" onClick={() => void q.refetch()} loading={q.isFetching} aria-label="Controlla di nuovo">
          <RefreshCw />
        </Button>
      }
    >
      {q.isError && <ErrorBox error={q.error} compact />}
      {!d && !q.isError && <Skeleton className="h-16" />}
      {d && (
        <div className="space-y-4 text-[13px]">
          {d.ghosts.length > 0 && (
            <div className="rounded-lg border border-warn/30 bg-warn-soft px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-warn">{d.ghosts.length === 1 ? '1 titolo in Jellyfin non ha più il file' : `${d.ghosts.length} titoli in Jellyfin non hanno più il file`}</span>
                <Button size="sm" className="ml-auto" onClick={() => fix.mutate()} loading={fix.isPending}>
                  Togli da Jellyfin
                </Button>
              </div>
              <ul className="mt-1 space-y-0.5 text-xs text-fg-2">{d.ghosts.slice(0, 20).map((g) => <li key={g.id} className="truncate" title={g.path}>• {g.title}</li>)}</ul>
            </div>
          )}
          <div>
            <div className="text-xs font-medium text-muted">Non collegati a nessun torrent</div>
            <p className="text-xs text-muted">
              Restano in Jellyfin e Apollo finché non li elimini: di solito il torrent è stato rimosso tenendo la copia in libreria, oppure sono stati copiati a mano.
            </p>
            {rows.length === 0 ? (
              <p className="mt-2 text-xs text-fg-2">Nessuno: ogni titolo in libreria è collegato a un torrent.</p>
            ) : (
              <ul className="mt-2 divide-y divide-line">
                {rows.map((r) => (
                  <li key={r.id} className="flex items-center gap-3 py-2">
                    <span className="min-w-0 flex-1 truncate" title={r.label}>{r.label}</span>
                    <span className="shrink-0 text-xs text-muted">{r.detail} · {bytes(r.size)}</span>
                    <Button size="sm" variant="ghost" onClick={() => setTarget(r.id)} aria-label={`Elimina ${r.label}`}>
                      <Trash2 /> Elimina
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {d.ghosts.length === 0 && <p className="text-xs text-muted">Nessuna scheda di Jellyfin senza file{d.unmapped ? ` (${d.unmapped} titoli fuori dalle cartelle raggiungibili, non controllati)` : ''}.</p>}
        </div>
      )}
      {target && (
        <LibraryDeleteDialog
          jfId={target}
          onClose={() => {
            setTarget(null);
            void qc.invalidateQueries({ queryKey: ['library-check'] });
          }}
        />
      )}
    </Card>
  );
}
