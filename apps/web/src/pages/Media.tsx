import { ArrowDown, ArrowUp, Clapperboard, Download, ExternalLink, Film, FolderOpen, Library, PlayCircle, Tv, Wand2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, cx, Empty, ErrorBox, Input, Kv, Meter, PageHeader, Select, Skeleton, StatusBadge } from '../components/ui';
import type { Integration } from '../lib/api';
import { ago, bytes, eta, num, rate } from '../lib/format';
import { byType, useIntegrations, useResource } from '../lib/queries';

type JfOverview = {
  serverName: string;
  version: string;
  pendingRestart: boolean;
  updateAvailable: boolean;
  counts: { movies: number; series: number; episodes: number };
  libraries: { id: string; name: string; type: string; locations: string[]; refreshStatus: string | null; refreshProgress: number | null }[];
  scan: { state: string; progress: number | null; lastEnd: string | null; lastResult: string | null } | null;
  sessions: { active: number; playing: number };
};
type Latest = { id: string; name: string; type: string; series: string | null; season: number | null; episode: number | null; year: number | null; added: string | null; imageItemId: string | null };
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
};

function Setup({ type, label }: { type: string; label: string }) {
  return (
    <Card>
      <Empty
        icon={<Library />}
        title={`${label} non è ancora collegato`}
        action={
          <Link to={`/integrazioni?add=${type}`}>
            <Button variant="primary" size="sm">Collega {label}</Button>
          </Link>
        }
      >
        GIGI OS legge i dati tramite le API ufficiali con una credenziale dedicata, conservata cifrata. Nessuna scrittura nel database del servizio.
      </Empty>
    </Card>
  );
}

export function MediaPage() {
  const ints = useIntegrations();
  const jf = byType(ints.data, 'jellyfin');
  const qb = byType(ints.data, 'qbittorrent');
  const apollo = byType(ints.data, 'apollo');

  return (
    <div>
      <PageHeader title="Media" description="Jellyfin, Apollo e download qBittorrent in un unico punto." />
      {ints.isError && <ErrorBox error={ints.error} />}
      {!ints.data && !ints.isError && <Skeleton className="h-48" />}
      {ints.data && (
        <div className="space-y-6">
          <section>
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <Clapperboard className="size-4 text-muted" /> Jellyfin {jf && <StatusBadge status={jf.status} />}
            </h2>
            {!jf || jf.status === 'unconfigured' ? <Setup type="jellyfin" label="Jellyfin" /> : <Jellyfin jf={jf} />}
          </section>
          {apollo && (
            <Card>
              <div className="flex flex-wrap items-center gap-3">
                <PlayCircle className="size-5 text-accent" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-[13px] font-medium">
                    Apollo <StatusBadge status={apollo.status} />
                  </div>
                  <p className="text-xs text-muted">
                    Client web di Jellyfin: mostra esattamente ciò che Jellyfin ha indicizzato. Se un contenuto è visibile qui sopra, è disponibile anche in Apollo.
                  </p>
                </div>
                <a href={apollo.webUrl} target="_blank" rel="noreferrer noopener">
                  <Button size="sm">
                    Apri Apollo <ExternalLink />
                  </Button>
                </a>
              </div>
            </Card>
          )}
          <section>
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <Download className="size-4 text-muted" /> Download {qb && <StatusBadge status={qb.status} />}
            </h2>
            {!qb || qb.status === 'unconfigured' ? <Setup type="qbittorrent" label="qBittorrent" /> : <Torrents qb={qb} />}
          </section>
          <Card>
            <div className="flex items-start gap-3">
              <Wand2 className="mt-0.5 size-5 text-muted" />
              <div className="text-xs text-muted">
                <div className="mb-0.5 text-[13px] font-medium text-fg-2">
                  Media automation <Badge className="ml-1">non ancora disponibile</Badge>
                </div>
                Classificazione automatica dei download completati, coda di revisione e importazione con hardlink arriveranno nella V3. Per ora GIGI OS mostra i download ma non sposta né rinomina alcun file.
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

function Jellyfin({ jf }: { jf: Integration }) {
  const o = useResource<JfOverview>(jf, 'overview', '', 30_000);
  const l = useResource<Latest[]>(jf, 'latest', 'limit=24', 60_000);
  if (o.isError) return <ErrorBox error={o.error} />;
  if (!o.data) return <Skeleton className="h-48" />;
  const d = o.data;
  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <Card title={d.serverName} subtitle={`Jellyfin ${d.version}`} actions={
        <a href={jf.webUrl} target="_blank" rel="noreferrer noopener" className="text-muted hover:text-fg" aria-label="Apri Jellyfin">
          <ExternalLink className="size-4" />
        </a>
      }>
        <div className="mb-3 grid grid-cols-3 gap-2">
          {[
            [<Film key="f" className="size-3.5" />, 'Film', d.counts.movies],
            [<Tv key="t" className="size-3.5" />, 'Serie', d.counts.series],
            [<Tv key="e" className="size-3.5" />, 'Episodi', d.counts.episodes],
          ].map(([icon, label, v]) => (
            <div key={label as string} className="rounded-lg bg-surface-2 px-2.5 py-2">
              <div className="text-lg font-semibold tabular">{num(v as number)}</div>
              <div className="flex items-center gap-1 text-[11px] text-muted">
                {icon} {label}
              </div>
            </div>
          ))}
        </div>
        <dl>
          <Kv k="Sessioni attive">
            {d.sessions.active} {d.sessions.playing > 0 && <Badge tone="accent">{d.sessions.playing} in riproduzione</Badge>}
          </Kv>
          <Kv k="Scansione libreria">
            {d.scan ? (
              d.scan.state === 'Running' ? (
                <Badge tone="info">in corso {d.scan.progress !== null ? `${Math.round(d.scan.progress)}%` : ''}</Badge>
              ) : (
                <>
                  {d.scan.lastResult && <Badge tone={d.scan.lastResult === 'Completed' ? 'ok' : 'warn'}>{d.scan.lastResult}</Badge>} {ago(d.scan.lastEnd)}
                </>
              )
            ) : (
              '—'
            )}
          </Kv>
          <Kv k="Aggiornamenti">{d.updateAvailable ? <Badge tone="warn">disponibile</Badge> : 'nessuno segnalato'}</Kv>
          {d.pendingRestart && <Kv k="Riavvio">in sospeso</Kv>}
        </dl>
      </Card>
      <Card title="Librerie" icon={<FolderOpen />} className="xl:col-span-2">
        {d.libraries.length === 0 ? (
          <Empty title="Nessuna libreria configurata" />
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {d.libraries.map((lib) => (
              <li key={lib.id} className="rounded-xl border border-line bg-surface-2 p-3">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium">{lib.name}</span>
                  <Badge>{lib.type}</Badge>
                  {lib.refreshStatus && lib.refreshStatus !== 'Idle' && <Badge tone="info">{lib.refreshStatus}</Badge>}
                </div>
                <ul className="mt-1.5 space-y-0.5">
                  {lib.locations.map((p) => (
                    <li key={p} className="truncate font-mono text-[11px] text-muted">{p}</li>
                  ))}
                </ul>
                {lib.refreshProgress !== null && lib.refreshStatus !== 'Idle' && <Meter className="mt-2" value={lib.refreshProgress} tone="info" />}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Aggiunti di recente" className="xl:col-span-3">
        {l.isError && <ErrorBox error={l.error} compact />}
        {!l.data && !l.isError && <Skeleton className="h-44" />}
        {l.data && l.data.length === 0 && <Empty title="Nessun contenuto" />}
        {l.data && l.data.length > 0 && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(110px,1fr))] gap-3">
            {l.data.map((i) => (
              <figure key={i.id}>
                <div className="aspect-[2/3] overflow-hidden rounded-lg bg-surface-3">
                  {i.imageItemId && <img src={`/api/v1/integrations/${jf.id}/jellyfin/image/${i.imageItemId}`} alt="" loading="lazy" className="size-full object-cover" />}
                </div>
                <figcaption className="mt-1.5">
                  <div className="truncate text-xs font-medium" title={i.series ?? i.name}>{i.series ?? i.name}</div>
                  <div className="truncate text-[11px] text-muted" title={i.name}>
                    {i.type === 'Episode' ? `S${String(i.season ?? 0).padStart(2, '0')}E${String(i.episode ?? 0).padStart(2, '0')} · ${i.name}` : i.year ?? 'Film'}
                  </div>
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

const STATE_LABEL: Record<string, [string, 'ok' | 'info' | 'warn' | 'err' | 'idle']> = {
  downloading: ['Download', 'info'],
  forcedDL: ['Download forzato', 'info'],
  metaDL: ['Metadati', 'info'],
  stalledDL: ['In stallo', 'warn'],
  uploading: ['Seeding', 'ok'],
  forcedUP: ['Seeding forzato', 'ok'],
  stalledUP: ['Seeding (inattivo)', 'ok'],
  pausedDL: ['In pausa', 'idle'],
  stoppedDL: ['Fermo', 'idle'],
  pausedUP: ['Completato', 'idle'],
  stoppedUP: ['Completato', 'idle'],
  queuedDL: ['In coda', 'idle'],
  queuedUP: ['In coda (seed)', 'idle'],
  checkingDL: ['Verifica', 'info'],
  checkingUP: ['Verifica', 'info'],
  checkingResumeData: ['Verifica', 'info'],
  moving: ['Spostamento', 'info'],
  missingFiles: ['File mancanti', 'err'],
  error: ['Errore', 'err'],
};

function Torrents({ qb }: { qb: Integration }) {
  const t = useResource<Torrent[]>(qb, 'torrents', '', 5_000);
  const tr = useResource<{ dlSpeed: number; upSpeed: number; dlSession: number; upSession: number; connection: string }>(qb, 'transfer', '', 5_000);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const cats = useMemo(() => [...new Set((t.data ?? []).map((x) => x.category).filter(Boolean))].sort(), [t.data]);
  const rows = useMemo(() => {
    let r = t.data ?? [];
    if (filter === 'active') r = r.filter((x) => !x.complete);
    else if (filter === 'done') r = r.filter((x) => x.complete);
    else if (filter.startsWith('cat:')) r = r.filter((x) => x.category === filter.slice(4));
    const s = search.trim().toLowerCase();
    if (s) r = r.filter((x) => x.name.toLowerCase().includes(s));
    return r;
  }, [t.data, filter, search]);

  if (t.isError) return <ErrorBox error={t.error} />;
  if (!t.data) return <Skeleton className="h-48" />;
  return (
    <Card bodyClassName="!p-0">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-line px-4 py-3 text-xs">
        <span className="flex items-center gap-1">
          <ArrowDown className="size-3.5 text-info" /> <b className="tabular">{rate(tr.data?.dlSpeed)}</b>
        </span>
        <span className="flex items-center gap-1">
          <ArrowUp className="size-3.5 text-accent" /> <b className="tabular">{rate(tr.data?.upSpeed)}</b>
        </span>
        <span className="text-muted">sessione ↓ {bytes(tr.data?.dlSession)} · ↑ {bytes(tr.data?.upSession)}</span>
        {tr.data && <Badge tone={tr.data.connection === 'connected' ? 'ok' : 'warn'}>{tr.data.connection === 'connected' ? 'connesso' : tr.data.connection}</Badge>}
        <div className="ml-auto flex flex-wrap gap-2">
          <Input className="h-8 w-48 text-xs" placeholder="Cerca…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Cerca torrent" />
          <Select className="h-8 w-auto text-xs" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filtro torrent">
            <option value="all">Tutti ({t.data.length})</option>
            <option value="active">In corso</option>
            <option value="done">Completati</option>
            {cats.map((c) => (
              <option key={c} value={`cat:${c}`}>
                Categoria: {c}
              </option>
            ))}
          </Select>
        </div>
      </div>
      {rows.length === 0 ? (
        <Empty icon={<Download />} title="Nessun torrent" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-[13px]">
            <thead className="border-b border-line text-xs text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Nome</th>
                <th className="px-3 py-2 font-medium">Stato</th>
                <th className="w-40 px-3 py-2 font-medium">Avanzamento</th>
                <th className="px-3 py-2 text-right font-medium">Velocità</th>
                <th className="px-3 py-2 text-right font-medium">Dimensione</th>
                <th className="px-4 py-2 text-right font-medium">Ratio</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((x) => {
                const [label, tone] = STATE_LABEL[x.state] ?? [x.state, 'idle'];
                return (
                  <tr key={x.hash} className="border-b border-line/60 last:border-0">
                    <td className="max-w-[380px] px-4 py-2">
                      <div className="truncate font-medium" title={x.name}>{x.name}</div>
                      <div className="truncate text-[11px] text-muted">
                        {x.category && <Badge className="mr-1">{x.category}</Badge>}
                        <span className="font-mono">{x.savePath}</span>
                      </div>
                    </td>
                    <td className="px-3">
                      <Badge tone={tone}>{label}</Badge>
                    </td>
                    <td className="px-3">
                      <div className="mb-1 flex justify-between text-[11px] text-muted tabular">
                        <span>{Math.floor(x.progress * 1000) / 10}%</span>
                        {!x.complete && <span>{eta(x.eta)}</span>}
                      </div>
                      <Meter value={x.progress * 100} tone={x.complete ? 'ok' : 'info'} label={x.name} />
                    </td>
                    <td className={cx('px-3 text-right text-xs tabular', x.dlspeed + x.upspeed === 0 && 'text-muted')}>
                      ↓ {rate(x.dlspeed)}
                      <br />↑ {rate(x.upspeed)}
                    </td>
                    <td className="px-3 text-right tabular">{bytes(x.size)}</td>
                    <td className="px-4 text-right tabular">{x.ratio.toFixed(2)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
