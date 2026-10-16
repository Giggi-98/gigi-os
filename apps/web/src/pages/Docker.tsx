import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownToLine, ArrowUpDown, Lock, Pause, Play, Power, RotateCw, Search, Square, Trash2, WrapText, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Badge,
  Button,
  Card,
  containerLabel,
  containerTone,
  cx,
  Dialog,
  Dot,
  Empty,
  ErrorBox,
  Input,
  Kv,
  PageHeader,
  Select,
  Skeleton,
  Tabs,
  useToast,
} from '../components/ui';
import { api, type Container, type ContainerDetail } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ago, bytes, dateTime, pct } from '../lib/format';
import { useContainers } from '../lib/queries';
import { DeleteDialog, imageItem, isOwn, LocalBadge, removableNetwork, SpaceTab, useImages, useNetworks, useVolumes, type CleanupItem, type CleanupKind } from './DockerCleanup';
import { StacksTab } from './DockerStacks';

type Tab = 'containers' | 'stacks' | 'images' | 'volumes' | 'networks' | 'space';

export function DockerPage() {
  const [tab, setTab] = useState<Tab>('containers');
  const containers = useContainers();
  const info = useQuery({ queryKey: ['docker-info'], queryFn: () => api<{ version: string; running: number; containers: number; images: number; loggingDriver: string; storageDriver: string }>('/docker/info'), staleTime: 60_000 });
  return (
    <div>
      <PageHeader
        title="Docker"
        description={info.data ? `Engine ${info.data.version} · ${info.data.running}/${info.data.containers} container attivi · storage ${info.data.storageDriver} · log ${info.data.loggingDriver}` : 'Container, immagini, volumi e reti'}
      />
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { id: 'containers', label: 'Container', count: containers.data?.length },
          { id: 'stacks', label: 'Stack' },
          { id: 'images', label: 'Immagini' },
          { id: 'volumes', label: 'Volumi' },
          { id: 'networks', label: 'Reti' },
          { id: 'space', label: 'Spazio e pulizia' },
        ]}
      />
      <div className="mt-4">
        {tab === 'containers' && <ContainersTab q={containers} />}
        {tab === 'stacks' && <StacksTab />}
        {tab === 'images' && <ImagesTab />}
        {tab === 'volumes' && <VolumesTab />}
        {tab === 'networks' && <NetworksTab />}
        {tab === 'space' && <SpaceTab />}
      </div>
    </div>
  );
}

type SortKey = 'name' | 'state' | 'cpu' | 'mem' | 'project';

function ContainersTab({ q }: { q: ReturnType<typeof useContainers> }) {
  const [params, setParams] = useSearchParams();
  const selected = params.get('c');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 });

  const rows = useMemo(() => {
    let r = q.data ?? [];
    const s = search.trim().toLowerCase();
    if (s) r = r.filter((c) => [c.name, c.image, c.composeProject ?? ''].some((v) => v.toLowerCase().includes(s)));
    if (filter === 'running') r = r.filter((c) => c.state === 'running');
    if (filter === 'stopped') r = r.filter((c) => c.state !== 'running');
    if (filter === 'problems') r = r.filter((c) => c.state !== 'running' || c.health === 'unhealthy' || c.restartCount > 0);
    const val = (c: Container): string | number =>
      sort.key === 'cpu' ? c.stats?.cpu ?? -1 : sort.key === 'mem' ? c.stats?.memUsed ?? -1 : sort.key === 'state' ? containerLabel(c.state, c.health) : sort.key === 'project' ? c.composeProject ?? '' : c.name;
    return [...r].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      return (typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb))) * sort.dir;
    });
  }, [q.data, search, filter, sort]);

  const th = (key: SortKey, label: string, cls = '') => (
    <th className={cx('px-3 py-2 font-medium', cls)} aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button className="inline-flex items-center gap-1 hover:text-fg" onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === 'cpu' || key === 'mem' ? -1 : 1 }))}>
        {label}
        <ArrowUpDown className={cx('size-3', sort.key === key ? 'text-fg' : 'opacity-40')} />
      </button>
    </th>
  );

  return (
    <>
      <div className="mb-3 flex flex-wrap gap-2">
        <div className="relative min-w-52 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted" />
          <Input className="pl-8" placeholder="Cerca nome, immagine, stack…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Cerca container" />
        </div>
        <Select className="w-auto" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filtra per stato">
          <option value="all">Tutti</option>
          <option value="running">In esecuzione</option>
          <option value="stopped">Fermi</option>
          <option value="problems">Con problemi o riavvii</option>
        </Select>
      </div>
      <Card bodyClassName="!p-0" className="overflow-hidden">
        {q.isError ? (
          <div className="p-4">
            <ErrorBox error={q.error} />
          </div>
        ) : !q.data ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <Empty title="Nessun container corrisponde ai filtri" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-[13px]">
              <thead className="border-b border-line text-xs text-muted">
                <tr>
                  {th('name', 'Nome', 'pl-4')}
                  {th('state', 'Stato')}
                  {th('project', 'Stack')}
                  <th className="px-3 py-2 font-medium">Porte</th>
                  {th('cpu', 'CPU', 'text-right')}
                  {th('mem', 'RAM', 'text-right')}
                  <th className="px-3 py-2 pr-4 text-right font-medium">Avvio</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr
                    key={c.id}
                    tabIndex={0}
                    onClick={() => setParams({ c: c.name })}
                    onKeyDown={(e) => e.key === 'Enter' && setParams({ c: c.name })}
                    className={cx('cursor-pointer border-b border-line/60 last:border-0 hover:bg-surface-2', selected === c.name && 'bg-surface-2')}
                  >
                    <td className="py-2.5 pr-3 pl-4">
                      <div className="flex items-center gap-2">
                        <Dot tone={containerTone(c.state, c.health)} />
                        <div className="min-w-0">
                          <div className="truncate font-medium">{c.name}</div>
                          <div className="max-w-[280px] truncate text-xs text-muted">{c.image}</div>
                        </div>
                        {!c.controllable && <Lock className="size-3.5 shrink-0 text-muted" aria-label="Protetto" />}
                      </div>
                    </td>
                    <td className="px-3">
                      <Badge tone={containerTone(c.state, c.health)}>{containerLabel(c.state, c.health)}</Badge>
                      {c.restartCount > 0 && <Badge tone="warn" className="ml-1">{c.restartCount} riavvii</Badge>}
                    </td>
                    <td className="px-3 text-fg-2">{c.composeProject ?? '—'}</td>
                    <td className="px-3 font-mono text-xs text-fg-2">
                      {c.networkMode === 'host' ? <span className="text-muted">rete host</span> : portsLabel(c) || '—'}
                    </td>
                    <td className="px-3 text-right tabular">{c.stats ? pct(c.stats.cpu, 1) : '—'}</td>
                    <td className="px-3 text-right tabular">{c.stats ? bytes(c.stats.memUsed) : '—'}</td>
                    <td className="px-3 pr-4 text-right text-xs text-muted">{c.state === 'running' ? ago(c.startedAt) : ago(c.finishedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {selected && <ContainerDrawer name={selected} onClose={() => setParams({})} />}
    </>
  );
}

function portsLabel(c: Container) {
  const seen = new Set<string>();
  return c.ports
    .filter((p) => p.public)
    .map((p) => `${p.ip && p.ip !== '0.0.0.0' && p.ip !== '::' ? `${p.ip}:` : ''}${p.public}→${p.private}/${p.type}`)
    .filter((s) => (seen.has(s) ? false : (seen.add(s), true)))
    .join(', ');
}

type DTab = 'overview' | 'logs' | 'env' | 'storage';

function ContainerDrawer({ name, onClose }: { name: string; onClose: () => void }) {
  const { isAdmin, isOperator } = useAuth();
  const [tab, setTab] = useState<DTab>('overview');
  const [action, setAction] = useState<'start' | 'stop' | 'restart' | null>(null);
  const [remove, setRemove] = useState(false);
  const d = useQuery({ queryKey: ['container', name], queryFn: () => api<ContainerDetail>(`/docker/containers/${encodeURIComponent(name)}`), refetchInterval: 10_000 });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !action && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, action]);

  const c = d.data;
  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-label={`Dettaglio ${name}`}>
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative flex h-full w-full max-w-3xl flex-col border-l border-line-strong bg-bg-2 pt-[env(safe-area-inset-top,0px)] shadow-2xl">
        <div className="flex items-start gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {c && <Dot tone={containerTone(c.state.status, c.state.health?.status ?? null)} />}
              <h2 className="truncate text-base font-semibold">{name}</h2>
              {c && <Badge tone={containerTone(c.state.status, c.state.health?.status ?? null)}>{containerLabel(c.state.status, c.state.health?.status ?? null)}</Badge>}
            </div>
            <p className="mt-0.5 truncate font-mono text-xs text-muted">{c?.image}</p>
          </div>
          {isOperator && c && (
            <div className="flex shrink-0 gap-1.5">
              {c.controllable ? (
                <>
                  {c.state.running ? (
                    <>
                      <Button size="sm" onClick={() => setAction('restart')}>
                        <RotateCw /> Riavvia
                      </Button>
                      {isAdmin && (
                        <Button size="sm" onClick={() => setAction('stop')}>
                          <Square /> Ferma
                        </Button>
                      )}
                    </>
                  ) : (
                    <>
                      <Button size="sm" variant="primary" onClick={() => setAction('start')}>
                        <Power /> Avvia
                      </Button>
                      {isAdmin && (
                        <Button size="sm" variant="danger" onClick={() => setRemove(true)}>
                          <Trash2 /> Rimuovi
                        </Button>
                      )}
                    </>
                  )}
                </>
              ) : (
                <Badge>
                  <Lock className="size-3" /> Protetto
                </Badge>
              )}
            </div>
          )}
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Chiudi">
            <X />
          </Button>
        </div>
        <div className="px-5">
          <Tabs
            value={tab}
            onChange={setTab}
            items={[
              { id: 'overview', label: 'Panoramica' },
              ...(isOperator ? [{ id: 'logs' as const, label: 'Log' }] : []),
              ...(isAdmin ? [{ id: 'env' as const, label: 'Configurazione' }] : []),
              { id: 'storage', label: 'Mount e rete' },
            ]}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {d.isError && <ErrorBox error={d.error} />}
          {!c && !d.isError && <Skeleton className="h-40 w-full" />}
          {c && tab === 'overview' && <Overview c={c} />}
          {c && tab === 'logs' && <Logs name={name} />}
          {c && tab === 'env' && <EnvTab c={c} />}
          {c && tab === 'storage' && <StorageTab c={c} />}
        </div>
      </div>
      {action && c && <ActionDialog name={name} action={action} onClose={() => setAction(null)} />}
      {remove && c && (
        <DeleteDialog
          kind="container"
          items={[{ id: c.name, label: c.name, detail: c.image }]}
          onClose={() => setRemove(false)}
          onDone={onClose}
        />
      )}
    </div>
  );
}

function Overview({ c }: { c: ContainerDetail }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Stato">
        <dl>
          <Kv k="Stato">{c.state.status}</Kv>
          <Kv k="Avviato">{c.state.running ? `${dateTime(c.state.startedAt)} (${ago(c.state.startedAt)})` : '—'}</Kv>
          {!c.state.running && <Kv k="Terminato">{dateTime(c.state.finishedAt)} · exit {c.state.exitCode}</Kv>}
          <Kv k="Riavvii">{c.restartCount}</Kv>
          <Kv k="Policy riavvio">{c.restartPolicy?.Name || 'no'}</Kv>
          <Kv k="OOM killed">{c.state.oomKilled ? 'sì' : 'no'}</Kv>
          {c.state.error && <Kv k="Errore">{c.state.error}</Kv>}
        </dl>
      </Card>
      <Card title="Risorse e sicurezza">
        <dl>
          <Kv k="CPU">{c.stats ? pct(c.stats.cpu, 1) : '—'}</Kv>
          <Kv k="RAM">{c.stats ? bytes(c.stats.memUsed) : '—'}</Kv>
          <Kv k="Rete (totale)">{c.stats ? `↓ ${bytes(c.stats.rx)} · ↑ ${bytes(c.stats.tx)}` : c.networkMode === 'host' ? 'rete host' : '—'}</Kv>
          <Kv k="Privilegiato">{c.privileged ? <span className="text-err">sì</span> : 'no'}</Kv>
          <Kv k="Utente">{c.user ?? 'root (predefinito immagine)'}</Kv>
          <Kv k="Dispositivi">{c.devices.join(', ') || '—'}</Kv>
          <Kv k="Capability aggiunte">{c.capAdd.join(', ') || '—'}</Kv>
        </dl>
      </Card>
      {c.state.health && (
        <Card title="Healthcheck" className="lg:col-span-2">
          <p className="mb-2 text-xs text-muted">
            Stato <b className="text-fg-2">{c.state.health.status}</b> · fallimenti consecutivi {c.state.health.failingStreak}
          </p>
          <ul className="space-y-1.5">
            {c.state.health.log.map((l, i) => (
              <li key={i} className="rounded-lg bg-surface-2 px-2.5 py-1.5 font-mono text-xs">
                <span className={l.exitCode === 0 ? 'text-ok' : 'text-err'}>exit {l.exitCode}</span> <span className="text-muted">{dateTime(l.start)}</span>
                {l.output.trim() && <div className="mt-0.5 break-all whitespace-pre-wrap text-fg-2">{l.output.trim()}</div>}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function EnvTab({ c }: { c: ContainerDetail }) {
  return (
    <div className="space-y-4">
      <Card title="Variabili d’ambiente" subtitle="I valori sensibili sono oscurati dall’agent prima di lasciare il server.">
        {c.env?.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <tbody>
                {c.env.map((e) => (
                  <tr key={e.key} className="border-b border-line/60 last:border-0">
                    <td className="py-1.5 pr-3 font-mono font-medium text-fg-2">{e.key}</td>
                    <td className={cx('py-1.5 font-mono break-all', e.redacted ? 'text-muted' : 'text-fg')}>{e.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-xs text-muted">Nessuna variabile.</p>
        )}
      </Card>
      <Card title="Comando">
        <pre className="overflow-x-auto rounded-lg bg-surface-2 p-2.5 font-mono text-xs whitespace-pre-wrap text-fg-2">
          {[...(c.entrypoint ?? []), ...(c.cmd ?? [])].join(' ') || '—'}
        </pre>
      </Card>
      {c.labels && c.labels.length > 0 && (
        <Card title="Etichette">
          <dl>
            {c.labels.map((l) => (
              <Kv key={l.key} k={l.key} mono>
                {l.value}
              </Kv>
            ))}
          </dl>
        </Card>
      )}
    </div>
  );
}

function StorageTab({ c }: { c: ContainerDetail }) {
  return (
    <div className="space-y-4">
      <Card title="Mount">
        {c.mounts.length === 0 ? (
          <p className="text-xs text-muted">Nessun mount.</p>
        ) : (
          <ul className="space-y-1.5">
            {c.mounts.map((m) => (
              <li key={m.destination} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg bg-surface-2 px-2.5 py-2 font-mono text-xs">
                <Badge tone={m.rw ? 'warn' : 'ok'}>{m.rw ? 'rw' : 'ro'}</Badge>
                <Badge>{m.type}</Badge>
                <span className="break-all text-fg-2">{m.name ?? m.source}</span>
                <span className="text-muted">→</span>
                <span className="break-all">{m.destination}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Rete">
        <dl>
          <Kv k="Modalità">{c.networkMode}</Kv>
          {c.networks.map((n) => (
            <Kv key={n.name} k={n.name} mono>
              {n.ip ?? '—'}
            </Kv>
          ))}
          {c.ports.map((p) => (
            <Kv key={p.container} k={`Porta ${p.container}`} mono>
              {p.host.length ? p.host.join(', ') : 'non pubblicata'}
            </Kv>
          ))}
        </dl>
      </Card>
    </div>
  );
}

type LogLine = { ts: string; stream: 'stdout' | 'stderr'; line: string };

function Logs({ name }: { name: string }) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [status, setStatus] = useState<'connecting' | 'live' | 'ended' | 'error'>('connecting');
  const [paused, setPaused] = useState(false);
  const [follow, setFollow] = useState(true);
  const [wrap, setWrap] = useState(true);
  const [filter, setFilter] = useState('');
  const [tail, setTail] = useState(300);
  const box = useRef<HTMLDivElement>(null);
  const buffer = useRef<LogLine[]>([]);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    setLines([]);
    buffer.current = [];
    setStatus('connecting');
    const es = new EventSource(`/api/v1/docker/containers/${encodeURIComponent(name)}/logs?tail=${tail}&follow=1`);
    let flush: ReturnType<typeof setInterval> | null = null;
    es.onopen = () => setStatus('live');
    es.onmessage = (ev) => {
      try {
        buffer.current.push(JSON.parse(ev.data));
      } catch {}
    };
    es.addEventListener('end', () => {
      setStatus('ended');
      es.close();
    });
    es.onerror = () => {
      setStatus((s) => (s === 'ended' ? s : 'error'));
      es.close();
    };
    flush = setInterval(() => {
      if (pausedRef.current || buffer.current.length === 0) return;
      const add = buffer.current;
      buffer.current = [];
      setLines((l) => {
        const next = l.concat(add);
        return next.length > 3000 ? next.slice(next.length - 3000) : next;
      });
    }, 250);
    return () => {
      es.close();
      if (flush) clearInterval(flush);
    };
  }, [name, tail]);

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines, follow]);

  const shown = filter ? lines.filter((l) => l.line.toLowerCase().includes(filter.toLowerCase())) : lines;

  return (
    <div className="flex h-full min-h-[60vh] flex-col">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Badge tone={status === 'live' ? 'ok' : status === 'error' ? 'err' : 'idle'}>
          <Dot tone={status === 'live' ? 'ok' : status === 'error' ? 'err' : 'idle'} pulse={status === 'live' && !paused} />
          {status === 'live' ? (paused ? 'In pausa' : 'In diretta') : status === 'connecting' ? 'Connessione…' : status === 'ended' ? 'Stream terminato' : 'Disconnesso'}
        </Badge>
        <div className="relative min-w-40 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted" />
          <Input className="h-8 pl-8 text-xs" placeholder="Filtra righe…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filtra log" />
        </div>
        <Select className="h-8 w-auto text-xs" value={tail} onChange={(e) => setTail(Number(e.target.value))} aria-label="Righe iniziali">
          <option value={100}>Ultime 100</option>
          <option value={300}>Ultime 300</option>
          <option value={1000}>Ultime 1000</option>
        </Select>
        <Button size="sm" variant="ghost" onClick={() => setPaused((p) => !p)} aria-pressed={paused}>
          {paused ? <Play /> : <Pause />} {paused ? 'Riprendi' : 'Pausa'}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setFollow((f) => !f)} aria-pressed={follow} className={cx(follow && 'text-accent')}>
          <ArrowDownToLine /> Segui
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setWrap((w) => !w)} aria-pressed={wrap} className={cx(wrap && 'text-accent')}>
          <WrapText /> A capo
        </Button>
      </div>
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          if (!atBottom && follow) setFollow(false);
        }}
        className="min-h-0 flex-1 overflow-auto rounded-xl border border-line bg-[#07080b] p-3 font-mono text-[12px] leading-5 text-[#d7dae0]"
        role="log"
        aria-live="off"
      >
        {shown.length === 0 ? (
          <div className="text-[#7a8291]">{status === 'connecting' ? 'Connessione allo stream…' : filter ? 'Nessuna riga corrisponde al filtro.' : 'Nessun log.'}</div>
        ) : (
          shown.map((l, i) => (
            <div key={i} className={cx('flex gap-3', wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre')}>
              <span className="shrink-0 text-[#5d6574] select-none">{l.ts ? new Date(l.ts).toLocaleTimeString('it-IT') : ''}</span>
              <span className={l.stream === 'stderr' ? 'text-[#f6a5ad]' : undefined}>{l.line}</span>
            </div>
          ))
        )}
      </div>
      <p className="mt-2 text-[11px] text-muted">Token, password e API key riconoscibili vengono oscurati dall’agent. Vengono mantenute al massimo 3000 righe.</p>
    </div>
  );
}

const ACTION_COPY = {
  start: { title: 'Avviare', verb: 'Avvia', impact: 'Il container verrà avviato con la sua configurazione attuale.' },
  stop: { title: 'Fermare', verb: 'Ferma', impact: 'Il servizio smetterà di rispondere finché non verrà riavviato. Le app che dipendono da esso potrebbero smettere di funzionare.' },
  restart: { title: 'Riavviare', verb: 'Riavvia', impact: 'Il servizio sarà irraggiungibile per qualche secondo; sessioni e stream attivi verranno interrotti.' },
};

function ActionDialog({ name, action, onClose }: { name: string; action: 'start' | 'stop' | 'restart'; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState('');
  const copy = ACTION_COPY[action];
  const needsConfirm = action !== 'start';
  const m = useMutation({
    mutationFn: () => api(`/docker/containers/${encodeURIComponent(name)}/actions`, { method: 'POST', body: { action, confirm: needsConfirm ? confirm : undefined } }),
    onSuccess: () => {
      toast('ok', `${copy.verb}: ${name} — operazione registrata nell’audit log`);
      void qc.invalidateQueries({ queryKey: ['containers'] });
      void qc.invalidateQueries({ queryKey: ['container', name] });
      void qc.invalidateQueries({ queryKey: ['overview'] });
      onClose();
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${copy.title} ${name}?`}
      description={copy.impact}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annulla
          </Button>
          <Button variant={action === 'start' ? 'primary' : 'danger'} loading={m.isPending} disabled={needsConfirm && confirm !== name} onClick={() => m.mutate()}>
            {copy.verb}
          </Button>
        </>
      }
    >
      {needsConfirm && (
        <div className="space-y-1.5">
          <label htmlFor="confirm-name" className="text-xs text-fg-2">
            Per confermare digita <b className="font-mono text-fg">{name}</b>
          </label>
          <Input id="confirm-name" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoFocus autoComplete="off" spellCheck={false} />
        </div>
      )}
      {m.isError && (
        <div className="mt-3">
          <ErrorBox error={m.error} compact />
        </div>
      )}
    </Dialog>
  );
}

/** Selezione multipla per le tabelle con eliminazione (solo admin). */
function useSelection() {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return { sel, toggle, clear: () => setSel(new Set()), setAll: (ids: string[]) => setSel(new Set(ids)) };
}

function SelectionBar({ count, onDelete, onClear, children }: { count: number; onDelete: () => void; onClear: () => void; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {children}
      {count > 0 && (
        <>
          <span className="text-xs text-fg-2">{count} selezionat{count === 1 ? 'a' : 'e'}</span>
          <Button size="sm" variant="ghost" onClick={onClear}>Deseleziona</Button>
          <Button size="sm" variant="danger" onClick={onDelete}>
            <Trash2 /> Elimina
          </Button>
        </>
      )}
    </div>
  );
}

function RowCheck({ checked, disabled, onChange, label, title }: { checked: boolean; disabled?: boolean; onChange: () => void; label: string; title?: string }) {
  return (
    <input type="checkbox" className="size-4 accent-[var(--err)] disabled:opacity-30" checked={checked} disabled={disabled} onChange={onChange} aria-label={label} title={title} />
  );
}

function ImagesTab() {
  const { isAdmin } = useAuth();
  const q = useImages();
  const s = useSelection();
  const [dialog, setDialog] = useState<CleanupItem[] | null>(null);
  if (q.isError) return <ErrorBox error={q.error} />;
  if (!q.data) return <Skeleton className="h-60 w-full" />;
  const total = q.data.reduce((a, i) => a + i.size, 0);
  const unused = q.data.filter((i) => i.containers.length === 0);
  return (
    <Card
      bodyClassName="!p-0"
      title={`${q.data.length} immagini · ${bytes(total)}`}
      subtitle={`${unused.length} non usate da alcun container (${bytes(unused.reduce((a, i) => a + i.size, 0))}). Le immagini in uso non si possono selezionare.`}
      actions={isAdmin && <SelectionBar count={s.sel.size} onClear={s.clear} onDelete={() => setDialog(q.data.filter((i) => s.sel.has(i.id)).map(imageItem))} />}
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-[13px]">
          <thead className="border-y border-line text-xs text-muted">
            <tr>
              {isAdmin && <th className="w-8 py-2 pl-4"><span className="sr-only">Seleziona</span></th>}
              <th className="px-4 py-2 font-medium">Immagine</th>
              <th className="px-3 py-2 font-medium">Usata da</th>
              <th className="px-3 py-2 text-right font-medium">Dimensione</th>
              <th className="px-4 py-2 text-right font-medium">Creata</th>
            </tr>
          </thead>
          <tbody>
            {[...q.data].sort((a, b) => b.size - a.size).map((i) => (
              <tr key={i.id} className={cx('border-b border-line/60 last:border-0', s.sel.has(i.id) && 'bg-err-soft')}>
                {isAdmin && (
                  <td className="py-2 pl-4">
                    <RowCheck checked={s.sel.has(i.id)} disabled={i.containers.length > 0} onChange={() => s.toggle(i.id)} label={`Seleziona ${i.tags[0] ?? i.id.slice(7, 19)}`} title={i.containers.length ? 'In uso' : undefined} />
                  </td>
                )}
                <td className="px-4 py-2 font-mono text-xs">
                  {i.tags.join(', ') || <span className="text-muted">{i.id.slice(7, 19)} (dangling)</span>}
                  {i.local && !i.dangling && <span className="ml-2 align-middle"><LocalBadge /></span>}
                </td>
                <td className="px-3 py-2">{i.containers.length ? i.containers.join(', ') : <Badge>inutilizzata</Badge>}</td>
                <td className="px-3 py-2 text-right tabular">{bytes(i.size)}</td>
                <td className="px-4 py-2 text-right text-xs text-muted">{ago(i.created)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {dialog && <DeleteDialog kind="image" items={dialog} onClose={() => { setDialog(null); s.clear(); }} />}
    </Card>
  );
}

function VolumesTab() {
  const { isAdmin } = useAuth();
  const q = useVolumes();
  const s = useSelection();
  const [dialog, setDialog] = useState<CleanupItem[] | null>(null);
  if (q.isError) return <ErrorBox error={q.error} />;
  if (!q.data) return <Skeleton className="h-40 w-full" />;
  if (q.data.length === 0) return <Empty title="Nessun volume Docker" />;
  const removable = (v: { name: string; containers: string[] }) => v.containers.length === 0 && !isOwn(v.name);
  return (
    <Card
      bodyClassName="!p-0"
      title={`${q.data.length} volumi`}
      subtitle="Un volume si può eliminare solo se nessun container (nemmeno fermo) lo usa."
      actions={isAdmin && <SelectionBar count={s.sel.size} onClear={s.clear} onDelete={() => setDialog(q.data.filter((v) => s.sel.has(v.name)).map((v) => ({ id: v.name, label: v.name, detail: v.project ?? undefined })))} />}
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-[13px]">
          <thead className="border-y border-line text-xs text-muted">
            <tr>
              {isAdmin && <th className="w-8 py-2 pl-4"><span className="sr-only">Seleziona</span></th>}
              <th className="px-4 py-2 font-medium">Volume</th>
              <th className="px-3 py-2 font-medium">Stack</th>
              <th className="px-4 py-2 font-medium">Usato da</th>
            </tr>
          </thead>
          <tbody>
            {q.data.map((v) => (
              <tr key={v.name} className={cx('border-b border-line/60 last:border-0', s.sel.has(v.name) && 'bg-err-soft')}>
                {isAdmin && (
                  <td className="py-2 pl-4">
                    <RowCheck checked={s.sel.has(v.name)} disabled={!removable(v)} onChange={() => s.toggle(v.name)} label={`Seleziona ${v.name}`} title={isOwn(v.name) ? 'Volume di GIGI OS' : v.containers.length ? 'In uso' : undefined} />
                  </td>
                )}
                <td className="px-4 py-2">
                  <div className="font-mono text-xs">{v.name}</div>
                  <div className="truncate font-mono text-[11px] text-muted">{v.mountpoint}</div>
                </td>
                <td className="px-3 py-2 text-fg-2">{v.project ?? '—'}</td>
                <td className="px-4 py-2">{v.containers.length ? v.containers.join(', ') : <Badge tone="warn">orfano</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {dialog && <DeleteDialog kind="volume" items={dialog} onClose={() => { setDialog(null); s.clear(); }} />}
    </Card>
  );
}

function NetworksTab() {
  const { isAdmin } = useAuth();
  const q = useNetworks();
  const [dialog, setDialog] = useState<{ kind: CleanupKind; items: CleanupItem[] } | null>(null);
  if (q.isError) return <ErrorBox error={q.error} />;
  if (!q.data) return <Skeleton className="h-40 w-full" />;
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {q.data.map((n) => (
        <Card
          key={n.id}
          title={n.name}
          subtitle={`${n.driver}${n.subnet ? ` · ${n.subnet}` : ''}`}
          actions={
            isAdmin &&
            removableNetwork(n) && (
              <Button size="icon" variant="ghost" aria-label={`Elimina la rete ${n.name}`} onClick={() => setDialog({ kind: 'network', items: [{ id: n.id, label: n.name, detail: n.driver }] })}>
                <Trash2 />
              </Button>
            )
          }
        >
          {n.containers.length ? (
            <div className="flex flex-wrap gap-1">
              {n.containers.map((c) => (
                <Badge key={c}>{c}</Badge>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted">Nessun container collegato.</p>
          )}
        </Card>
      ))}
      {dialog && <DeleteDialog {...dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}
