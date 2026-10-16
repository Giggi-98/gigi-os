// Rete (D-026): schede rilevate, servizi in ascolto, firewall, connessioni, test, dispositivi in LAN.
// Tutto in sola lettura sull'host: le modifiche a IP e regole UFW non sono disponibili (vedi LEGGIMI).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cable, Gauge, Globe, Moon, Pencil, Play, Power, Radar, RefreshCw, Router, ShieldAlert, ShieldCheck, Trash2, Wifi, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Badge, Button, Card, cx, Dot, Empty, ErrorBox, Field, Input, Kv, PageHeader, Select, Skeleton, Tabs, useToast, type Tone } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ago, bytes, dateTime, num, rate } from '../lib/format';

type Iface = {
  name: string;
  kind: 'ethernet' | 'wifi' | 'bridge' | 'veth' | 'virtual' | 'loopback';
  state: string | null;
  carrier: boolean;
  mac: string | null;
  mtu: number | null;
  speed: number | null;
  duplex: string | null;
  driver: string | null;
  docker: string | null;
  wifi: { quality: number; signal: number } | null;
  addresses: { family: string; address: string; cidr: string | null; scope: string }[];
  rx: number;
  tx: number;
  rxRate: number | null;
  txRate: number | null;
  errors: number;
  dropped: number;
};
type Overview = {
  hostname: string;
  interfaces: Iface[];
  routes: { v4: { iface: string; destination: string; gateway: string | null; metric: number; isDefault: boolean }[]; v6Default: { iface: string; gateway: string }[] };
  dns: { servers: string[]; search: string[]; source: string | null };
  forwarding: boolean;
};

type Tab = 'overview' | 'services' | 'firewall' | 'connections' | 'tests' | 'devices';

export function NetworkPage() {
  const { isAdmin } = useAuth();
  const [tab, setTab] = useState<Tab>('overview');
  const ov = useQuery({ queryKey: ['net-overview'], queryFn: () => api<Overview>('/network/overview'), refetchInterval: 3000 });
  const def = ov.data?.routes.v4.find((r) => r.isDefault);
  return (
    <div>
      <PageHeader
        title="Rete"
        description={ov.data ? `${ov.data.hostname} · gateway ${def?.gateway ?? '—'} su ${def?.iface ?? '—'} · DNS ${ov.data.dns.servers.join(', ') || '—'}` : 'Schede, servizi, firewall e diagnostica'}
      />
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { id: 'overview', label: 'Schede' },
          ...(isAdmin
            ? ([
                { id: 'services', label: 'Servizi in ascolto' },
                { id: 'firewall', label: 'Firewall' },
                { id: 'connections', label: 'Connessioni' },
                { id: 'tests', label: 'Test di rete' },
                { id: 'devices', label: 'Dispositivi' },
              ] as { id: Tab; label: string }[])
            : []),
        ]}
      />
      <div className="mt-4">
        {tab === 'overview' && <OverviewTab q={ov} />}
        {tab === 'services' && <ServicesTab />}
        {tab === 'firewall' && <FirewallTab />}
        {tab === 'connections' && <ConnectionsTab />}
        {tab === 'tests' && <TestsTab />}
        {tab === 'devices' && <DevicesTab />}
      </div>
    </div>
  );
}

// ───────────── Schede ─────────────

const KIND: Record<Iface['kind'], { label: string; icon: ReactNode }> = {
  ethernet: { label: 'Ethernet', icon: <Cable /> },
  wifi: { label: 'Wi-Fi', icon: <Wifi /> },
  bridge: { label: 'Bridge', icon: <Router /> },
  veth: { label: 'veth', icon: <Cable /> },
  virtual: { label: 'Virtuale', icon: <Cable /> },
  loopback: { label: 'Loopback', icon: <Cable /> },
};
const ifTone = (i: Iface): Tone => (i.state === 'up' ? 'ok' : i.kind === 'loopback' ? 'idle' : i.state === 'down' ? 'idle' : 'warn');
const mbit = (n: number) => (n >= 1000 ? `${n / 1000} Gbit/s` : `${n} Mbit/s`);

function OverviewTab({ q }: { q: ReturnType<typeof useQuery<Overview>> }) {
  const { isAdmin } = useAuth();
  const [showVirtual, setShowVirtual] = useState(false);
  if (q.isError) return <ErrorBox error={q.error} />;
  if (!q.data) return <Skeleton className="h-64 w-full" />;
  const d = q.data;
  const physical = d.interfaces.filter((i) => i.kind === 'ethernet' || i.kind === 'wifi');
  const docker = d.interfaces.filter((i) => i.kind === 'bridge' || i.kind === 'veth');
  const other = d.interfaces.filter((i) => i.kind === 'virtual' || i.kind === 'loopback');
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-3">
        {isAdmin && <PublicIpCard />}
        <Card title="Instradamento e DNS" icon={<Router />} className={isAdmin ? 'lg:col-span-2' : 'lg:col-span-3'}>
          <dl>
            {d.routes.v4.filter((r) => r.isDefault).map((r) => (
              <Kv key={r.iface} k="Gateway IPv4" mono>{`${r.gateway} via ${r.iface} (metrica ${r.metric})`}</Kv>
            ))}
            {d.routes.v6Default.map((r) => (
              <Kv key={r.iface + r.gateway} k="Gateway IPv6" mono>{`${r.gateway} via ${r.iface}`}</Kv>
            ))}
            <Kv k="Server DNS" mono>{d.dns.servers.join(', ') || 'non leggibili'}</Kv>
            {d.dns.search.length > 0 && <Kv k="Domini di ricerca" mono>{d.dns.search.join(' ')}</Kv>}
            <Kv k="Inoltro IP">{d.forwarding ? 'attivo (necessario a Docker)' : 'disattivo'}</Kv>
          </dl>
        </Card>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {physical.map((i) => <IfaceCard key={i.name} i={i} />)}
      </div>
      <Card
        title={`Reti Docker e interfacce virtuali (${docker.length + other.length})`}
        actions={<Button size="sm" variant="ghost" onClick={() => setShowVirtual((v) => !v)}>{showVirtual ? 'Nascondi' : 'Mostra'}</Button>}
        bodyClassName={showVirtual ? '!p-0' : undefined}
      >
        {!showVirtual ? (
          <p className="text-xs text-muted">
            {docker.filter((i) => i.kind === 'bridge').length} bridge, {docker.filter((i) => i.kind === 'veth').length} collegamenti di container, {other.length} altre. Traffico totale bridge: ↓ {rate(docker.filter((i) => i.kind === 'bridge').reduce((a, i) => a + (i.rxRate ?? 0), 0))} · ↑ {rate(docker.filter((i) => i.kind === 'bridge').reduce((a, i) => a + (i.txRate ?? 0), 0))}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-[13px]">
              <thead className="border-y border-line text-xs text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Interfaccia</th>
                  <th className="px-3 py-2 font-medium">Rete Docker</th>
                  <th className="px-3 py-2 font-medium">Indirizzo</th>
                  <th className="px-3 py-2 text-right font-medium">↓ / ↑</th>
                  <th className="px-4 py-2 text-right font-medium">Totale</th>
                </tr>
              </thead>
              <tbody>
                {[...docker, ...other].map((i) => (
                  <tr key={i.name} className="border-b border-line/60 last:border-0">
                    <td className="px-4 py-1.5"><span className="inline-flex items-center gap-2"><Dot tone={ifTone(i)} /><span className="font-mono text-xs">{i.name}</span></span></td>
                    <td className="px-3 py-1.5 text-fg-2">{i.docker ?? (i.kind === 'veth' ? 'container' : KIND[i.kind].label)}</td>
                    <td className="px-3 py-1.5 font-mono text-xs">{i.addresses.find((a) => a.family === 'IPv4')?.cidr ?? '—'}</td>
                    <td className="px-3 py-1.5 text-right text-xs tabular">{rate(i.rxRate)} / {rate(i.txRate)}</td>
                    <td className="px-4 py-1.5 text-right text-xs text-muted tabular">{bytes(i.rx + i.tx)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="text-xs text-muted">
        Indirizzi e profili di rete sono gestiti da NetworkManager sull’host. Modificarli da GIGI OS richiederebbe privilegi di root che al momento non sono concessi: usa <span className="font-mono">nmtui</span> via SSH.
      </p>
    </div>
  );
}

function IfaceCard({ i }: { i: Iface }) {
  const v4 = i.addresses.filter((a) => a.family === 'IPv4');
  const v6 = i.addresses.filter((a) => a.family === 'IPv6');
  return (
    <Card
      title={<span className="inline-flex items-center gap-2"><Dot tone={ifTone(i)} />{i.name}</span>}
      subtitle={`${KIND[i.kind].label}${i.driver ? ` · ${i.driver}` : ''}`}
      icon={KIND[i.kind].icon}
      actions={<Badge tone={ifTone(i)}>{i.state === 'up' ? (i.speed ? mbit(i.speed) : 'attiva') : i.carrier ? 'collegata' : 'scollegata'}</Badge>}
    >
      {i.state === 'up' && (
        <div className="mb-3 grid grid-cols-2 gap-2">
          <div className="rounded-lg bg-surface-2 px-3 py-2">
            <div className="text-[11px] text-muted">Download</div>
            <div className="text-base font-semibold tabular">{rate(i.rxRate)}</div>
          </div>
          <div className="rounded-lg bg-surface-2 px-3 py-2">
            <div className="text-[11px] text-muted">Upload</div>
            <div className="text-base font-semibold tabular">{rate(i.txRate)}</div>
          </div>
        </div>
      )}
      <dl>
        <Kv k="IPv4" mono>{v4.map((a) => a.cidr).join(', ') || '—'}</Kv>
        {v6.length > 0 && <Kv k="IPv6" mono>{v6.map((a) => a.cidr).join(', ')}</Kv>}
        <Kv k="MAC" mono>{i.mac ?? '—'}</Kv>
        <Kv k="MTU">{i.mtu ?? '—'}{i.duplex ? ` · ${i.duplex === 'full' ? 'full duplex' : i.duplex}` : ''}</Kv>
        {i.wifi && <Kv k="Segnale">{`${i.wifi.signal} dBm · qualità ${i.wifi.quality}`}</Kv>}
        <Kv k="Totale">↓ {bytes(i.rx)} · ↑ {bytes(i.tx)}</Kv>
        <Kv k="Errori / scartati">
          <span className={i.errors > 0 ? 'text-warn' : undefined}>{num(i.errors)}</span> / {num(i.dropped)}
        </Kv>
      </dl>
    </Card>
  );
}

type PublicIp = { v4: string | null; v6: string | null; ptr: string | null; checkedAt: number; previous: string | null };
type MonitorCfg = { publicIp: boolean; devices: boolean };

function PublicIpCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['net-public'], queryFn: () => api<PublicIp>('/network/public-ip'), staleTime: 60_000 });
  const refresh = useMutation({ mutationFn: () => api<PublicIp>('/network/public-ip?refresh=1'), onSuccess: (d) => qc.setQueryData(['net-public'], d) });
  const mon = useMonitor();
  return (
    <Card title="IP pubblico" icon={<Globe />} actions={<Button size="icon" variant="ghost" aria-label="Aggiorna IP pubblico" onClick={() => refresh.mutate()} disabled={refresh.isPending}><RefreshCw className={cx(refresh.isPending && 'animate-spin')} /></Button>}>
      {q.isError ? (
        <ErrorBox error={q.error} compact />
      ) : !q.data ? (
        <Skeleton className="h-16 w-full" />
      ) : (
        <>
          <div className="font-mono text-xl font-semibold tracking-tight">{q.data.v4 ?? 'non rilevato'}</div>
          <dl className="mt-2">
            <Kv k="IPv6" mono>{q.data.v6 ?? 'assente'}</Kv>
            {q.data.ptr && <Kv k="Nome inverso" mono>{q.data.ptr}</Kv>}
            <Kv k="Verificato">{ago(q.data.checkedAt)}</Kv>
          </dl>
          <label className="mt-3 flex items-center gap-2 text-xs text-fg-2">
            <input type="checkbox" className="size-4 [--check:var(--accent)]" checked={!!mon.data?.publicIp} disabled={!mon.data || mon.save.isPending} onChange={(e) => mon.save.mutate({ ...mon.data!, publicIp: e.target.checked })} />
            Controlla ogni 15 minuti e crea un evento «rete» se cambia
          </label>
          <p className="mt-1 text-[11px] text-muted">Servizio usato: api.ipify.org (riserva: icanhazip.com).</p>
        </>
      )}
    </Card>
  );
}

function useMonitor() {
  const qc = useQueryClient();
  const data = useQuery({ queryKey: ['net-monitor'], queryFn: () => api<MonitorCfg>('/network/monitor') }).data;
  const save = useMutation({ mutationFn: (m: MonitorCfg) => api<MonitorCfg>('/network/monitor', { method: 'PUT', body: m }), onSuccess: (m) => qc.setQueryData(['net-monitor'], m) });
  return { data, save };
}

// ───────────── Servizi in ascolto ─────────────

type Listening = {
  items: { proto: string; port: number; addresses: string[]; scope: 'all' | 'local' | 'specific'; service: string | null; source: 'docker' | 'nota' | null; ephemeral: boolean; bypassUfw: boolean; allowedFrom: string[] | null }[];
  hostNetworkContainers: string[];
  firewallKnown: boolean;
};

function ServicesTab() {
  const q = useQuery({ queryKey: ['net-listening'], queryFn: () => api<Listening>('/network/listening'), refetchInterval: 15_000 });
  const [eph, setEph] = useState(false);
  if (q.isError) return <ErrorBox error={q.error} />;
  if (!q.data) return <Skeleton className="h-64 w-full" />;
  const rows = q.data.items.filter((i) => eph || !i.ephemeral);
  const hidden = q.data.items.length - q.data.items.filter((i) => !i.ephemeral).length;
  const scope = (s: string, addrs: string[]) =>
    s === 'all' ? <Badge tone="warn">tutte le interfacce</Badge> : s === 'local' ? <Badge tone="ok">solo locale</Badge> : <Badge tone="info">{addrs.filter((a) => a !== '::').join(', ')}</Badge>;
  return (
    <Card
      bodyClassName="!p-0"
      title={`${q.data.items.length - hidden} porte in ascolto`}
      subtitle={`Container in rete host (porte non attribuibili con certezza): ${q.data.hostNetworkContainers.join(', ') || 'nessuno'}`}
      actions={hidden > 0 && <Button size="sm" variant="ghost" onClick={() => setEph((v) => !v)}>{eph ? 'Nascondi' : 'Mostra'} {hidden} porte effimere</Button>}
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] text-left text-[13px]">
          <thead className="border-y border-line text-xs text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">Porta</th>
              <th className="px-3 py-2 font-medium">Servizio</th>
              <th className="px-3 py-2 font-medium">In ascolto su</th>
              <th className="px-4 py-2 font-medium">Firewall</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((i) => (
              <tr key={`${i.proto}/${i.port}`} className="border-b border-line/60 last:border-0">
                <td className="px-4 py-2 font-mono text-xs">{i.port}/{i.proto}</td>
                <td className="px-3 py-2">
                  {i.service ?? <span className="text-muted">sconosciuto</span>}
                  {i.source === 'nota' && <span className="ml-1.5 text-[11px] text-muted">(porta nota)</span>}
                  {i.source === 'docker' && <Badge className="ml-1.5">container</Badge>}
                </td>
                <td className="px-3 py-2">{scope(i.scope, i.addresses)}</td>
                <td className="px-4 py-2 text-xs">
                  {i.scope === 'local' ? (
                    <span className="text-muted">non raggiungibile da fuori</span>
                  ) : i.bypassUfw ? (
                    <Badge tone="err">Docker scavalca UFW</Badge>
                  ) : i.allowedFrom === null ? (
                    <span className="text-muted">regole non lette</span>
                  ) : i.allowedFrom.length ? (
                    <span>consentita da {i.allowedFrom.join(', ')}</span>
                  ) : (
                    <Badge tone="ok">bloccata da UFW</Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ───────────── Firewall ─────────────

type Firewall = {
  snapshot: { status: string | null; logging: string | null; defaults: string | null; updatedAt: number; rules: { to: string; action: string; from: string; v6: boolean; comment: string | null }[] } | null;
  findings: { level: 'warn' | 'info' | 'ok'; message: string }[];
  snapshotPath: string;
};
type Blocked = {
  hours: number;
  total: number;
  truncated: boolean;
  sources: { src: string; count: number; ports: string[]; last: number; iface: string }[];
  ports: { port: string; count: number; sources: number }[];
  recent: { t: number; src: string; dst: string; proto: string; dport: string; iface: string }[];
};

function FirewallTab() {
  const q = useQuery({ queryKey: ['net-firewall'], queryFn: () => api<Firewall>('/network/firewall'), refetchInterval: 60_000 });
  const [hours, setHours] = useState(24);
  const b = useQuery({ queryKey: ['net-blocked', hours], queryFn: () => api<Blocked>(`/network/firewall/blocked?hours=${hours}`), refetchInterval: 60_000 });
  if (q.isError) return <ErrorBox error={q.error} />;
  if (!q.data) return <Skeleton className="h-64 w-full" />;
  const f = q.data;
  // Senza istantanea lo stato si deduce dai blocchi nel journal: se UFW blocca, è attivo
  const ufwActive: boolean | null = f.snapshot ? f.snapshot.status === 'active' : b.data ? (b.data.total > 0 ? true : null) : null;
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="UFW" icon={ufwActive ? <ShieldCheck /> : <ShieldAlert />}>
          <div className={cx('text-lg font-semibold', ufwActive === null ? 'text-muted' : ufwActive ? 'text-ok' : 'text-err')}>
            {ufwActive === null ? 'Stato sconosciuto' : ufwActive ? 'Attivo' : 'Non attivo'}
          </div>
          <dl className="mt-2">
            {f.snapshot ? (
              <>
                <Kv k="Predefinito">{f.snapshot.defaults ?? '—'}</Kv>
                <Kv k="Log">{f.snapshot.logging ?? '—'}</Kv>
                <Kv k="Regole aggiornate">{ago(f.snapshot.updatedAt)}</Kv>
              </>
            ) : (
              <Kv k="Fonte">{ufwActive ? 'dedotto dai pacchetti bloccati nel journal' : 'nessun blocco registrato: installa l’istantanea per saperlo'}</Kv>
            )}
          </dl>
        </Card>
        <Card title="Analisi" className="lg:col-span-2">
          {f.findings.length === 0 ? (
            <p className="text-xs text-muted">Nessuna osservazione.</p>
          ) : (
            <ul className="space-y-1.5">
              {f.findings.map((x, i) => (
                <li key={i} className="flex items-start gap-2 text-[13px]">
                  <Badge tone={x.level === 'warn' ? 'warn' : x.level === 'ok' ? 'ok' : 'info'} className="shrink-0">{x.level === 'warn' ? 'Attenzione' : x.level === 'ok' ? 'OK' : 'Nota'}</Badge>
                  <span>{x.message}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {f.snapshot ? (
        <Card title={`Regole (${f.snapshot.rules.length})`} subtitle="Istantanea in sola lettura, aggiornata ogni 5 minuti dal timer gigi-ufw-snapshot." bodyClassName="!p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-[13px]">
              <thead className="border-y border-line text-xs text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Destinazione</th>
                  <th className="px-3 py-2 font-medium">Azione</th>
                  <th className="px-3 py-2 font-medium">Da</th>
                  <th className="px-4 py-2 font-medium">Nota</th>
                </tr>
              </thead>
              <tbody>
                {f.snapshot.rules.map((r, i) => (
                  <tr key={i} className="border-b border-line/60 last:border-0">
                    <td className="px-4 py-1.5 font-mono text-xs">{r.to}{r.v6 && <span className="ml-1 text-muted">v6</span>}</td>
                    <td className="px-3 py-1.5"><Badge tone={/ALLOW/.test(r.action) ? 'ok' : 'err'}>{r.action}</Badge></td>
                    <td className={cx('px-3 py-1.5 font-mono text-xs', /^Anywhere/.test(r.from) && 'text-warn')}>{r.from}</td>
                    <td className="px-4 py-1.5 text-xs text-fg-2">{r.comment ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : (
        <Card title="Regole del firewall non disponibili" icon={<ShieldAlert />}>
          <p className="text-[13px] text-fg-2">
            Leggere le regole di UFW richiede root. GIGI OS non ha questo privilegio. Puoi installare un timer di sola lettura che ogni 5 minuti salva l’output di <span className="font-mono">ufw status verbose</span>; GIGI OS lo legge e non ottiene alcun permesso in più.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-xs">sudo sh /opt/gigi-os/scripts/host/install-ufw-snapshot.sh</pre>
          <p className="mt-2 text-xs text-muted">Per rimuoverlo: aggiungi <span className="font-mono">--uninstall</span>. Modificare le regole da GIGI OS non è disponibile.</p>
        </Card>
      )}

      <Card
        title="Pacchetti bloccati"
        subtitle={b.data ? `${num(b.data.total)}${b.data.truncated ? '+' : ''} blocchi nelle ultime ${b.data.hours} ore (dal journal del kernel)` : 'Lettura del journal…'}
        actions={
          <Select className="h-7 w-auto text-xs" value={hours} onChange={(e) => setHours(Number(e.target.value))} aria-label="Periodo">
            <option value={1}>Ultima ora</option>
            <option value={24}>24 ore</option>
            <option value={168}>7 giorni</option>
          </Select>
        }
      >
        {b.isError ? (
          <ErrorBox error={b.error} compact />
        ) : !b.data ? (
          <Skeleton className="h-40 w-full" />
        ) : b.data.total === 0 ? (
          <p className="text-xs text-muted">Nessun pacchetto bloccato nel periodo (o log di UFW disattivato).</p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <h3 className="mb-1.5 text-xs font-medium text-muted">Sorgenti principali</h3>
              <ul className="space-y-1">
                {b.data.sources.slice(0, 10).map((s) => (
                  <li key={s.src} className="flex items-center gap-2 text-[13px]">
                    <span className="font-mono text-xs">{s.src}</span>
                    {!/^(192\.168|10\.|172\.(1[6-9]|2\d|3[01])|fe80|fd)/.test(s.src) && <Badge tone="warn">Internet</Badge>}
                    <span className="truncate text-xs text-muted">{s.ports.join(', ')}</span>
                    <span className="ml-auto shrink-0 text-xs tabular">{num(s.count)}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="mb-1.5 text-xs font-medium text-muted">Porte di destinazione</h3>
              <ul className="space-y-1">
                {b.data.ports.slice(0, 10).map((p) => (
                  <li key={p.port} className="flex items-center gap-2 text-[13px]">
                    <span className="font-mono text-xs">{p.port}</span>
                    <span className="text-xs text-muted">{p.sources} sorgent{p.sources === 1 ? 'e' : 'i'}</span>
                    <span className="ml-auto text-xs tabular">{num(p.count)}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="lg:col-span-2">
              <h3 className="mb-1.5 text-xs font-medium text-muted">Ultimi blocchi</h3>
              <div className="max-h-64 overflow-auto rounded-lg border border-line">
                <table className="w-full text-left font-mono text-[11px]">
                  <tbody>
                    {b.data.recent.slice(0, 50).map((r, i) => (
                      <tr key={i} className="border-b border-line/60 last:border-0">
                        <td className="px-2 py-1 text-muted">{new Date(r.t).toLocaleTimeString('it-IT')}</td>
                        <td className="px-2 py-1">{r.src}</td>
                        <td className="px-2 py-1 text-muted">→</td>
                        <td className="px-2 py-1">{r.dst}:{r.dport || '—'}</td>
                        <td className="px-2 py-1 text-muted">{r.proto} · {r.iface}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

// ───────────── Connessioni ─────────────

type Conns = { states: Record<string, number>; total: number; peers: { remote: string; count: number; external: boolean; inbound: { port: number; service: string | null }[]; outbound: number[] }[] };

function ConnectionsTab() {
  const q = useQuery({ queryKey: ['net-conns'], queryFn: () => api<Conns>('/network/connections'), refetchInterval: 10_000 });
  if (q.isError) return <ErrorBox error={q.error} />;
  if (!q.data) return <Skeleton className="h-64 w-full" />;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5">
        {Object.entries(q.data.states).sort((a, b) => b[1] - a[1]).map(([s, n]) => (
          <Badge key={s} tone={s === 'ESTABLISHED' ? 'ok' : s === 'LISTEN' ? 'info' : 'idle'}>{s} {n}</Badge>
        ))}
      </div>
      <Card title="Connessioni TCP stabilite per host remoto" subtitle="Esclusi loopback e reti interne di Docker. «In entrata» = verso un servizio di questo server." bodyClassName="!p-0">
        {q.data.peers.length === 0 ? (
          <Empty title="Nessuna connessione stabilita" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-[13px]">
              <thead className="border-y border-line text-xs text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Host remoto</th>
                  <th className="px-3 py-2 font-medium">In entrata</th>
                  <th className="px-3 py-2 font-medium">In uscita verso porta</th>
                  <th className="px-4 py-2 text-right font-medium">Connessioni</th>
                </tr>
              </thead>
              <tbody>
                {q.data.peers.map((p) => (
                  <tr key={p.remote} className="border-b border-line/60 last:border-0">
                    <td className="px-4 py-1.5"><span className="font-mono text-xs">{p.remote}</span> {p.external ? <Badge tone="warn">Internet</Badge> : <Badge>LAN</Badge>}</td>
                    <td className="px-3 py-1.5 text-xs">{p.inbound.map((i) => i.service ?? i.port).join(', ') || '—'}</td>
                    <td className="px-3 py-1.5 font-mono text-xs">{p.outbound.join(', ') || '—'}</td>
                    <td className="px-4 py-1.5 text-right tabular">{p.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// ───────────── Test ─────────────

type TestType = 'ping' | 'tracepath' | 'dns' | 'tcp' | 'http';
type TestResult = Record<string, unknown> & { type: TestType };
const PRESETS: { label: string; type: TestType; value: string; port?: string }[] = [
  { label: 'Gateway', type: 'ping', value: '' },
  { label: 'Internet (1.1.1.1)', type: 'ping', value: '1.1.1.1' },
  { label: 'Risoluzione DNS', type: 'dns', value: 'google.com' },
  { label: 'Percorso verso Internet', type: 'tracepath', value: '1.1.1.1' },
  { label: 'HTTPS esterno', type: 'http', value: 'https://www.cloudflare.com' },
];

function TestsTab() {
  const ov = useQuery({ queryKey: ['net-overview'], queryFn: () => api<Overview>('/network/overview') });
  const gw = ov.data?.routes.v4.find((r) => r.isDefault)?.gateway ?? '';
  const [type, setType] = useState<TestType>('ping');
  const [value, setValue] = useState('');
  const [port, setPort] = useState('443');
  const [record, setRecord] = useState('A');
  const [results, setResults] = useState<{ id: number; input: string; r: TestResult }[]>([]);
  const m = useMutation({
    mutationFn: (b: Record<string, unknown>) => api<TestResult>('/network/test', { method: 'POST', body: b }),
    onSuccess: (r, b) => setResults((l) => [{ id: Date.now(), input: String(b.host ?? b.url ?? b.name), r }, ...l].slice(0, 10)),
  });
  const body = (t: TestType, v: string): Record<string, unknown> =>
    t === 'http' ? { type: t, url: v } : t === 'dns' ? { type: t, name: v, record } : t === 'tcp' ? { type: t, host: v, port: Number(port) } : t === 'ping' ? { type: t, host: v, count: 4 } : { type: t, host: v };
  const runNow = (t = type, v = value) => v.trim() && m.mutate(body(t, v.trim()));
  return (
    <div className="space-y-4">
      <SpeedTestCard />
      <Card title="Diagnostica" icon={<Radar />}>
        <div className="mb-3 flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <Button key={p.label} size="sm" variant="ghost" disabled={m.isPending} onClick={() => { const v = p.value || gw; setType(p.type); setValue(v); runNow(p.type, v); }}>
              {p.label}
            </Button>
          ))}
        </div>
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); runNow(); }}>
          <div className="w-40">
            <Field label="Test">{(id) => (
              <Select id={id} value={type} onChange={(e) => setType(e.target.value as TestType)}>
                <option value="ping">Ping</option>
                <option value="tracepath">Percorso (tracepath)</option>
                <option value="dns">Risoluzione DNS</option>
                <option value="tcp">Porta TCP</option>
                <option value="http">HTTP/HTTPS</option>
              </Select>
            )}</Field>
          </div>
          <div className="min-w-52 flex-1">
            <Field label={type === 'http' ? 'URL' : type === 'dns' ? 'Nome o IP' : 'Host o IP'}>{(id) => (
              <Input id={id} value={value} onChange={(e) => setValue(e.target.value)} placeholder={type === 'http' ? 'https://…' : type === 'dns' ? 'example.com' : '192.168.222.254'} autoComplete="off" spellCheck={false} />
            )}</Field>
          </div>
          {type === 'tcp' && (
            <div className="w-24"><Field label="Porta">{(id) => <Input id={id} inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} />}</Field></div>
          )}
          {type === 'dns' && (
            <div className="w-28"><Field label="Record">{(id) => (
              <Select id={id} value={record} onChange={(e) => setRecord(e.target.value)}>
                {['A', 'AAAA', 'MX', 'TXT', 'NS', 'CNAME', 'PTR'].map((r) => <option key={r}>{r}</option>)}
              </Select>
            )}</Field></div>
          )}
          <Button type="submit" variant="primary" loading={m.isPending} disabled={!value.trim()}><Play /> Esegui</Button>
        </form>
        {m.isError && <div className="mt-3"><ErrorBox error={m.error} compact /></div>}
      </Card>
      {results.map((x) => <TestResultCard key={x.id} input={x.input} r={x.r} />)}
    </div>
  );
}

function TestResultCard({ input, r }: { input: string; r: TestResult }) {
  const ok = r.type === 'dns' ? (r.results as { ok: boolean }[]).some((x) => x.ok) : !!r.ok;
  const title = { ping: 'Ping', tracepath: 'Percorso', dns: 'DNS', tcp: 'Porta TCP', http: 'HTTP' }[r.type];
  return (
    <Card title={`${title} · ${input}${r.type === 'tcp' ? `:${r.port}` : ''}`} actions={<Badge tone={ok ? 'ok' : 'err'}>{ok ? 'riuscito' : 'fallito'}</Badge>}>
      {r.type === 'ping' && (
        <dl>
          <Kv k="Risposte">{`${r.received}/${r.sent}`}</Kv>
          <Kv k="Latenza">{r.avg != null ? `media ${r.avg} ms · min ${r.min} · max ${r.max} · jitter ${r.jitter ?? '—'} ms` : '—'}</Kv>
          {!ok && <pre className="mt-2 overflow-x-auto rounded-lg bg-surface-2 p-2 font-mono text-[11px] whitespace-pre-wrap">{String(r.output)}</pre>}
        </dl>
      )}
      {r.type === 'tracepath' && (
        <>
          <ol className="space-y-0.5 font-mono text-xs">
            {(r.hops as { hop: number; host: string; time: string | null }[]).map((h, i) => (
              <li key={i} className="flex gap-3"><span className="w-6 text-right text-muted">{h.hop}</span><span className="flex-1">{h.host}</span><span className="text-muted">{h.time ?? ''}</span></li>
            ))}
          </ol>
          {r.pmtu != null && <p className="mt-2 text-xs text-muted">MTU del percorso: {String(r.pmtu)}</p>}
        </>
      )}
      {r.type === 'dns' && (
        <table className="w-full text-left text-[13px]">
          <tbody>
            {(r.results as { server: string; ok: boolean; ms: number; records?: string[]; error?: string }[]).map((x) => (
              <tr key={x.server} className="border-b border-line/60 last:border-0 align-top">
                <td className="py-1.5 pr-3 font-mono text-xs">{x.server === 'sistema' ? 'sistema (systemd-resolved)' : x.server}</td>
                <td className="py-1.5 pr-3 text-right text-xs tabular">{x.ms} ms</td>
                <td className={cx('py-1.5 font-mono text-xs break-all', !x.ok && 'text-err')}>{x.ok ? x.records?.join(', ') || '(vuoto)' : x.error}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {r.type === 'tcp' && <p className="text-[13px]">{ok ? `Porta aperta (${r.address}) in ${r.ms} ms` : String(r.error)}</p>}
      {r.type === 'http' && (
        <dl>
          {r.error ? <Kv k="Errore">{String(r.error)}</Kv> : (
            <>
              <Kv k="Stato">{`HTTP ${r.status} in ${r.ms} ms`}</Kv>
              {r.location ? <Kv k="Redirect" mono>{String(r.location)}</Kv> : null}
              {r.server ? <Kv k="Server">{String(r.server)}</Kv> : null}
              <Kv k="HSTS">{r.hsts ? 'sì' : 'no'}</Kv>
              {r.cert ? (() => {
                const c = r.cert as { subject: string; issuer: string; daysLeft: number | null; trusted: boolean; error: string | null; protocol: string };
                return (
                  <>
                    <Kv k="Certificato">{`${c.subject} · ${c.issuer}`}</Kv>
                    <Kv k="Scadenza">
                      <span className={c.daysLeft != null && c.daysLeft < 15 ? 'text-err' : undefined}>{c.daysLeft != null ? `tra ${c.daysLeft} giorni` : '—'}</span>
                    </Kv>
                    <Kv k="Attendibile">{c.trusted ? `sì · ${c.protocol}` : `no (${c.error ?? 'sconosciuto'})`}</Kv>
                  </>
                );
              })() : null}
            </>
          )}
        </dl>
      )}
    </Card>
  );
}

type Speed = { status: 'running' | 'ok' | 'error'; phase: string; latency: number | null; jitter: number | null; download: number | null; upload: number | null; live: number | null; error: string | null; endedAt: number | null };
type SpeedState = { current: Speed | null; history: { t: number; latency: number; jitter: number; download: number; upload: number }[] };

function SpeedTestCard() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['net-speed'],
    queryFn: () => api<SpeedState>('/network/speedtest'),
    refetchInterval: (query) => (query.state.data?.current?.status === 'running' ? 700 : false),
  });
  const start = useMutation({ mutationFn: () => api('/network/speedtest', { method: 'POST' }), onSuccess: () => void qc.invalidateQueries({ queryKey: ['net-speed'] }) });
  const c = q.data?.current;
  const running = c?.status === 'running';
  const big = (label: string, v: number | null, unit: string, active: boolean) => (
    <div className={cx('rounded-xl border px-4 py-3', active ? 'border-accent bg-accent-soft' : 'border-line bg-surface-2')}>
      <div className="text-[11px] text-muted">{label}</div>
      <div className="text-2xl font-semibold tabular">{v ?? '—'}<span className="ml-1 text-xs font-normal text-muted">{unit}</span></div>
    </div>
  );
  return (
    <Card
      title="Test di velocità"
      icon={<Gauge />}
      subtitle="Verso speed.cloudflare.com: circa 25 MB in download e 10 MB in upload. Misura la linea reale del mini PC."
      actions={<Button size="sm" variant="primary" loading={running || start.isPending} onClick={() => start.mutate()}><Play /> {running ? 'In corso' : 'Avvia'}</Button>}
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {big('Latenza', c?.latency ?? null, 'ms', running && c?.phase === 'latency')}
        {big('Jitter', c?.jitter ?? null, 'ms', false)}
        {big('Download', c?.phase === 'download' ? c.live : c?.download ?? null, 'Mbit/s', running && c?.phase === 'download')}
        {big('Upload', c?.upload ?? null, 'Mbit/s', running && c?.phase === 'upload')}
      </div>
      {c?.status === 'error' && <div className="mt-3"><ErrorBox error={{ message: c.error }} compact /></div>}
      {start.isError && <div className="mt-3"><ErrorBox error={start.error} compact /></div>}
      {q.data && q.data.history.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-fg-2">Storico ({q.data.history.length})</summary>
          <table className="mt-2 w-full text-left text-xs">
            <tbody>
              {q.data.history.map((h) => (
                <tr key={h.t} className="border-b border-line/60 last:border-0">
                  <td className="py-1 whitespace-nowrap text-muted">{dateTime(h.t)}</td>
                  <td className="py-1 text-right tabular">↓ {h.download} Mbit/s</td>
                  <td className="py-1 text-right tabular">↑ {h.upload} Mbit/s</td>
                  <td className="py-1 text-right tabular">{h.latency} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </Card>
  );
}

// ───────────── Dispositivi ─────────────

type Device = { mac: string; ip: string; name: string | null; firstSeen: number; lastSeen: number; online: boolean; gateway: boolean; randomMac: boolean };

function DevicesTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['net-devices'], queryFn: () => api<{ scanning: boolean; gateway: string | null; devices: Device[] }>('/network/devices'), refetchInterval: 30_000 });
  const mon = useMonitor();
  const [edit, setEdit] = useState<{ mac: string; name: string } | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['net-devices'] });
  const scan = useMutation({
    mutationFn: () => api<{ found: number; new: number }>('/network/devices/scan', { method: 'POST' }),
    onSuccess: (r) => {
      toast('ok', `Scansione completata: ${r.found} dispositivi, ${r.new} nuovi`);
      refresh();
    },
  });
  const wake = useMutation({ mutationFn: (mac: string) => api('/network/wol', { method: 'POST', body: { mac } }), onSuccess: () => toast('ok', 'Pacchetto Wake-on-LAN inviato') });
  const rename = useMutation({
    mutationFn: (e: { mac: string; name: string }) => api(`/network/devices/${e.mac}`, { method: 'PATCH', body: { name: e.name || null } }),
    onSuccess: () => {
      setEdit(null);
      refresh();
    },
  });
  const forget = useMutation({ mutationFn: (mac: string) => api(`/network/devices/${mac}`, { method: 'DELETE' }), onSuccess: refresh });
  const [wolMac, setWolMac] = useState('');
  return (
    <div className="space-y-4">
      <Card
        title="Dispositivi in rete locale"
        subtitle="Tabella ARP del mini PC. La scansione invia un ping a ogni indirizzo della LAN (circa 10 s)."
        actions={<Button size="sm" variant="primary" loading={scan.isPending || q.data?.scanning} onClick={() => scan.mutate()}><Radar /> Scansiona</Button>}
        bodyClassName="!p-0"
      >
        {scan.isError && <div className="px-4 pb-3"><ErrorBox error={scan.error} compact /></div>}
        {!q.data ? (
          <div className="p-4"><Skeleton className="h-40 w-full" /></div>
        ) : q.data.devices.length === 0 ? (
          <Empty icon={<Radar />} title="Nessun dispositivo ancora">Avvia una scansione per popolare l’elenco.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-left text-[13px]">
              <thead className="border-y border-line text-xs text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Indirizzo</th>
                  <th className="px-3 py-2 font-medium">Nome</th>
                  <th className="px-3 py-2 font-medium">MAC</th>
                  <th className="px-3 py-2 font-medium">Visto</th>
                  <th className="px-4 py-2 text-right font-medium"><span className="sr-only">Azioni</span></th>
                </tr>
              </thead>
              <tbody>
                {q.data.devices.map((d) => (
                  <tr key={d.mac} className="border-b border-line/60 last:border-0">
                    <td className="px-4 py-1.5"><span className="inline-flex items-center gap-2"><Dot tone={d.online ? 'ok' : 'idle'} /><span className="font-mono text-xs">{d.ip}</span>{d.gateway && <Badge tone="info">gateway</Badge>}</span></td>
                    <td className="px-3 py-1.5">
                      {edit?.mac === d.mac ? (
                        <form className="flex gap-1" onSubmit={(e) => { e.preventDefault(); rename.mutate(edit); }}>
                          <Input className="h-7 w-40 text-xs" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} autoFocus aria-label="Nome dispositivo" />
                          <Button size="icon" variant="ghost" type="button" aria-label="Annulla" onClick={() => setEdit(null)}><X /></Button>
                        </form>
                      ) : (
                        <span>{d.name ?? <span className="text-muted">—</span>}</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-xs">{d.mac}{d.randomMac && <span className="ml-1.5 font-sans text-[11px] text-muted">(casuale)</span>}</td>
                    <td className="px-3 py-1.5 text-xs whitespace-nowrap text-muted">{d.firstSeen ? `dal ${new Date(d.firstSeen).toLocaleDateString('it-IT')} · ${ago(d.lastSeen)}` : 'non ancora registrato'}</td>
                    <td className="px-4 py-1.5 text-right whitespace-nowrap">
                      <Button size="icon" variant="ghost" aria-label={`Rinomina ${d.ip}`} onClick={() => setEdit({ mac: d.mac, name: d.name ?? '' })}><Pencil /></Button>
                      <Button size="icon" variant="ghost" aria-label={`Accendi ${d.name ?? d.ip} (Wake-on-LAN)`} title="Wake-on-LAN" onClick={() => wake.mutate(d.mac)}><Power /></Button>
                      {d.firstSeen > 0 && <Button size="icon" variant="ghost" aria-label={`Dimentica ${d.ip}`} onClick={() => forget.mutate(d.mac)}><Trash2 /></Button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Avvisi" icon={<Moon />}>
          <label className="flex items-start gap-2 text-[13px]">
            <input type="checkbox" className="mt-0.5 size-4 [--check:var(--accent)]" checked={!!mon.data?.devices} disabled={!mon.data || mon.save.isPending} onChange={(e) => mon.save.mutate({ ...mon.data!, devices: e.target.checked })} />
            <span>Nuovi dispositivi in rete<span className="block text-xs text-muted">Ogni 15 minuti legge la tabella ARP (nessuna scansione attiva) e crea un evento «rete» per ogni MAC mai visto: collegalo a una regola in Automazioni per riceverlo su Telegram o Home Assistant.</span></span>
          </label>
        </Card>
        <Card title="Wake-on-LAN manuale" icon={<Power />}>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); wake.mutate(wolMac.trim()); }}>
            <Input value={wolMac} onChange={(e) => setWolMac(e.target.value)} placeholder="aa:bb:cc:dd:ee:ff" aria-label="Indirizzo MAC" className="flex-1 font-mono text-xs" />
            <Button type="submit" disabled={!/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(wolMac.trim())} loading={wake.isPending}>Invia</Button>
          </form>
          {wake.isError && <div className="mt-2"><ErrorBox error={wake.error} compact /></div>}
          <p className="mt-2 text-xs text-muted">Il dispositivo deve avere Wake-on-LAN abilitato nel BIOS o nella scheda di rete.</p>
        </Card>
      </div>
    </div>
  );
}
