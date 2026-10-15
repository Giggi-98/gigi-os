import {
  ArrowDown,
  ArrowUp,
  Boxes,
  Clapperboard,
  Cpu,
  Download,
  ExternalLink,
  HardDrive,
  History,
  LayoutGrid,
  MemoryStick,
  Network,
  Server,
  Siren,
  Thermometer,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AreaChart, Sparkline } from '../components/Chart';
import {
  Badge,
  Card,
  containerLabel,
  containerTone,
  cx,
  Dot,
  Empty,
  ErrorBox,
  Kv,
  Meter,
  meterTone,
  Ring,
  Skeleton,
  StatusBadge,
  STATUS,
} from '../components/ui';
import type { Integration } from '../lib/api';
import { ago, bytes, duration, eta, pct, rate } from '../lib/format';
import { byType, useHistory, useOverview, useResource, useSystem } from '../lib/queries';

type WidgetDef = {
  title: string;
  icon: ReactNode;
  description: string;
  size: { w: number; h: number; minW: number; minH: number };
  Component: () => ReactNode;
};

const Loading = () => (
  <div className="space-y-2 pt-1">
    <Skeleton className="h-4 w-2/3" />
    <Skeleton className="h-4 w-1/2" />
    <Skeleton className="h-4 w-3/4" />
  </div>
);

function CpuWidget() {
  const s = useSystem();
  const h = useHistory(15);
  if (s.isError) return <ErrorBox error={s.error} compact />;
  if (!s.data) return <Loading />;
  const d = s.data;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-4">
        <Ring value={d.cpu.usage} label="Utilizzo CPU">
          <span className="text-lg font-semibold tabular">{Math.round(d.cpu.usage)}%</span>
        </Ring>
        <div className="min-w-0 flex-1 space-y-1 text-xs">
          <div className="truncate text-fg-2" title={d.cpuModel}>{d.cpuModel}</div>
          <div className="text-muted tabular">
            {d.cpu.cores} core · load {d.load[0].toFixed(2)}
          </div>
          {d.cpuTemp !== null && (
            <div className={cx('flex items-center gap-1 tabular', d.cpuTemp >= 85 ? 'text-err' : d.cpuTemp >= 70 ? 'text-warn' : 'text-fg-2')}>
              <Thermometer className="size-3.5" /> {Math.round(d.cpuTemp)} °C
            </div>
          )}
        </div>
      </div>
      <div className="mt-auto pt-2">
        <Sparkline values={(h.data ?? []).map((x) => x.cpu)} max={100} color="var(--chart-1)" />
      </div>
    </div>
  );
}

function MemoryWidget() {
  const s = useSystem();
  const h = useHistory(15);
  if (s.isError) return <ErrorBox error={s.error} compact />;
  if (!s.data) return <Loading />;
  const m = s.data.memory;
  const p = (m.used / m.total) * 100;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-4">
        <Ring value={p} label="Memoria usata">
          <span className="text-lg font-semibold tabular">{Math.round(p)}%</span>
        </Ring>
        <div className="min-w-0 flex-1 space-y-1 text-xs tabular">
          <div className="text-fg-2">
            {bytes(m.used)} <span className="text-muted">di {bytes(m.total)}</span>
          </div>
          <div className="text-muted">{bytes(m.available)} disponibili</div>
          {m.swapTotal > 0 && (
            <div className={cx(m.swapUsed / m.swapTotal > 0.5 ? 'text-warn' : 'text-muted')}>
              Swap {bytes(m.swapUsed)} / {bytes(m.swapTotal)}
            </div>
          )}
        </div>
      </div>
      <div className="mt-auto pt-2">
        <Sparkline values={(h.data ?? []).map((x) => x.mem)} max={100} color="var(--chart-2)" />
      </div>
    </div>
  );
}

function DiskWidget() {
  const s = useSystem();
  if (s.isError) return <ErrorBox error={s.error} compact />;
  if (!s.data) return <Loading />;
  return (
    <div className="space-y-3.5">
      {s.data.disks.map((d) => {
        const p = d.total ? (d.used / d.total) * 100 : 0;
        return (
          <div key={d.label}>
            <div className="mb-1.5 flex items-baseline justify-between gap-2 text-xs">
              <span className="truncate font-medium text-fg-2">{d.label}</span>
              <span className="text-muted tabular">{d.ok ? `${bytes(d.free)} liberi` : 'non leggibile'}</span>
            </div>
            <Meter value={p} label={`Utilizzo ${d.label}`} />
            <div className="mt-1 flex justify-between text-[11px] text-muted tabular">
              <span>{bytes(d.used)} usati</span>
              <span>{pct(p)} di {bytes(d.total)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function NetworkWidget() {
  const s = useSystem();
  const h = useHistory(15);
  if (s.isError) return <ErrorBox error={s.error} compact />;
  if (!s.data) return <Loading />;
  const n = s.data.network;
  const up = n.interfaces.filter((i) => i.state === 'up');
  return (
    <div className="flex h-full flex-col">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="flex items-center gap-1 text-[11px] text-muted">
            <ArrowDown className="size-3 text-[var(--chart-3)]" /> Download
          </div>
          <div className="text-lg font-semibold tabular">{rate(n.rxRate)}</div>
        </div>
        <div>
          <div className="flex items-center gap-1 text-[11px] text-muted">
            <ArrowUp className="size-3 text-[var(--chart-1)]" /> Upload
          </div>
          <div className="text-lg font-semibold tabular">{rate(n.txRate)}</div>
        </div>
      </div>
      <div className="mt-1 truncate text-[11px] text-muted">{up.map((i) => i.name).join(', ') || 'Nessuna interfaccia attiva'}</div>
      <div className="mt-auto pt-2">
        <Sparkline values={(h.data ?? []).map((x) => x.rx + x.tx)} color="var(--chart-3)" />
      </div>
    </div>
  );
}

function HostWidget() {
  const s = useSystem();
  if (s.isError) return <ErrorBox error={s.error} compact />;
  if (!s.data) return <Loading />;
  const d = s.data;
  return (
    <dl>
      <Kv k="Host">{d.hostname}</Kv>
      <Kv k="Sistema">{d.os}</Kv>
      <Kv k="Kernel" mono>{d.kernel}</Kv>
      <Kv k="Uptime">{duration(d.uptime)}</Kv>
      <Kv k="Load (1/5/15)">
        <span className="tabular">{d.load.map((l) => l.toFixed(2)).join(' · ')}</span>
      </Kv>
      <Kv k="GPU">{d.gpu ?? 'non rilevata'}</Kv>
    </dl>
  );
}

function HistoryWidget() {
  const h = useHistory(60);
  if (h.isError) return <ErrorBox error={h.error} compact />;
  if (!h.data) return <Skeleton className="h-full min-h-28 w-full" />;
  return (
    <AreaChart
      ariaLabel="CPU e memoria nell'ultima ora"
      times={h.data.map((x) => x.t)}
      max={100}
      yFormat={(v) => `${Math.round(v)}%`}
      series={[
        { key: 'cpu', label: 'CPU', color: 'var(--chart-1)', values: h.data.map((x) => x.cpu) },
        { key: 'mem', label: 'RAM', color: 'var(--chart-2)', values: h.data.map((x) => x.mem) },
      ]}
      height={170}
    />
  );
}

function ContainersWidget() {
  const o = useOverview();
  if (o.isError) return <ErrorBox error={o.error} compact />;
  if (!o.data) return <Loading />;
  if (!o.data.containers) return <ErrorBox error={{ message: o.data.containersError ?? 'Agent non disponibile', status: 503 }} compact />;
  const c = o.data.containers;
  const sorted = [...c.list].sort((a, b) => {
    const rank = (x: typeof a) => (x.health === 'unhealthy' || x.state !== 'running' ? 0 : 1);
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });
  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 grid grid-cols-3 gap-2">
        {[
          ['Attivi', c.running, 'text-ok'],
          ['Fermi', c.stopped, c.stopped ? 'text-err' : 'text-fg'],
          ['Unhealthy', c.unhealthy.length, c.unhealthy.length ? 'text-err' : 'text-fg'],
        ].map(([l, v, cls]) => (
          <div key={l as string} className="rounded-lg bg-surface-2 px-2.5 py-2">
            <div className={cx('text-lg font-semibold tabular', cls as string)}>{v}</div>
            <div className="text-[11px] text-muted">{l}</div>
          </div>
        ))}
      </div>
      <ul className="-mx-1 min-h-0 flex-1 space-y-0.5 overflow-y-auto">
        {sorted.map((x) => (
          <li key={x.id}>
            <Link to={`/docker?c=${encodeURIComponent(x.name)}`} className="flex items-center gap-2 rounded-md px-1 py-1 text-[13px] hover:bg-surface-2">
              <Dot tone={containerTone(x.state, x.health)} />
              <span className="min-w-0 flex-1 truncate">{x.name}</span>
              {x.stats && <span className="text-[11px] text-muted tabular">{bytes(x.stats.memUsed, 0)}</span>}
              {(x.health === 'unhealthy' || x.state !== 'running') && <Badge tone={containerTone(x.state, x.health)}>{containerLabel(x.state, x.health)}</Badge>}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AppsWidget() {
  const o = useOverview();
  if (o.isError) return <ErrorBox error={o.error} compact />;
  if (!o.data) return <Loading />;
  const containers = new Map(o.data.containers?.list.map((c) => [c.name, c]) ?? []);
  const apps = o.data.integrations;
  if (apps.length === 0)
    return (
      <Empty title="Nessuna applicazione collegata" action={<Link className="text-xs text-accent hover:underline" to="/integrazioni">Aggiungi integrazioni</Link>} />
    );
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-2">
      {apps.map((a) => {
        const c = a.config.container ? containers.get(a.config.container) : undefined;
        return <AppTile key={a.id} app={a} container={c ? { state: c.state, health: c.health } : undefined} />;
      })}
    </div>
  );
}

function AppTile({ app, container }: { app: Integration; container?: { state: string; health: string | null } }) {
  const s = STATUS[app.status ?? 'unknown'];
  return (
    <div className="group relative flex flex-col gap-1.5 rounded-xl border border-line bg-surface-2 p-3 transition-colors hover:border-line-strong">
      <div className="flex items-center gap-2">
        <Dot tone={s.tone} pulse={app.status === 'online'} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{app.name}</span>
        <a
          href={app.webUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="text-muted opacity-70 transition-opacity group-hover:opacity-100 hover:text-fg"
          aria-label={`Apri ${app.name}`}
        >
          <ExternalLink className="size-3.5" />
        </a>
      </div>
      <div className="truncate text-[11px] text-muted" title={app.message ?? undefined}>
        {app.message ?? s.label}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <Badge tone={s.tone}>{s.label}</Badge>
        {container && <Badge tone={containerTone(container.state, container.health)}>{containerLabel(container.state, container.health)}</Badge>}
        {app.latency !== null && app.status === 'online' && <span className="text-[11px] text-muted tabular">{app.latency} ms</span>}
      </div>
    </div>
  );
}

function EventsWidget() {
  const o = useOverview();
  if (o.isError) return <ErrorBox error={o.error} compact />;
  if (!o.data) return <Loading />;
  const ev = o.data.events;
  if (ev.length === 0) return <Empty icon={<Siren />} title="Nessun evento registrato">Riavvii, container fermi, problemi di disco e cambi di stato delle integrazioni compariranno qui.</Empty>;
  return (
    <ul className="-mx-1 h-full space-y-0.5 overflow-y-auto">
      {ev.map((e) => (
        <li key={e.id} className="flex items-start gap-2 rounded-md px-1 py-1.5 text-[13px]">
          <span className="mt-1.5">
            <Dot tone={e.level === 'error' ? 'err' : e.level === 'warning' ? 'warn' : 'info'} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate">{e.title}</div>
            {e.details && <div className="truncate text-[11px] text-muted">{e.details}</div>}
          </div>
          <span className="shrink-0 text-[11px] text-muted">{ago(e.ts)}</span>
        </li>
      ))}
    </ul>
  );
}

type Latest = { id: string; name: string; type: string; series: string | null; season: number | null; episode: number | null; year: number | null; added: string | null; imageItemId: string | null };

function NotConfigured({ type, label }: { type: string; label: string }) {
  return (
    <Empty title={`${label} non configurato`} action={<Link className="text-xs text-accent hover:underline" to={`/integrazioni?add=${type}`}>Collega {label}</Link>}>
      Serve una credenziale dedicata per leggere i dati in sola lettura.
    </Empty>
  );
}

function JellyfinWidget() {
  const o = useOverview();
  const jf = byType(o.data?.integrations, 'jellyfin');
  const q = useResource<Latest[]>(jf, 'latest', 'limit=12', 60_000);
  if (!o.data) return <Loading />;
  if (!jf || jf.status === 'unconfigured') return <NotConfigured type="jellyfin" label="Jellyfin" />;
  if (q.isError) return <ErrorBox error={q.error} compact />;
  if (!q.data) return <Loading />;
  if (q.data.length === 0) return <Empty title="Libreria vuota" />;
  return (
    <div className="flex h-full gap-2.5 overflow-x-auto pb-1">
      {q.data.map((i) => (
        <figure key={i.id} className="w-[92px] shrink-0">
          <div className="aspect-[2/3] overflow-hidden rounded-lg bg-surface-3">
            {i.imageItemId && (
              <img
                src={`/api/v1/integrations/${jf.id}/jellyfin/image/${i.imageItemId}`}
                alt=""
                loading="lazy"
                className="size-full object-cover"
              />
            )}
          </div>
          <figcaption className="mt-1.5">
            <div className="truncate text-xs font-medium" title={i.series ?? i.name}>{i.series ?? i.name}</div>
            <div className="truncate text-[11px] text-muted">
              {i.type === 'Episode' ? `S${String(i.season ?? 0).padStart(2, '0')}E${String(i.episode ?? 0).padStart(2, '0')}` : i.year ?? 'Film'} · {ago(i.added)}
            </div>
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

type Torrent = { hash: string; name: string; state: string; progress: number; dlspeed: number; upspeed: number; eta: number; category: string; complete: boolean; size: number };

function DownloadsWidget() {
  const o = useOverview();
  const qb = byType(o.data?.integrations, 'qbittorrent');
  const q = useResource<Torrent[]>(qb, 'torrents', '', 5_000);
  if (!o.data) return <Loading />;
  if (!qb || qb.status === 'unconfigured') return <NotConfigured type="qbittorrent" label="qBittorrent" />;
  if (q.isError) return <ErrorBox error={q.error} compact />;
  if (!q.data) return <Loading />;
  const active = q.data.filter((t) => !t.complete);
  const done = q.data.filter((t) => t.complete);
  const show = [...active, ...done].slice(0, 8);
  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 flex gap-3 text-xs text-muted">
        <span>
          <b className="text-fg tabular">{active.length}</b> in corso
        </span>
        <span>
          <b className="text-fg tabular">{done.length}</b> completati
        </span>
      </div>
      {show.length === 0 ? (
        <Empty icon={<Download />} title="Nessun torrent" />
      ) : (
        <ul className="min-h-0 flex-1 space-y-2.5 overflow-y-auto">
          {show.map((t) => (
            <li key={t.hash}>
              <div className="flex items-baseline gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate font-medium" title={t.name}>{t.name}</span>
                <span className="shrink-0 text-muted tabular">{t.complete ? 'completato' : `${rate(t.dlspeed)} · ${eta(t.eta)}`}</span>
              </div>
              <Meter className="mt-1" value={t.progress * 100} tone={t.complete ? 'ok' : 'info'} label={t.name} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export const WIDGETS: Record<string, WidgetDef> = {
  cpu: { title: 'CPU', icon: <Cpu />, description: 'Utilizzo, temperatura e load', size: { w: 3, h: 5, minW: 3, minH: 4 }, Component: CpuWidget },
  memory: { title: 'Memoria', icon: <MemoryStick />, description: 'RAM e swap', size: { w: 3, h: 5, minW: 3, minH: 4 }, Component: MemoryWidget },
  disk: { title: 'Dischi', icon: <HardDrive />, description: 'Spazio occupato', size: { w: 3, h: 5, minW: 3, minH: 3 }, Component: DiskWidget },
  network: { title: 'Rete', icon: <Network />, description: 'Traffico in tempo reale', size: { w: 3, h: 5, minW: 3, minH: 4 }, Component: NetworkWidget },
  history: { title: 'Ultima ora', icon: <History />, description: 'Andamento CPU e RAM', size: { w: 8, h: 7, minW: 4, minH: 5 }, Component: HistoryWidget },
  host: { title: 'Host', icon: <Server />, description: 'Sistema, kernel, uptime', size: { w: 4, h: 7, minW: 3, minH: 5 }, Component: HostWidget },
  apps: { title: 'Applicazioni', icon: <LayoutGrid />, description: 'Stato delle app collegate', size: { w: 8, h: 6, minW: 4, minH: 4 }, Component: AppsWidget },
  containers: { title: 'Container', icon: <Boxes />, description: 'Salute dei container Docker', size: { w: 4, h: 11, minW: 3, minH: 6 }, Component: ContainersWidget },
  jellyfin: { title: 'Aggiunti di recente', icon: <Clapperboard />, description: 'Ultimi contenuti Jellyfin', size: { w: 8, h: 6, minW: 4, minH: 5 }, Component: JellyfinWidget },
  downloads: { title: 'Download', icon: <Download />, description: 'Torrent qBittorrent', size: { w: 6, h: 7, minW: 3, minH: 4 }, Component: DownloadsWidget },
  events: { title: 'Eventi recenti', icon: <Siren />, description: 'Riavvii, errori, avvisi', size: { w: 6, h: 7, minW: 3, minH: 4 }, Component: EventsWidget },
};

export const DEFAULT_LAYOUT = [
  { i: 'cpu', type: 'cpu', x: 0, y: 0 },
  { i: 'memory', type: 'memory', x: 3, y: 0 },
  { i: 'disk', type: 'disk', x: 6, y: 0 },
  { i: 'network', type: 'network', x: 9, y: 0 },
  { i: 'history', type: 'history', x: 0, y: 5 },
  { i: 'host', type: 'host', x: 8, y: 5 },
  { i: 'apps', type: 'apps', x: 0, y: 12 },
  { i: 'containers', type: 'containers', x: 8, y: 12 },
  { i: 'jellyfin', type: 'jellyfin', x: 0, y: 18 },
  { i: 'downloads', type: 'downloads', x: 0, y: 24 },
  { i: 'events', type: 'events', x: 6, y: 24 },
].map((l) => ({ ...l, w: WIDGETS[l.type].size.w, h: WIDGETS[l.type].size.h }));

export function WidgetFrame({ type, editing, onRemove }: { type: string; editing: boolean; onRemove: () => void }) {
  const def = WIDGETS[type];
  if (!def) return <Card title="Widget sconosciuto">—</Card>;
  return (
    <Card
      title={def.title}
      icon={def.icon}
      dragHandle={editing}
      className={cx('h-full', editing && 'ring-1 ring-accent/40')}
      bodyClassName="overflow-hidden"
      actions={
        editing ? (
          <button onClick={onRemove} className="rounded-md px-1.5 py-0.5 text-xs text-muted hover:bg-err-soft hover:text-err" aria-label={`Rimuovi ${def.title}`}>
            Rimuovi
          </button>
        ) : undefined
      }
    >
      <def.Component />
    </Card>
  );
}

export { StatusBadge, meterTone };
