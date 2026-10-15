// Metriche host lette direttamente da /proc e /sys (nessuna dipendenza esterna).
// Il container agent gira con network_mode: host, quindi /proc/net/dev riflette le interfacce dell'host;
// /proc/stat, /proc/meminfo, /proc/loadavg e /proc/uptime sono comunque globali all'host.
import { readFile, readdir, statfs } from 'node:fs/promises';
import os from 'node:os';

const PROC = process.env.GIGI_PROC ?? '/proc';
const SYS = process.env.GIGI_SYS ?? '/sys';
const OS_RELEASE = process.env.GIGI_OS_RELEASE ?? '/host/os-release';
const HOSTNAME_FILE = process.env.GIGI_HOSTNAME_FILE ?? '/host/hostname';

// GIGI_DISKS="Sistema (/)=/host/srv,Altro=/host/altro"
const DISKS = (process.env.GIGI_DISKS ?? 'Sistema=/')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const i = s.lastIndexOf('=');
    return { label: s.slice(0, i), path: s.slice(i + 1) };
  });

const IGNORED_IF = /^(lo|docker\d*|br-|veth|virbr|tun|tap|wg|tailscale|zt)/;

type CpuTimes = { idle: number; total: number };

async function readCpuTimes(): Promise<CpuTimes[]> {
  const text = await readFile(`${PROC}/stat`, 'utf8');
  return text
    .split('\n')
    .filter((l) => /^cpu\d* /.test(l))
    .map((l) => {
      const v = l.trim().split(/\s+/).slice(1).map(Number);
      const idle = v[3] + (v[4] ?? 0);
      const total = v.slice(0, 8).reduce((a, b) => a + b, 0);
      return { idle, total };
    });
}

async function readMem() {
  const text = await readFile(`${PROC}/meminfo`, 'utf8');
  const m: Record<string, number> = {};
  for (const line of text.split('\n')) {
    const r = /^(\w+):\s+(\d+)/.exec(line);
    if (r) m[r[1]] = Number(r[2]) * 1024;
  }
  return {
    total: m.MemTotal,
    available: m.MemAvailable,
    used: m.MemTotal - m.MemAvailable,
    cached: (m.Cached ?? 0) + (m.Buffers ?? 0),
    swapTotal: m.SwapTotal ?? 0,
    swapUsed: (m.SwapTotal ?? 0) - (m.SwapFree ?? 0),
  };
}

async function readNet() {
  const text = await readFile(`${PROC}/net/dev`, 'utf8');
  return text
    .split('\n')
    .slice(2)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [name, rest] = l.split(':');
      const v = rest.trim().split(/\s+/).map(Number);
      return { name: name.trim(), rx: v[0], tx: v[8] };
    })
    .filter((i) => !IGNORED_IF.test(i.name));
}

async function readOperstate(name: string): Promise<string> {
  try {
    return (await readFile(`${SYS}/class/net/${name}/operstate`, 'utf8')).trim();
  } catch {
    return 'unknown';
  }
}

async function readTemps() {
  const out: { sensor: string; label: string; celsius: number; high?: number; crit?: number }[] = [];
  let dirs: string[] = [];
  try {
    dirs = await readdir(`${SYS}/class/hwmon`);
  } catch {
    return out;
  }
  for (const d of dirs) {
    const base = `${SYS}/class/hwmon/${d}`;
    let sensor = d;
    try {
      sensor = (await readFile(`${base}/name`, 'utf8')).trim();
    } catch {}
    let files: string[] = [];
    try {
      files = await readdir(base);
    } catch {
      continue;
    }
    for (const f of files.filter((f) => /^temp\d+_input$/.test(f))) {
      const n = f.replace('_input', '');
      const read = async (suffix: string) => {
        try {
          return Number((await readFile(`${base}/${n}_${suffix}`, 'utf8')).trim()) / 1000;
        } catch {
          return undefined;
        }
      };
      const celsius = await read('input');
      if (celsius === undefined || Number.isNaN(celsius)) continue;
      let label = n;
      try {
        label = (await readFile(`${base}/${n}_label`, 'utf8')).trim();
      } catch {}
      out.push({ sensor, label, celsius, high: await read('max'), crit: await read('crit') });
    }
  }
  return out;
}

async function readDisks() {
  return Promise.all(
    DISKS.map(async (d) => {
      try {
        const s = await statfs(d.path);
        const total = s.blocks * s.bsize;
        const free = s.bavail * s.bsize;
        return { label: d.label, total, free, used: total - s.bfree * s.bsize, ok: true };
      } catch {
        return { label: d.label, total: 0, free: 0, used: 0, ok: false };
      }
    }),
  );
}

async function readStatic() {
  let osName = 'Linux';
  try {
    const rel = await readFile(OS_RELEASE, 'utf8');
    osName = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(rel)?.[1] ?? osName;
  } catch {}
  let hostname = os.hostname();
  try {
    hostname = (await readFile(HOSTNAME_FILE, 'utf8')).trim() || hostname;
  } catch {}
  const cpuinfo = await readFile(`${PROC}/cpuinfo`, 'utf8').catch(() => '');
  const model = /^model name\s*:\s*(.+)$/m.exec(cpuinfo)?.[1] ?? os.cpus()[0]?.model ?? 'CPU';
  let gpu: string | null = null;
  try {
    const cards = await readdir('/dev/dri');
    if (cards.some((c) => c.startsWith('renderD'))) gpu = 'GPU con render node disponibile';
  } catch {}
  return { hostname, os: osName, kernel: os.release(), arch: os.arch(), cpuModel: model, gpu };
}

export type Sample = {
  t: number;
  cpu: number;
  mem: number;
  rx: number;
  tx: number;
  load1: number;
  temp: number | null;
};

const HISTORY_SIZE = Number(process.env.GIGI_HISTORY_POINTS ?? 720); // 720 × 5 s = 1 h
const INTERVAL = Number(process.env.GIGI_SAMPLE_MS ?? 5000);

let staticInfo: Awaited<ReturnType<typeof readStatic>> | null = null;
let prevCpu: CpuTimes[] | null = null;
let prevNet: { t: number; ifs: { name: string; rx: number; tx: number }[] } | null = null;
let latest: Record<string, unknown> | null = null;
const history: Sample[] = [];

function pct(prev: CpuTimes, cur: CpuTimes) {
  const dt = cur.total - prev.total;
  return dt > 0 ? Math.max(0, Math.min(100, (1 - (cur.idle - prev.idle) / dt) * 100)) : 0;
}

async function sample() {
  const now = Date.now();
  const [cpu, mem, net, temps, disks, load, uptime] = await Promise.all([
    readCpuTimes(),
    readMem(),
    readNet(),
    readTemps(),
    readDisks(),
    readFile(`${PROC}/loadavg`, 'utf8'),
    readFile(`${PROC}/uptime`, 'utf8'),
  ]);
  staticInfo ??= await readStatic();

  const cpuPct = prevCpu ? pct(prevCpu[0], cpu[0]) : 0;
  const perCore = prevCpu ? cpu.slice(1).map((c, i) => pct(prevCpu![i + 1], c)) : cpu.slice(1).map(() => 0);
  prevCpu = cpu;

  const dt = prevNet ? (now - prevNet.t) / 1000 : 0;
  const interfaces = await Promise.all(
    net.map(async (i) => {
      const p = prevNet?.ifs.find((x) => x.name === i.name);
      return {
        name: i.name,
        state: await readOperstate(i.name),
        rxBytes: i.rx,
        txBytes: i.tx,
        rxRate: p && dt > 0 ? Math.max(0, (i.rx - p.rx) / dt) : 0,
        txRate: p && dt > 0 ? Math.max(0, (i.tx - p.tx) / dt) : 0,
      };
    }),
  );
  prevNet = { t: now, ifs: net };

  const [l1, l5, l15] = load.split(' ').map(Number);
  const pkg =
    temps.find((t) => /package/i.test(t.label)) ?? temps.find((t) => t.sensor === 'coretemp') ?? temps[0] ?? null;

  latest = {
    t: now,
    ...staticInfo,
    uptime: Number(uptime.split(' ')[0]),
    load: [l1, l5, l15],
    cpu: { usage: cpuPct, cores: perCore.length, perCore },
    memory: mem,
    temps,
    cpuTemp: pkg?.celsius ?? null,
    disks,
    network: {
      interfaces,
      rxRate: interfaces.reduce((a, i) => a + i.rxRate, 0),
      txRate: interfaces.reduce((a, i) => a + i.txRate, 0),
    },
  };
  history.push({
    t: now,
    cpu: round(cpuPct),
    mem: round((mem.used / mem.total) * 100),
    rx: Math.round((latest.network as { rxRate: number }).rxRate),
    tx: Math.round((latest.network as { txRate: number }).txRate),
    load1: l1,
    temp: pkg?.celsius ?? null,
  });
  if (history.length > HISTORY_SIZE) history.splice(0, history.length - HISTORY_SIZE);
}

const round = (n: number) => Math.round(n * 10) / 10;

export function startSampler() {
  const tick = () => sample().catch((e) => console.error(JSON.stringify({ level: 'error', msg: 'sample failed', err: String(e) })));
  void tick();
  setInterval(tick, INTERVAL).unref();
}

export function getSnapshot() {
  return latest;
}

export function getHistory(sinceMs?: number) {
  return sinceMs ? history.filter((s) => s.t >= sinceMs) : history;
}
