import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Globe, KeyRound, ListMusic, Music2, Pause, Play, Radio, ScrollText, Server, SkipBack, SkipForward, Speaker, Volume2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { AreaChart } from '../components/Chart';
import { Badge, Button, Card, containerLabel, containerTone, cx, Dot, Empty, ErrorBox, Kv, PageHeader, Skeleton, StatusBadge, useToast } from '../components/ui';
import { api, type Integration } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ago, bytes, duration, pct } from '../lib/format';
import { byType, useContainers, useIntegrations, useResource } from '../lib/queries';

type Info = { api: number; version: string | null; name: string | null; publicUrl: string | null; capabilities: string[] };
type Live = {
  now: number;
  devices: {
    device: string;
    name: string;
    state: {
      playing: boolean;
      position: number;
      duration: number;
      volume: number;
      shuffle: boolean;
      repeat: string;
      at: number;
      radio: boolean;
      track: { title: string; artist: string; album: string; genre: string | null } | null;
    } | null;
  }[];
};
type ServerStatus = {
  version: string;
  uptime: number;
  threads: number;
  disk: { total: number; used: number; free: number };
  streams: number;
  listeners: { user: string; name: string; net: string; since: number }[];
  jobs: { byStatus: Record<string, number>; queue: number };
  navidromeMs: number | null;
  domain: { name: string; issuer: string; expires: number; days: number; port: number; problems: string[] } | null;
  series: { t: number; cpu: number; rss: number; req: number; live: number }[];
};
type LogData = { day: Record<string, number>; items: { id: number; level: string; area: string; msg: string; detail: string; count: number; last: number; user: string | null }[] };

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function ArmonyPage() {
  const { isAdmin } = useAuth();
  const ints = useIntegrations();
  const containers = useContainers();
  const armony = byType(ints.data, 'armony');
  const nd = byType(ints.data, 'navidrome');
  const keyed = armony?.auth === 'apikey';
  const info = useResource<Info>(armony, 'info', '', 60_000);
  const scan = useResource<{ supported: boolean; scanning?: boolean; count?: number; lastScan?: string }>(nd, 'scan', '', 60_000);
  const stack = (containers.data ?? []).filter((c) => c.composeProject === 'armony');

  return (
    <div>
      <PageHeader
        title="Armony"
        description="La tua app musicale e il suo stack. GIGI OS osserva e invia solo i comandi che chiedi: Armony funziona anche se GIGI OS è spento."
        actions={
          armony && (
            <a href={armony.webUrl} target="_blank" rel="noreferrer noopener">
              <Button size="sm">
                Apri Armony <ExternalLink />
              </Button>
            </a>
          )
        }
      />
      {armony && !keyed && (
        <Card className="mb-4">
          <div className="flex flex-wrap items-center gap-3">
            <KeyRound className="size-5 text-accent" />
            <div className="min-w-0 flex-1 text-xs text-muted">
              <div className="text-[13px] font-medium text-fg-2">Collega Armony con una chiave API</div>
              Con la chiave GIGI OS mostra dispositivi e brani in riproduzione, stato del server, registro eventi e può inviare play/pausa/volume.
            </div>
            {isAdmin && (
              <Link to="/integrazioni?add=armony">
                <Button size="sm" variant="primary">
                  Inserisci chiave
                </Button>
              </Link>
            )}
          </div>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        {armony && keyed && <NowPlaying armony={armony} />}

        <Card title="Armony" icon={<Music2 />} actions={armony && <StatusBadge status={armony.status} />}>
          {!armony ? (
            <p className="text-xs text-muted">
              Integrazione non presente. <Link to="/integrazioni?add=armony" className="text-accent hover:underline">Aggiungila</Link>.
            </p>
          ) : info.isError ? (
            <ErrorBox error={info.error} compact />
          ) : !info.data ? (
            <Skeleton className="h-24" />
          ) : (
            <dl>
              <Kv k="Istanza">{info.data.name ?? '—'}</Kv>
              <Kv k="Versione">{info.data.version ?? '—'}</Kv>
              <Kv k="Accesso">{armony.message ?? '—'}</Kv>
              <Kv k="Indirizzo pubblico">
                {info.data.publicUrl ? (
                  <span className="inline-flex items-center gap-1">
                    <Globe className="size-3.5 text-warn" /> {info.data.publicUrl}
                  </span>
                ) : (
                  '—'
                )}
              </Kv>
            </dl>
          )}
        </Card>
        <Card title="Navidrome" icon={<Radio />} actions={nd && <StatusBadge status={nd.status} />}>
          {!nd ? (
            <p className="text-xs text-muted">Integrazione non presente.</p>
          ) : (
            <dl>
              <Kv k="Endpoint">{nd.baseUrl}</Kv>
              <Kv k="Stato">{nd.message ?? '—'}</Kv>
              <Kv k="Scansione">
                {scan.data?.supported ? (
                  <>
                    {scan.data.scanning ? <Badge tone="info">in corso</Badge> : 'inattiva'} · {scan.data.count ?? 0} brani · {ago(scan.data.lastScan ?? null)}
                  </>
                ) : (
                  <span className="text-muted">servono credenziali Subsonic</span>
                )}
              </Kv>
            </dl>
          )}
          <p className="mt-3 text-[11px] text-muted">Relazione preservata: armony-app → armony-navidrome. Nessuna scrittura nella libreria né nel database di Navidrome.</p>
        </Card>
        <Card title="Stack Docker «armony»">
          {containers.isError && <ErrorBox error={containers.error} compact />}
          {!containers.data && !containers.isError && <Skeleton className="h-24" />}
          <ul className="space-y-1.5">
            {stack.map((c) => (
              <li key={c.id}>
                <Link to={`/docker?c=${encodeURIComponent(c.name)}`} className="flex items-center gap-2 rounded-md px-1 py-1 text-[13px] hover:bg-surface-2">
                  <Dot tone={containerTone(c.state, c.health)} />
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  <span className="text-[11px] text-muted tabular">
                    {c.stats ? `${pct(c.stats.cpu, 1)} · ${bytes(c.stats.memUsed, 0)}` : containerLabel(c.state, c.health)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>

        {armony && keyed && isAdmin && <ServerCard armony={armony} />}
        {armony && keyed && isAdmin && <LogCard armony={armony} />}

        {info.data && (
          <Card title={`Capability dichiarate (${info.data.capabilities.length})`} className="lg:col-span-3" subtitle="Lette da /api/info.">
            <div className="flex flex-wrap gap-1">
              {info.data.capabilities.map((c) => (
                <Badge key={c}>{c}</Badge>
              ))}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

function NowPlaying({ armony }: { armony: Integration }) {
  const { isOperator } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const live = useResource<Live>(armony, 'live', '', 5_000);
  const cmd = useMutation({
    mutationFn: (b: { to: string; cmd: string; value?: number }) => api(`/integrations/${armony.id}/actions/command`, { method: 'POST', body: b }),
    onSuccess: () => setTimeout(() => void qc.invalidateQueries({ queryKey: ['resource', armony.id, 'live'] }), 700),
    onError: (e: Error) => toast('err', e.message),
  });
  return (
    <Card title="In riproduzione" icon={<Speaker />} className="lg:col-span-3" subtitle="Dispositivi collegati ad Armony, aggiornati ogni 5 secondi.">
      {live.isError && <ErrorBox error={live.error} compact />}
      {!live.data && !live.isError && <Skeleton className="h-24" />}
      {live.data && live.data.devices.length === 0 && <Empty icon={<Speaker />} title="Nessun dispositivo collegato" />}
      {live.data && live.data.devices.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {live.data.devices.map((d) => {
            const s = d.state;
            const elapsed = s ? Math.min(s.duration || 0, s.position + (s.playing ? Math.max(0, live.data!.now - s.at) : 0)) : 0;
            return (
              <div key={d.device} className="rounded-xl border border-line bg-surface-2 p-3.5">
                <div className="flex items-center gap-2 text-xs text-muted">
                  <Dot tone={s?.playing ? 'ok' : 'idle'} pulse={s?.playing} />
                  <span className="font-medium text-fg-2">{d.name}</span>
                  {s?.radio && <Badge tone="accent">radio</Badge>}
                  {s && <span className="ml-auto inline-flex items-center gap-1 tabular"><Volume2 className="size-3.5" /> {s.volume}</span>}
                </div>
                {s?.track ? (
                  <div className="mt-2.5">
                    <div className="truncate text-[15px] font-semibold" title={s.track.title}>{s.track.title}</div>
                    <div className="truncate text-xs text-fg-2">
                      {s.track.artist} · <span className="text-muted">{s.track.album}</span>
                    </div>
                    {s.duration > 0 && (
                      <div className="mt-2.5">
                        <div className="h-1 overflow-hidden rounded-full bg-surface-3">
                          <div className="h-full rounded-full bg-accent" style={{ width: `${(elapsed / s.duration) * 100}%` }} />
                        </div>
                        <div className="mt-1 flex justify-between text-[11px] text-muted tabular">
                          <span>{mmss(elapsed)}</span>
                          <span>{mmss(s.duration)}</span>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="mt-2.5 text-xs text-muted">Niente in riproduzione.</p>
                )}
                {isOperator && s && (
                  <div className="mt-3 flex items-center gap-1">
                    <Button size="icon" variant="ghost" aria-label="Precedente" onClick={() => cmd.mutate({ to: d.device, cmd: 'prev' })}>
                      <SkipBack />
                    </Button>
                    <Button size="icon" variant="secondary" aria-label={s.playing ? 'Pausa' : 'Riproduci'} onClick={() => cmd.mutate({ to: d.device, cmd: s.playing ? 'pause' : 'play' })}>
                      {s.playing ? <Pause /> : <Play />}
                    </Button>
                    <Button size="icon" variant="ghost" aria-label="Successivo" onClick={() => cmd.mutate({ to: d.device, cmd: 'next' })}>
                      <SkipForward />
                    </Button>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      defaultValue={s.volume}
                      aria-label={`Volume ${d.name}`}
                      className="ml-auto w-28 accent-[var(--accent)]"
                      onPointerUp={(e) => cmd.mutate({ to: d.device, cmd: 'volume', value: Number((e.target as HTMLInputElement).value) })}
                      onKeyUp={(e) => ['ArrowLeft', 'ArrowRight'].includes(e.key) && cmd.mutate({ to: d.device, cmd: 'volume', value: Number((e.target as HTMLInputElement).value) })}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function ServerCard({ armony }: { armony: Integration }) {
  const s = useResource<ServerStatus>(armony, 'server', '', 15_000);
  return (
    <Card title="Server Armony" icon={<Server />} className="lg:col-span-2">
      {s.isError && <ErrorBox error={s.error} compact />}
      {!s.data && !s.isError && <Skeleton className="h-40" />}
      {s.data && (
        <>
          <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              ['In ascolto', s.data.listeners.length],
              ['Flussi audio', s.data.streams],
              ['Lavori in coda', s.data.jobs.queue],
              ['Navidrome', s.data.navidromeMs !== null ? `${s.data.navidromeMs} ms` : '—'],
            ].map(([k, v]) => (
              <div key={k as string} className="rounded-lg bg-surface-2 px-3 py-2">
                <div className="text-[11px] text-muted">{k}</div>
                <div className="text-sm font-semibold tabular">{v}</div>
              </div>
            ))}
          </div>
          {s.data.series.length > 1 && (
            <AreaChart
              ariaLabel="CPU del processo Armony"
              times={s.data.series.map((x) => x.t)}
              yFormat={(v) => `${Math.round(v)}%`}
              series={[{ key: 'cpu', label: 'CPU Armony', color: 'var(--chart-1)', values: s.data.series.map((x) => x.cpu) }]}
              height={120}
            />
          )}
          <dl className="mt-3">
            <Kv k="Versione">{s.data.version}</Kv>
            <Kv k="Attivo da">{duration(s.data.uptime)}</Kv>
            <Kv k="Thread">{s.data.threads}</Kv>
            <Kv k="Ascoltatori">{s.data.listeners.map((l) => `${l.user} (${l.name}, ${l.net})`).join(', ') || 'nessuno'}</Kv>
            {s.data.domain && (
              <Kv k={`Certificato ${s.data.domain.name}`}>
                <span className={cx(s.data.domain.days < 15 ? 'text-err' : s.data.domain.days < 30 ? 'text-warn' : '')}>
                  {s.data.domain.issuer}, scade tra {s.data.domain.days} giorni
                </span>
                {s.data.domain.problems.length > 0 && <Badge tone="err" className="ml-1">{s.data.domain.problems.length} problemi</Badge>}
              </Kv>
            )}
          </dl>
        </>
      )}
    </Card>
  );
}

function LogCard({ armony }: { armony: Integration }) {
  const l = useResource<LogData>(armony, 'log', 'limit=40', 30_000);
  return (
    <Card title="Registro eventi" icon={<ScrollText />} subtitle={l.data ? `Ultime 24 h: ${Object.entries(l.data.day).map(([k, v]) => `${v} ${k}`).join(' · ') || 'nessun evento'}` : undefined}>
      {l.isError && <ErrorBox error={l.error} compact />}
      {!l.data && !l.isError && <Skeleton className="h-40" />}
      {l.data && l.data.items.length === 0 && <Empty icon={<ListMusic />} title="Registro vuoto" />}
      {l.data && l.data.items.length > 0 && (
        <ul className="max-h-[420px] space-y-1 overflow-y-auto">
          {l.data.items.map((x) => (
            <li key={x.id} className="rounded-md px-1 py-1.5 text-xs">
              <div className="flex items-center gap-1.5">
                <Dot tone={x.level === 'errore' ? 'err' : x.level === 'avviso' ? 'warn' : 'info'} />
                <span className="min-w-0 flex-1 truncate text-fg-2" title={x.detail || x.msg}>{x.msg}</span>
                {x.count > 1 && <span className="text-muted tabular">×{x.count}</span>}
              </div>
              <div className="pl-3.5 text-[11px] text-muted">
                {x.area} · {ago(x.last)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
