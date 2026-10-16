import { useQuery } from '@tanstack/react-query';
import { Boxes, Cog, Cpu, HardDrive, Lock, Network, Search, Thermometer } from 'lucide-react';
import { useMemo, useState } from 'react';
import { AreaChart, Sparkline, type Series } from '../components/Chart';
import { Badge, Card, cx, Dialog, Empty, ErrorBox, Input, Kv, Meter, PageHeader, Select, Skeleton, Tabs, type Tone } from '../components/ui';
import { api, type DiskForecast, type MetricsRange } from '../lib/api';
import { ago, bytes, dateTime, duration, pct, rate } from '../lib/format';
import { useContainerMetrics, useDiskMetrics, useHistory, useHostMetrics, useSystem } from '../lib/queries';
import { useAuth } from '../lib/auth';

type View = '15m' | '1h' | MetricsRange;
type Col = (number | null)[];
type ChartData = { times: number[]; cpu: Col; cpuMax: Col | null; mem: Col; rx: Col; tx: Col; temp: Col };

// 15 minuti e 1 ora: dati dal vivo dell'agent (5 s). Oltre: storico salvato da GIGI OS (D-027).
function useChartData(view: View): { data: ChartData | undefined; since: number | null; from: number } {
  const live = view === '15m' || view === '1h';
  const h = useHistory(view === '15m' ? 15 : 60);
  const m = useHostMetrics(live ? '24h' : (view as MetricsRange), !live);
  if (live) {
    const x = h.data;
    return {
      data: x && { times: x.map((p) => p.t), cpu: x.map((p) => p.cpu), cpuMax: null, mem: x.map((p) => p.mem), rx: x.map((p) => p.rx), tx: x.map((p) => p.tx), temp: x.map((p) => p.temp) },
      since: null,
      from: 0,
    };
  }
  const y = m.data;
  return { data: y && { times: y.times, cpu: y.cpu, cpuMax: y.cpuMax, mem: y.mem, rx: y.rx, tx: y.tx, temp: y.temp }, since: y?.since ?? null, from: y?.times[0] ?? 0 };
}

const hasData = (c: Col) => c.some((v) => v !== null);

function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-2">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span className="size-2 rounded-full" style={{ background: i.color }} aria-hidden />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

export function SystemPage() {
  const s = useSystem();
  const [view, setView] = useState<View>('1h');
  const { data: h, since, from } = useChartData(view);
  const d = s.data;
  const long = view !== '15m' && view !== '1h';

  return (
    <div>
      <PageHeader
        title="Sistema"
        description={d ? `${d.hostname} · ${d.os} · kernel ${d.kernel} · acceso da ${duration(d.uptime)}` : 'Hardware, risorse e rete del mini PC'}
        actions={
          <Select className="w-auto" value={view} onChange={(e) => setView(e.target.value as View)} aria-label="Intervallo grafici">
            <option value="15m">Ultimi 15 minuti</option>
            <option value="1h">Ultima ora (dal vivo)</option>
            <option value="24h">Ultime 24 ore</option>
            <option value="7d">Ultimi 7 giorni</option>
            <option value="30d">Ultimi 30 giorni</option>
          </Select>
        }
      />
      {s.isError && <ErrorBox error={s.error} />}
      {long && h && (
        <p className="mb-3 text-xs text-muted">
          {since === null
            ? 'Storico in costruzione: GIGI OS salva un punto al minuto, i primi dati compaiono entro qualche minuto.'
            : since > from
              ? `Storico disponibile dal ${dateTime(since)}: prima di allora non ci sono dati. I tratti vuoti sono periodi in cui GIGI OS era fermo.`
              : 'I tratti vuoti sono periodi in cui GIGI OS era fermo.'}
        </p>
      )}
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
            {h ? (
              <>
                <AreaChart
                  ariaLabel="Utilizzo CPU"
                  times={h.times}
                  max={100}
                  yFormat={(v) => `${Math.round(v)}%`}
                  series={[
                    { key: 'cpu', label: h.cpuMax ? 'Media' : 'CPU', color: 'var(--chart-1)', values: h.cpu },
                    ...(h.cpuMax ? [{ key: 'max', label: 'Picco', color: 'var(--chart-4)', values: h.cpuMax }] : []),
                  ]}
                  height={160}
                />
                {h.cpuMax && (
                  <Legend
                    items={[
                      { label: 'Media', color: 'var(--chart-1)' },
                      { label: 'Picco (massimo del minuto)', color: 'var(--chart-4)' },
                    ]}
                  />
                )}
              </>
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
            {h && hasData(h.temp) && (
              <div className="mt-4">
                <div className="mb-1 text-xs text-muted">Andamento CPU (°C)</div>
                <AreaChart
                  ariaLabel="Temperatura CPU"
                  times={h.times}
                  yFormat={(v) => `${Math.round(v)}°`}
                  series={[{ key: 'temp', label: 'Temperatura', color: 'var(--chart-4)', values: h.temp, format: (v) => `${v.toFixed(1)} °C` }]}
                  height={100}
                />
              </div>
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
            {h && (
              <AreaChart
                ariaLabel="Utilizzo memoria"
                times={h.times}
                max={100}
                yFormat={(v) => `${Math.round(v)}%`}
                series={[{ key: 'mem', label: 'RAM', color: 'var(--chart-2)', values: h.mem }]}
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
                    <DiskTrend label={dk.label} />
                  </div>
                );
              })}
            </div>
          </Card>

          <Card title="Rete" icon={<Network />} className="xl:col-span-2">
            {h && (
              <>
                <AreaChart
                  ariaLabel="Traffico di rete"
                  times={h.times}
                  yFormat={(v) => bytes(v, 0)}
                  series={[
                    { key: 'rx', label: 'Download', color: 'var(--chart-3)', values: h.rx, format: (v) => rate(v) },
                    { key: 'tx', label: 'Upload', color: 'var(--chart-1)', values: h.tx, format: (v) => rate(v) },
                  ]}
                  height={140}
                />
                <Legend
                  items={[
                    { label: long ? 'Download (media)' : 'Download', color: 'var(--chart-3)' },
                    { label: long ? 'Upload (media)' : 'Upload', color: 'var(--chart-1)' },
                  ]}
                />
              </>
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
          <ContainersHistoryCard range={long ? (view as MetricsRange) : '1h'} />
          <ServicesCard />
        </div>
      )}
    </div>
  );
}

const days = (n: number) => (n > 365 ? 'oltre un anno' : n <= 1 ? 'meno di un giorno' : `${n} giorni`);

export function forecastText(f: DiskForecast): { text: string; tone: Tone } {
  switch (f.status) {
    case 'insufficient':
      return { text: `Previsione dopo 3 giorni di storico (finora ${f.dataDays.toLocaleString('it-IT')} g)`, tone: 'idle' };
    case 'stable':
      return { text: 'Occupazione stabile negli ultimi 14 giorni', tone: 'ok' };
    case 'shrinking':
      return { text: `In calo: ${bytes(-f.perDay)} liberati al giorno`, tone: 'ok' };
    case 'growing': {
      const range = f.daysMax === null ? `almeno ${days(f.daysMin)}` : f.daysMin === f.daysMax ? days(f.days) : `${f.daysMin}–${f.daysMax > 365 ? '365+' : f.daysMax} giorni`;
      return {
        text: f.days > 365 ? `Cresce di ${bytes(f.perDay)} al giorno: pieno tra oltre un anno` : `Pieno tra circa ${days(f.days)} (stima ${range}) · +${bytes(f.perDay)}/giorno`,
        tone: f.days < 14 ? 'err' : f.days < 60 ? 'warn' : 'idle',
      };
    }
  }
}

function DiskTrend({ label }: { label: string }) {
  const m = useDiskMetrics();
  const dk = m.data?.find((x) => x.label === label);
  if (!dk) return null;
  const f = forecastText(dk.forecast);
  return (
    <div className="mt-2">
      {dk.points.length > 1 && <Sparkline values={dk.points.map((p) => p.used)} color="var(--chart-3)" height={28} />}
      <div className={cx('mt-1 text-[11px]', f.tone === 'err' ? 'text-err' : f.tone === 'warn' ? 'text-warn' : 'text-muted')}>{f.text}</div>
    </div>
  );
}

const PALETTE = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];

function ContainersHistoryCard({ range }: { range: MetricsRange }) {
  const [metric, setMetric] = useState<'cpu' | 'mem'>('cpu');
  const q = useContainerMetrics(range, metric);
  const x = q.data;
  // Colore legato al nome (ordine alfabetico dei 5 mostrati), non alla posizione in classifica.
  const colors = useMemo(() => new Map([...(x?.series ?? [])].map((s) => s.name).sort().map((n, i) => [n, PALETTE[i]])), [x]);
  const series: Series[] = (x?.series ?? []).map((s) => ({
    key: s.name,
    label: s.name,
    color: colors.get(s.name)!,
    values: s.values,
    format: metric === 'cpu' ? (v: number) => `${v.toFixed(1)}%` : (v: number) => bytes(v),
  }));
  return (
    <Card
      title="Consumi per container"
      icon={<Boxes />}
      subtitle={`I 5 container con il consumo medio più alto · ${range === '1h' ? 'ultima ora' : range === '24h' ? 'ultime 24 ore' : range === '7d' ? 'ultimi 7 giorni' : 'ultimi 30 giorni'} · risoluzione ${x ? Math.round(x.bucketMs / 60_000) : 5} min`}
      className="xl:col-span-3"
    >
      <div className="mb-3">
        <Tabs
          value={metric}
          onChange={setMetric}
          items={[
            { id: 'cpu', label: 'CPU' },
            { id: 'mem', label: 'RAM' },
          ]}
        />
      </div>
      {q.isError && <ErrorBox error={q.error} compact />}
      {!x && !q.isError && <Skeleton className="h-40" />}
      {x && x.ranking.length === 0 && <Empty title="Storico in costruzione">GIGI OS registra i consumi dei container ogni minuto: i primi dati compaiono entro 5 minuti.</Empty>}
      {x && x.ranking.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-5">
          <div className="lg:col-span-3">
            <AreaChart
              ariaLabel={metric === 'cpu' ? 'CPU per container' : 'RAM per container'}
              times={x.times}
              yFormat={metric === 'cpu' ? (v) => `${Math.round(v)}%` : (v) => bytes(v, 0)}
              series={series}
              height={180}
            />
            <Legend items={series.map((s) => ({ label: s.label, color: s.color }))} />
            {metric === 'cpu' && <p className="mt-2 text-[11px] text-muted">100% = un core intero: con 4 core il massimo teorico è 400%.</p>}
          </div>
          <div className="overflow-x-auto lg:col-span-2">
            <table className="w-full min-w-[360px] text-left text-[13px]">
              <caption className="sr-only">Consumi medi per container nell'intervallo</caption>
              <thead className="text-xs text-muted">
                <tr>
                  <th className="py-1.5 font-medium">Container</th>
                  <th className="py-1.5 text-right font-medium">CPU media</th>
                  <th className="py-1.5 text-right font-medium">CPU picco</th>
                  <th className="py-1.5 text-right font-medium">RAM media</th>
                  <th className="py-1.5 text-right font-medium">RAM max</th>
                </tr>
              </thead>
              <tbody>
                {x.ranking.slice(0, 15).map((r) => (
                  <tr key={r.name} className="border-t border-line/60">
                    <td className="py-1.5">
                      <span className="flex items-center gap-1.5 font-mono text-xs">
                        <span className="size-2 shrink-0 rounded-full" style={{ background: colors.get(r.name) ?? 'transparent' }} aria-hidden />
                        {r.name}
                      </span>
                    </td>
                    <td className="py-1.5 text-right tabular">{r.cpuAvg.toFixed(1)}%</td>
                    <td className="py-1.5 text-right text-muted tabular">{r.cpuPeak.toFixed(1)}%</td>
                    <td className="py-1.5 text-right tabular">{bytes(r.memAvg)}</td>
                    <td className="py-1.5 text-right text-muted tabular">{bytes(r.memMax)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {x.ranking.length > 15 && <p className="mt-1 text-[11px] text-muted">Altri {x.ranking.length - 15} container con consumi minori.</p>}
          </div>
        </div>
      )}
    </Card>
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
  lastEvent: { state: 'failed' | 'ok'; ts: number; message: string } | null;
};
type JLine = { ts: number; priority: string; ident: string | null; message: string };

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
                  <td className="px-4 py-1.5 font-mono text-xs whitespace-nowrap">{s.name.replace(/\.service$/, '')}</td>
                  <td className="max-w-[380px] truncate px-3 py-1.5 text-xs text-fg-2">{s.description}</td>
                  <td className="px-4 py-1.5"><Badge tone={svcTone(s)}>{s.active === s.sub ? s.active : `${s.active} · ${s.sub}`}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 flex items-start gap-1.5 px-4 text-[11px] text-muted">
        <Lock className="mt-px size-3 shrink-0" /> Sola lettura: stato dai cgroup e dal journal dell’host. Avvio e riavvio non sono abilitati per scelta (servirebbero privilegi sull’host).
      </p>
      {open && <ServiceDialog name={open} onClose={() => setOpen(null)} />}
    </Card>
  );
}

function ServiceDialog({ name, onClose }: { name: string; onClose: () => void }) {
  const { isAdmin } = useAuth();
  const d = useQuery({ queryKey: ['systemd', name], queryFn: () => api<SvcDetail>(`/systemd/services/${encodeURIComponent(name)}`) });
  const j = useQuery({ queryKey: ['systemd-journal', name], queryFn: () => api<JLine[]>(`/systemd/services/${encodeURIComponent(name)}/journal?lines=150`), enabled: isAdmin });
  const s = d.data;
  return (
    <Dialog open wide onClose={onClose} title={name} description={s?.description}>
      {d.isError && <ErrorBox error={d.error} compact />}
      {!s && !d.isError && <Skeleton className="h-40" />}
      {s && (
        <dl>
          <Kv k="Stato"><Badge tone={svcTone(s)}>{s.active} · {s.sub}</Badge></Kv>
          {s.lastEvent && <Kv k="Ultimo esito">{s.lastEvent.state === 'failed' ? <span className="text-err">{s.lastEvent.message}</span> : s.lastEvent.message} · {ago(s.lastEvent.ts)}</Kv>}
          <Kv k="Avvio automatico">{s.unitFileState || '—'}</Kv>
          <Kv k="PID">{s.mainPid || '—'}</Kv>
          <Kv k="Memoria">{s.memory !== null ? bytes(s.memory) : '—'}</Kv>
          <Kv k="CPU totale">{s.cpuNs !== null ? `${(s.cpuNs / 1e9).toFixed(1)} s` : '—'}</Kv>
          <Kv k="Processi">{s.tasks ?? '—'}</Kv>
          <Kv k="File unità" mono>{s.fragment || '—'}</Kv>
        </dl>
      )}
      {isAdmin && (
        <div className="mt-4">
          <div className="mb-1.5 text-xs font-medium text-fg-2">Log del servizio (journal)</div>
          {j.isError && <ErrorBox error={j.error} compact />}
          {!j.data && !j.isError && <Skeleton className="h-32" />}
          {j.data && (
            <div className="max-h-72 overflow-auto rounded-xl border border-line bg-[#07080b] p-2.5 font-mono text-[11px] leading-5 text-[#d7dae0]">
              {j.data.length === 0 ? <span className="text-[#7a8291]">Nessuna riga.</span> : j.data.map((l, k) => (
                <div key={k} className={cx('whitespace-pre-wrap break-all', ['emerg', 'alert', 'crit', 'err'].includes(l.priority) ? 'text-[#f6a5ad]' : l.priority === 'warning' ? 'text-[#f5d08a]' : '')}>
                  <span className="text-[#5d6574]">{new Date(l.ts).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })} </span>
                  {l.message}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
