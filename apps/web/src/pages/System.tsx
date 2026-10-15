import { useQuery } from '@tanstack/react-query';
import { Cog, Cpu, HardDrive, Lock, Network, Search, Thermometer } from 'lucide-react';
import { useMemo, useState } from 'react';
import { AreaChart } from '../components/Chart';
import { Badge, Card, cx, Dialog, Empty, ErrorBox, Input, Kv, Meter, PageHeader, Select, Skeleton, type Tone } from '../components/ui';
import { api } from '../lib/api';
import { ago, bytes, dateTime, duration, pct, rate } from '../lib/format';
import { useHistory, useSystem } from '../lib/queries';

export function SystemPage() {
  const s = useSystem();
  const [minutes, setMinutes] = useState(60);
  const h = useHistory(minutes);
  const d = s.data;

  return (
    <div>
      <PageHeader
        title="Sistema"
        description={d ? `${d.hostname} · ${d.os} · kernel ${d.kernel} · acceso da ${duration(d.uptime)}` : 'Hardware, risorse e rete del mini PC'}
        actions={
          <Select className="w-auto" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} aria-label="Intervallo grafici">
            <option value={15}>Ultimi 15 minuti</option>
            <option value={60}>Ultima ora</option>
          </Select>
        }
      />
      {s.isError && <ErrorBox error={s.error} />}
      {!d && !s.isError && <Skeleton className="h-64 w-full" />}
      {d && (
        <div className="grid gap-4 xl:grid-cols-3">
          <Card title="CPU" icon={<Cpu />} subtitle={d.cpuModel} className="xl:col-span-2">
            <div className="mb-3 flex flex-wrap items-baseline gap-x-6 gap-y-1">
              <div>
                <span className="text-2xl font-semibold tabular">{pct(d.cpu.usage, 1)}</span> <span className="text-xs text-muted">utilizzo</span>
              </div>
              <div className="text-sm text-fg-2 tabular">load {d.load.map((l) => l.toFixed(2)).join(' / ')}</div>
              {d.cpuTemp !== null && <div className="text-sm text-fg-2 tabular">{Math.round(d.cpuTemp)} °C</div>}
            </div>
            {h.data ? (
              <AreaChart
                ariaLabel="Utilizzo CPU"
                times={h.data.map((x) => x.t)}
                max={100}
                yFormat={(v) => `${Math.round(v)}%`}
                series={[{ key: 'cpu', label: 'CPU', color: 'var(--chart-1)', values: h.data.map((x) => x.cpu) }]}
                height={160}
              />
            ) : (
              <Skeleton className="h-40" />
            )}
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {d.cpu.perCore.map((c, i) => (
                <div key={i}>
                  <div className="mb-1 flex justify-between text-xs">
                    <span className="text-muted">Core {i}</span>
                    <span className="tabular">{pct(c)}</span>
                  </div>
                  <Meter value={c} label={`Core ${i}`} />
                </div>
              ))}
            </div>
          </Card>

          <Card title="Temperature" icon={<Thermometer />}>
            {d.temps.length === 0 ? (
              <p className="text-xs text-muted">Nessun sensore esposto da /sys/class/hwmon.</p>
            ) : (
              <ul className="space-y-2.5">
                {d.temps.map((t) => {
                  const lim = t.crit ?? t.high ?? 100;
                  return (
                    <li key={`${t.sensor}-${t.label}`}>
                      <div className="mb-1 flex justify-between text-xs">
                        <span className="text-fg-2">
                          {t.label} <span className="text-muted">· {t.sensor}</span>
                        </span>
                        <span className={cx('tabular', t.celsius >= lim * 0.85 ? 'text-err' : t.celsius >= lim * 0.7 ? 'text-warn' : '')}>{t.celsius.toFixed(0)} °C</span>
                      </div>
                      <Meter value={(t.celsius / lim) * 100} label={t.label} />
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card title="Memoria" className="xl:col-span-2">
            <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ['Usata', bytes(d.memory.used)],
                ['Disponibile', bytes(d.memory.available)],
                ['Cache e buffer', bytes(d.memory.cached)],
                ['Swap', `${bytes(d.memory.swapUsed)} / ${bytes(d.memory.swapTotal)}`],
              ].map(([k, v]) => (
                <div key={k} className="rounded-lg bg-surface-2 px-3 py-2">
                  <div className="text-[11px] text-muted">{k}</div>
                  <div className="text-sm font-medium tabular">{v}</div>
                </div>
              ))}
            </div>
            {h.data && (
              <AreaChart
                ariaLabel="Utilizzo memoria"
                times={h.data.map((x) => x.t)}
                max={100}
                yFormat={(v) => `${Math.round(v)}%`}
                series={[{ key: 'mem', label: 'RAM', color: 'var(--chart-2)', values: h.data.map((x) => x.mem) }]}
                height={130}
              />
            )}
          </Card>

          <Card title="Dischi" icon={<HardDrive />}>
            <div className="space-y-4">
              {d.disks.map((dk) => {
                const p = dk.total ? (dk.used / dk.total) * 100 : 0;
                return (
                  <div key={dk.label}>
                    <div className="mb-1.5 flex justify-between text-xs">
                      <span className="font-medium text-fg-2">{dk.label}</span>
                      <span className="text-muted tabular">{pct(p)}</span>
                    </div>
                    <Meter value={p} label={dk.label} />
                    <div className="mt-1 text-[11px] text-muted tabular">
                      {bytes(dk.used)} usati · {bytes(dk.free)} liberi · {bytes(dk.total)} totali
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>

          <Card title="Rete" icon={<Network />} className="xl:col-span-2">
            {h.data && (
              <AreaChart
                ariaLabel="Traffico di rete"
                times={h.data.map((x) => x.t)}
                yFormat={(v) => bytes(v, 0)}
                series={[
                  { key: 'rx', label: 'Download', color: 'var(--chart-3)', values: h.data.map((x) => x.rx), format: (v) => rate(v) },
                  { key: 'tx', label: 'Upload', color: 'var(--chart-1)', values: h.data.map((x) => x.tx), format: (v) => rate(v) },
                ]}
                height={140}
              />
            )}
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[480px] text-left text-[13px]">
                <thead className="text-xs text-muted">
                  <tr>
                    <th className="py-1.5 font-medium">Interfaccia</th>
                    <th className="py-1.5 font-medium">Stato</th>
                    <th className="py-1.5 text-right font-medium">↓ ora</th>
                    <th className="py-1.5 text-right font-medium">↑ ora</th>
                    <th className="py-1.5 text-right font-medium">↓ totale</th>
                    <th className="py-1.5 text-right font-medium">↑ totale</th>
                  </tr>
                </thead>
                <tbody>
                  {d.network.interfaces.map((i) => (
                    <tr key={i.name} className="border-t border-line/60">
                      <td className="py-1.5 font-mono text-xs">{i.name}</td>
                      <td className="py-1.5">
                        <Badge tone={i.state === 'up' ? 'ok' : 'idle'}>{i.state}</Badge>
                      </td>
                      <td className="py-1.5 text-right tabular">{rate(i.rxRate)}</td>
                      <td className="py-1.5 text-right tabular">{rate(i.txRate)}</td>
                      <td className="py-1.5 text-right text-muted tabular">{bytes(i.rxBytes)}</td>
                      <td className="py-1.5 text-right text-muted tabular">{bytes(i.txBytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="Host">
            <dl>
              <Kv k="Hostname">{d.hostname}</Kv>
              <Kv k="Sistema">{d.os}</Kv>
              <Kv k="Kernel" mono>{d.kernel}</Kv>
              <Kv k="Architettura">{d.arch}</Kv>
              <Kv k="GPU">{d.gpu ?? 'non rilevata'}</Kv>
              <Kv k="Uptime">{duration(d.uptime)}</Kv>
            </dl>

          </Card>
          <ServicesCard />
        </div>
      )}
    </div>
  );
}

type Svc = { name: string; description: string; load: string; active: string; sub: string };
type SvcDetail = Svc & {
  unitFileState: string;
  fragment: string;
  since: number | null;
  inactiveSince: number | null;
  mainPid: number | null;
  memory: number | null;
  cpuNs: number | null;
  tasks: number | null;
  restarts: number | null;
  result: string | null;
  execMainStatus: number | null;
  user: string;
};

const svcTone = (s: Svc): Tone => (s.active === 'failed' ? 'err' : s.active === 'active' ? (s.sub === 'running' ? 'ok' : 'info') : s.active === 'activating' ? 'warn' : 'idle');

function ServicesCard() {
  const q = useQuery({ queryKey: ['systemd'], queryFn: () => api<Svc[]>('/systemd/services'), refetchInterval: 30_000 });
  const [filter, setFilter] = useState('running');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const rows = useMemo(() => {
    let r = q.data ?? [];
    if (filter === 'running') r = r.filter((x) => x.sub === 'running');
    else if (filter === 'failed') r = r.filter((x) => x.active === 'failed');
    else if (filter === 'loaded') r = r.filter((x) => x.load === 'loaded');
    const t = search.trim().toLowerCase();
    if (t) r = r.filter((x) => x.name.toLowerCase().includes(t) || x.description.toLowerCase().includes(t));
    return r;
  }, [q.data, filter, search]);
  const failed = (q.data ?? []).filter((x) => x.active === 'failed');
  return (
    <Card
      title="Servizi systemd"
      icon={<Cog />}
      className="xl:col-span-3"
      subtitle={q.data ? `${q.data.filter((x) => x.sub === 'running').length} in esecuzione su ${q.data.length}${failed.length ? ` · ${failed.length} in errore` : ''}` : undefined}
      bodyClassName="!px-0"
      actions={
        <div className="flex gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted" />
            <Input className="h-8 w-44 pl-7 text-xs" placeholder="Cerca servizio…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Cerca servizio" />
          </div>
          <Select className="h-8 w-auto text-xs" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filtro servizi">
            <option value="running">In esecuzione</option>
            <option value="failed">In errore</option>
            <option value="loaded">Caricati</option>
            <option value="all">Tutti</option>
          </Select>
        </div>
      }
    >
      {q.isError && <div className="px-4"><ErrorBox error={q.error} compact /></div>}
      {!q.data && !q.isError && <div className="px-4"><Skeleton className="h-40" /></div>}
      {q.data && rows.length === 0 && <Empty title={filter === 'failed' ? 'Nessun servizio in errore' : 'Nessun servizio'} />}
      {q.data && rows.length > 0 && (
        <div className="max-h-[420px] overflow-auto">
          <table className="w-full min-w-[560px] text-left text-[13px]">
            <thead className="sticky top-0 border-b border-line bg-surface text-xs text-muted">
              <tr><th className="px-4 py-2 font-medium">Servizio</th><th className="px-3 py-2 font-medium">Descrizione</th><th className="px-4 py-2 font-medium">Stato</th></tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.name} className="cursor-pointer border-b border-line/60 last:border-0 hover:bg-surface-2" onClick={() => setOpen(s.name)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setOpen(s.name)}>
                  <td className="px-4 py-1.5 font-mono text-xs">{s.name.replace(/\.service$/, '')}</td>
                  <td className="max-w-[380px] truncate px-3 py-1.5 text-xs text-fg-2">{s.description}</td>
                  <td className="px-4 py-1.5"><Badge tone={svcTone(s)}>{s.active === s.sub ? s.active : `${s.active} · ${s.sub}`}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 flex items-start gap-1.5 px-4 text-[11px] text-muted">
        <Lock className="mt-px size-3 shrink-0" /> Sola lettura: l’agent non ha privilegi sui servizi dell’host. Avvio e riavvio richiedono una regola polkit dedicata (da autorizzare).
      </p>
      {open && <ServiceDialog name={open} onClose={() => setOpen(null)} />}
    </Card>
  );
}

function ServiceDialog({ name, onClose }: { name: string; onClose: () => void }) {
  const d = useQuery({ queryKey: ['systemd', name], queryFn: () => api<SvcDetail>(`/systemd/services/${encodeURIComponent(name)}`) });
  const s = d.data;
  return (
    <Dialog open onClose={onClose} title={name} description={s?.description}>
      {d.isError && <ErrorBox error={d.error} compact />}
      {!s && !d.isError && <Skeleton className="h-40" />}
      {s && (
        <dl>
          <Kv k="Stato"><Badge tone={svcTone(s)}>{s.active} · {s.sub}</Badge></Kv>
          {s.active === 'active' && s.since && <Kv k="Attivo da">{dateTime(s.since)} ({ago(s.since)})</Kv>}
          {s.active !== 'active' && s.inactiveSince && <Kv k="Fermo da">{dateTime(s.inactiveSince)}</Kv>}
          {s.result && s.result !== 'success' && <Kv k="Esito ultimo avvio"><span className="text-err">{s.result} (codice {s.execMainStatus})</span></Kv>}
          <Kv k="Avvio automatico">{s.unitFileState || '—'}</Kv>
          <Kv k="Utente">{s.user}</Kv>
          <Kv k="PID">{s.mainPid || '—'}</Kv>
          <Kv k="Memoria">{s.memory !== null ? bytes(s.memory) : '—'}</Kv>
          <Kv k="CPU totale">{s.cpuNs !== null ? `${(s.cpuNs / 1e9).toFixed(1)} s` : '—'}</Kv>
          <Kv k="Task">{s.tasks ?? '—'}</Kv>
          <Kv k="Riavvii automatici">{s.restarts ?? '—'}</Kv>
          <Kv k="File unità" mono>{s.fragment || '—'}</Kv>
        </dl>
      )}
      {s?.active === 'failed' && <p className="mt-3 text-xs text-muted">Per il dettaglio dell’errore: <span className="font-mono">journalctl -u {name} -n 30</span></p>}
    </Dialog>
  );
}
