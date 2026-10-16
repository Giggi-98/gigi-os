// Storico delle metriche (D-027): l'API raccoglie dall'agent i dati che già espone e li salva nel proprio SQLite.
// L'agent resta senza stato. Host al minuto, container a 5 minuti, dischi all'ora; i buchi restano buchi.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AgentClient } from './agent.js';
import type { DB } from './db.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const C_BUCKET = 5 * MIN;

/** Intervalli consultabili e ampiezza dei punti: circa 300 punti per grafico. */
export const RANGES = {
  '1h': { ms: HOUR, bucket: MIN },
  '24h': { ms: DAY, bucket: 5 * MIN },
  '7d': { ms: 7 * DAY, bucket: 30 * MIN },
  '30d': { ms: 30 * DAY, bucket: 2 * HOUR },
} as const;
export type Range = keyof typeof RANGES;

type Sample = { t: number; cpu: number; mem: number; rx: number; tx: number; load1: number; temp: number | null };
type HostRow = { t: number; cpu: number; cpu_max: number; mem: number; rx: number; tx: number; load1: number; temp: number | null; n: number };
type ContainerInfo = { name: string; state: string; stats: { cpu: number; memUsed: number; t: number } | null };
type DiskInfo = { label: string; total: number; free: number; used: number; ok: boolean };
type DiskPoint = { t: number; used: number; free: number; total: number };

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const r1 = (n: number) => Math.round(n * 10) / 10;

/** Raggruppa i campioni a 5 s in minuti completi (quelli che finiscono entro `before`). */
export function aggregateMinutes(samples: Sample[], before: number): HostRow[] {
  const groups = new Map<number, Sample[]>();
  for (const s of samples) {
    const m = Math.floor(s.t / MIN) * MIN;
    if (m + MIN > before) continue;
    const g = groups.get(m);
    if (g) g.push(s);
    else groups.set(m, [s]);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, g]) => {
      const temps = g.map((s) => s.temp).filter((x): x is number => x !== null);
      return {
        t,
        cpu: r1(avg(g.map((s) => s.cpu))),
        cpu_max: Math.max(...g.map((s) => s.cpu)),
        mem: r1(avg(g.map((s) => s.mem))),
        rx: Math.round(avg(g.map((s) => s.rx))),
        tx: Math.round(avg(g.map((s) => s.tx))),
        load1: g[g.length - 1].load1,
        temp: temps.length ? r1(avg(temps)) : null,
        n: g.length,
      };
    });
}

export type Forecast =
  | { status: 'insufficient'; dataDays: number }
  | { status: 'stable' | 'shrinking'; perDay: number; dataDays: number }
  | { status: 'growing'; perDay: number; days: number; daysMin: number; daysMax: number | null; dataDays: number };

/**
 * Stima indicativa di quando il disco si riempie: regressione lineare dello spazio usato sugli ultimi 14 giorni.
 * Servono almeno 3 giorni e 48 punti; sotto una crescita dello 0,5% del disco al mese il disco è «stabile».
 * L'intervallo usa ±2 errori standard della pendenza (i punti orari sono correlati: è un ordine di grandezza, non una garanzia).
 */
export function forecastDisk(points: DiskPoint[]): Forecast {
  const span = points.length ? (points[points.length - 1].t - points[0].t) / DAY : 0;
  const dataDays = Math.round(span * 10) / 10;
  if (points.length < 48 || span < 3) return { status: 'insufficient', dataDays };
  const xs = points.map((p) => (p.t - points[0].t) / DAY);
  const ys = points.map((p) => p.used);
  const mx = avg(xs);
  const my = avg(ys);
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  const slope = sxy / sxx;
  let sse = 0;
  for (let i = 0; i < xs.length; i++) sse += (ys[i] - (my + slope * (xs[i] - mx))) ** 2;
  const se = Math.sqrt(sse / (xs.length - 2) / sxx);
  const last = points[points.length - 1];
  const perDay = Math.round(slope);
  const threshold = (0.005 * last.total) / 30;
  if (Math.abs(slope) < threshold) return { status: 'stable', perDay, dataDays };
  if (slope < 0) return { status: 'shrinking', perDay, dataDays };
  const days = last.free / slope;
  const hi = slope + 2 * se;
  const lo = slope - 2 * se;
  return {
    status: 'growing',
    perDay,
    days: Math.round(days),
    daysMin: Math.round(last.free / hi),
    daysMax: lo > threshold ? Math.round(last.free / lo) : null,
    dataDays,
  };
}

function grid(from: number, to: number, b: number) {
  const times: number[] = [];
  for (let t = Math.floor(from / b) * b; t <= to; t += b) times.push(t);
  return times;
}

export class Metrics {
  private lastStat = new Map<string, number>();

  constructor(
    private db: DB,
    private agent: Pick<AgentClient, 'json'>,
    private retentionDays = 30,
    private now = () => Date.now(),
  ) {}

  /** Salva i minuti completi dallo storico in memoria dell'agent (1 h): recupera anche i buchi brevi dell'API. */
  async collectHost() {
    const now = this.now();
    const last = (this.db.prepare('SELECT MAX(t) AS t FROM metrics_host').get() as { t: number | null }).t;
    const since = Math.max(last !== null ? last + MIN : 0, now - HOUR);
    const samples = await this.agent.json<Sample[]>('GET', `/v1/system/history?since=${since}`);
    const rows = aggregateMinutes((samples ?? []).filter((s) => s.t >= since), now);
    const ins = this.db.prepare(
      'INSERT OR IGNORE INTO metrics_host (t, cpu, cpu_max, mem, rx, tx, load1, temp, n) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const r of rows) ins.run(r.t, r.cpu, r.cpu_max, r.mem, r.rx, r.tx, r.load1, r.temp, r.n);
    return rows.length;
  }

  /** Un campione per container in esecuzione, sommato nel bucket di 5 minuti (le statistiche già pronte nell'agent). */
  async collectContainers() {
    const now = this.now();
    const list = await this.agent.json<ContainerInfo[]>('GET', '/v1/containers');
    const up = this.db.prepare(
      `INSERT INTO metrics_container (t, name, cpu_sum, mem_sum, mem_max, n) VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT (t, name) DO UPDATE SET cpu_sum = cpu_sum + excluded.cpu_sum, mem_sum = mem_sum + excluded.mem_sum,
       mem_max = MAX(mem_max, excluded.mem_max), n = n + 1`,
    );
    let n = 0;
    for (const c of list ?? []) {
      const s = c.stats;
      if (c.state !== 'running' || !s || now - s.t > 2 * MIN || this.lastStat.get(c.name) === s.t) continue;
      this.lastStat.set(c.name, s.t);
      up.run(Math.floor(s.t / C_BUCKET) * C_BUCKET, c.name, s.cpu, s.memUsed, s.memUsed);
      n++;
    }
    return n;
  }

  /** Ultimo valore di ogni disco nell'ora corrente. */
  async collectDisks() {
    const now = this.now();
    const s = await this.agent.json<{ disks?: DiskInfo[] } | null>('GET', '/v1/system');
    const ins = this.db.prepare('INSERT OR REPLACE INTO metrics_disk (t, label, used, free, total) VALUES (?, ?, ?, ?, ?)');
    const t = Math.floor(now / HOUR) * HOUR;
    let n = 0;
    for (const d of s?.disks ?? []) {
      if (!d.ok || d.total <= 0) continue;
      ins.run(t, d.label, d.used, d.free, d.total);
      n++;
    }
    return n;
  }

  purge() {
    const cut = this.now() - this.retentionDays * DAY;
    for (const table of ['metrics_host', 'metrics_container', 'metrics_disk']) this.db.prepare(`DELETE FROM ${table} WHERE t < ?`).run(cut);
  }

  start(warn: (m: string, e?: object) => void) {
    const run = async (what: string, f: () => Promise<unknown>) => {
      try {
        await f();
      } catch (e) {
        warn(`storico metriche: raccolta ${what} non riuscita`, { err: (e as Error).message });
      }
    };
    const tick = async () => {
      await run('host', () => this.collectHost());
      await run('container', () => this.collectContainers());
      await run('dischi', () => this.collectDisks());
    };
    this.purge();
    setTimeout(() => void tick(), 5000).unref();
    setInterval(() => void tick(), MIN).unref();
    setInterval(() => this.purge(), 6 * HOUR).unref();
  }

  host(range: Range) {
    const { ms, bucket: b } = RANGES[range];
    const to = this.now();
    const from = to - ms;
    // b viene da RANGES (costante intera), non dall'input: sicuro da inserire nella query.
    const rows = this.db
      .prepare(
        `SELECT (t / ${b}) * ${b} AS bt, AVG(cpu) AS cpu, MAX(cpu_max) AS cpuMax, AVG(mem) AS mem, AVG(rx) AS rx, AVG(tx) AS tx, AVG(temp) AS temp
         FROM metrics_host WHERE t >= ? GROUP BY bt`,
      )
      .all(from) as { bt: number; cpu: number; cpuMax: number; mem: number; rx: number; tx: number; temp: number | null }[];
    const by = new Map(rows.map((r) => [r.bt, r]));
    const times = grid(from, to, b);
    const col = (k: 'cpu' | 'cpuMax' | 'mem' | 'rx' | 'tx' | 'temp', round: (n: number) => number) =>
      times.map((t) => {
        const v = by.get(t)?.[k];
        return v === undefined || v === null ? null : round(v);
      });
    const oldest = (this.db.prepare('SELECT MIN(t) AS t FROM metrics_host').get() as { t: number | null }).t;
    return {
      range,
      bucketMs: b,
      since: oldest,
      times,
      cpu: col('cpu', r1),
      cpuMax: col('cpuMax', r1),
      mem: col('mem', r1),
      rx: col('rx', Math.round),
      tx: col('tx', Math.round),
      temp: col('temp', r1),
    };
  }

  containers(range: Range, metric: 'cpu' | 'mem', top: number) {
    const b = Math.max(RANGES[range].bucket, C_BUCKET);
    const to = this.now();
    const from = to - RANGES[range].ms;
    const ranking = (
      this.db
        .prepare(
          `SELECT name, SUM(cpu_sum) / SUM(n) AS cpuAvg, MAX(cpu_sum / n) AS cpuPeak, SUM(mem_sum) / SUM(n) AS memAvg, MAX(mem_max) AS memMax,
           MAX(t) AS lastSeen FROM metrics_container WHERE t >= ? GROUP BY name`,
        )
        .all(from) as { name: string; cpuAvg: number; cpuPeak: number; memAvg: number; memMax: number; lastSeen: number }[]
    )
      .map((r) => ({ ...r, cpuAvg: r1(r.cpuAvg), cpuPeak: r1(r.cpuPeak), memAvg: Math.round(r.memAvg) }))
      .sort((a, b2) => (metric === 'cpu' ? b2.cpuAvg - a.cpuAvg : b2.memAvg - a.memAvg));
    const names = ranking.slice(0, top).map((r) => r.name);
    const times = grid(from, to, b);
    const series = names.map((name) => {
      const rows = this.db
        .prepare(
          `SELECT (t / ${b}) * ${b} AS bt, SUM(cpu_sum) / SUM(n) AS cpu, SUM(mem_sum) / SUM(n) AS mem
           FROM metrics_container WHERE name = ? AND t >= ? GROUP BY bt`,
        )
        .all(name, from) as { bt: number; cpu: number; mem: number }[];
      const by = new Map(rows.map((r) => [r.bt, metric === 'cpu' ? r1(r.cpu) : Math.round(r.mem)]));
      return { name, values: times.map((t) => by.get(t) ?? null) };
    });
    return { range, metric, bucketMs: b, times, series, ranking };
  }

  disks() {
    const to = this.now();
    const labels = (this.db.prepare('SELECT DISTINCT label FROM metrics_disk WHERE t >= ?').all(to - 2 * HOUR) as { label: string }[]).map((r) => r.label);
    return labels.map((label) => {
      const points = this.db
        .prepare('SELECT t, used, free, total FROM metrics_disk WHERE label = ? AND t >= ? ORDER BY t')
        .all(label, to - 30 * DAY) as DiskPoint[];
      const recent = points.filter((p) => p.t >= to - 14 * DAY);
      return { label, points, forecast: forecastDisk(recent) };
    });
  }
}

const rangeQ = z.object({ range: z.enum(['1h', '24h', '7d', '30d']).default('24h') });

export function registerMetrics(app: FastifyInstance, m: Metrics, viewer: object) {
  app.get('/api/v1/metrics/host', viewer, async (req) => m.host(rangeQ.parse(req.query).range));
  app.get('/api/v1/metrics/containers', viewer, async (req) => {
    const q = rangeQ
      .extend({ metric: z.enum(['cpu', 'mem']).default('cpu'), top: z.coerce.number().int().min(1).max(10).default(5) })
      .parse(req.query);
    return m.containers(q.range, q.metric, q.top);
  });
  app.get('/api/v1/metrics/disks', viewer, async () => m.disks());
}
