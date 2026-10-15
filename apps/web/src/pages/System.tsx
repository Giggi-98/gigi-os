import { Cpu, HardDrive, Network, Thermometer } from 'lucide-react';
import { useState } from 'react';
import { AreaChart } from '../components/Chart';
import { Badge, Card, cx, ErrorBox, Kv, Meter, PageHeader, Select, Skeleton } from '../components/ui';
import { bytes, duration, pct, rate } from '../lib/format';
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
            <p className="mt-3 text-[11px] leading-relaxed text-muted">
              Servizi systemd, journal, processi e aggiornamenti arriveranno con l’adapter host a operazioni consentite (fase successiva).
            </p>
          </Card>
        </div>
      )}
    </div>
  );
}
