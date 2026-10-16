// Stato dei servizi systemd in SOLA LETTURA, senza D-Bus (bloccato da AppArmor nel container, vedi D-020/D-021):
//  - in esecuzione, memoria, processi, CPU: cgroup v2 dell'host (/sys/fs/cgroup/system.slice, montato ro)
//  - descrizione, avvio automatico: file delle unità (montati ro)
//  - in errore, ultimo esito, log: journal persistente dell'host (montato ro) tramite journalctl
import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { redactLine } from './redact.js';

const CGROUP = process.env.GIGI_HOST_CGROUP ?? '/host/cgroup/system.slice';
const JOURNAL = process.env.GIGI_JOURNAL_DIR ?? '/var/log/journal';
const UNIT_DIRS = (process.env.GIGI_UNIT_DIRS ?? '/host/units/etc,/host/units/run,/host/units/lib').split(',');
const NAME = /^[a-zA-Z0-9@._:\\-]{1,200}\.service$/;

const ID = {
  failedResult: 'd9b373ed55a64feb8242e02dbe79a49c',
  jobDone: '39f53479d3a045ac8e11786248231fbf',
  jobFailed: 'be02cf6855d2428ba40df7e9d022f03d',
  deactivated: '7ad2d189f7e94e70a38c781354912448',
};

function journalctl(args: string[], maxBuffer = 16 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('journalctl', [`--directory=${JOURNAL}`, '--no-pager', ...args], { timeout: 20_000, maxBuffer }, (err, out, errOut) => {
      if (err && !out) reject(Object.assign(new Error(`journal non leggibile: ${(errOut || err.message).slice(0, 200)}`), { status: 503 }));
      else resolve(out);
    });
  });
}

const parseJson = (out: string) =>
  out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, string>;
      } catch {
        return null;
      }
    })
    .filter((x): x is Record<string, string> => !!x);

async function running(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string, depth: number) => {
    let ents;
    try {
      ents = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      if (e.name.endsWith('.service')) {
        const ev = await readFile(path.join(p, 'cgroup.events'), 'utf8').catch(() => '');
        if (/populated 1/.test(ev)) out.set(e.name, p);
      } else if (e.name.endsWith('.slice') && depth < 2) await walk(p, depth + 1);
    }
  };
  await walk(CGROUP, 0);
  return out;
}

async function unitFile(name: string): Promise<{ path: string; description: string } | null> {
  const tpl = name.includes('@') ? name.replace(/@[^.]*\.service$/, '@.service') : null;
  for (const dir of UNIT_DIRS) {
    for (const n of tpl ? [name, tpl] : [name]) {
      const p = path.join(dir, n);
      try {
        const txt = await readFile(p, 'utf8');
        const inst = name.match(/@([^.]*)\.service$/)?.[1] ?? '';
        const description = (/^Description=(.*)$/m.exec(txt)?.[1] ?? '').replace(/%i|%I/g, inst).trim();
        return { path: p.replace(/^\/host\/units\/(etc|run|lib)/, (_m, x) => ({ etc: '/etc/systemd/system', run: '/run/systemd/generator', lib: '/usr/lib/systemd/system' })[x as 'etc']), description };
      } catch {}
    }
  }
  return null;
}

async function enabledSet(): Promise<Set<string>> {
  const s = new Set<string>();
  const base = UNIT_DIRS[0];
  try {
    for (const d of await readdir(base)) {
      if (!d.endsWith('.wants')) continue;
      for (const f of await readdir(path.join(base, d)).catch(() => [] as string[])) if (f.endsWith('.service')) s.add(f);
    }
  } catch {}
  return s;
}

type LastEvent = { state: 'failed' | 'ok'; ts: number; message: string };
let eventsCache: { t: number; map: Map<string, LastEvent> } | null = null;

/** Ultimo esito noto per unità negli ultimi 7 giorni, dagli eventi del PID 1 (systemd). */
async function lastEvents(): Promise<Map<string, LastEvent>> {
  if (eventsCache && Date.now() - eventsCache.t < 30_000) return eventsCache.map;
  const out = await journalctl([
    '_PID=1',
    `MESSAGE_ID=${ID.failedResult}`,
    `MESSAGE_ID=${ID.jobDone}`,
    `MESSAGE_ID=${ID.jobFailed}`,
    `MESSAGE_ID=${ID.deactivated}`,
    '--since=-7d',
    '-o',
    'json',
    '--output-fields=UNIT,MESSAGE_ID,MESSAGE,JOB_RESULT',
  ]);
  const map = new Map<string, LastEvent>();
  for (const e of parseJson(out)) {
    const unit = e.UNIT;
    if (!unit || !unit.endsWith('.service')) continue;
    const ts = Number(e.__REALTIME_TIMESTAMP) / 1000;
    const failed = e.MESSAGE_ID === ID.failedResult || (e.MESSAGE_ID === ID.jobFailed && e.JOB_RESULT !== 'done');
    const okEv = (e.MESSAGE_ID === ID.jobDone && e.JOB_RESULT === 'done') || e.MESSAGE_ID === ID.deactivated;
    if (!failed && !okEv) continue;
    const prev = map.get(unit);
    if (!prev || ts >= prev.ts) map.set(unit, { state: failed ? 'failed' : 'ok', ts, message: String(e.MESSAGE ?? '').slice(0, 300) });
  }
  eventsCache = { t: Date.now(), map };
  return map;
}

export async function listServices() {
  const [run, events, enabled] = await Promise.all([running(), lastEvents().catch(() => new Map<string, LastEvent>()), enabledSet()]);
  const names = new Set<string>([...run.keys(), ...events.keys(), ...enabled]);
  const rows = await Promise.all(
    [...names].map(async (name) => {
      const uf = await unitFile(name);
      const ev = events.get(name);
      const isRunning = run.has(name);
      const failed = !isRunning && ev?.state === 'failed';
      return {
        name,
        description: uf?.description ?? '',
        load: uf ? 'loaded' : 'not-found',
        active: isRunning ? 'active' : failed ? 'failed' : 'inactive',
        sub: isRunning ? 'running' : failed ? 'failed' : 'dead',
        enabled: enabled.has(name),
      };
    }),
  );
  return rows.sort((a, b) => (a.active === 'failed' ? -1 : 0) - (b.active === 'failed' ? -1 : 0) || a.name.localeCompare(b.name));
}

const num = async (f: string) => {
  const v = (await readFile(f, 'utf8').catch(() => '')).trim();
  return v && /^\d+$/.test(v) ? Number(v) : null;
};

export async function serviceDetail(name: string) {
  if (!NAME.test(name)) throw Object.assign(new Error('Nome servizio non valido'), { status: 400 });
  const [run, events, enabled, uf] = await Promise.all([running(), lastEvents().catch(() => new Map<string, LastEvent>()), enabledSet(), unitFile(name)]);
  const cg = run.get(name);
  const ev = events.get(name) ?? null;
  let pid: number | null = null;
  let cpuUsec: number | null = null;
  let since: number | null = null;
  if (cg) {
    pid = Number((await readFile(path.join(cg, 'cgroup.procs'), 'utf8').catch(() => '')).split('\n')[0]) || null;
    cpuUsec = Number(/usage_usec (\d+)/.exec(await readFile(path.join(cg, 'cpu.stat'), 'utf8').catch(() => ''))?.[1] ?? NaN) || null;
    since = (await stat(cg).catch(() => null))?.birthtimeMs || (await stat(cg).catch(() => null))?.ctimeMs || null;
  }
  if (!cg && !uf && !ev) throw Object.assign(new Error('Servizio non trovato'), { status: 404 });
  return {
    name,
    description: uf?.description ?? '',
    load: uf ? 'loaded' : 'not-found',
    active: cg ? 'active' : ev?.state === 'failed' ? 'failed' : 'inactive',
    sub: cg ? 'running' : ev?.state === 'failed' ? 'failed' : 'dead',
    unitFileState: enabled.has(name) ? 'enabled' : uf ? 'static/disabled' : '—',
    fragment: uf?.path ?? '',
    since,
    lastEvent: ev ? { state: ev.state, ts: ev.ts, message: ev.message } : null,
    mainPid: pid,
    memory: cg ? await num(path.join(cg, 'memory.current')) : null,
    cpuNs: cpuUsec !== null ? cpuUsec * 1000 : null,
    tasks: cg ? await num(path.join(cg, 'pids.current')) : null,
    canControl: false,
  };
}

const PRIO = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];

function toLines(out: string) {
  return parseJson(out).map((e) => ({
    ts: Number(e.__REALTIME_TIMESTAMP) / 1000,
    priority: PRIO[Number(e.PRIORITY ?? 6)] ?? 'info',
    unit: e._SYSTEMD_UNIT ?? e.UNIT ?? null,
    ident: e.SYSLOG_IDENTIFIER ?? e._COMM ?? null,
    pid: e._PID ? Number(e._PID) : null,
    message: redactLine(typeof e.MESSAGE === 'string' ? e.MESSAGE.slice(0, 4000) : '[messaggio binario]'),
  }));
}

/** Log di un servizio: messaggi del processo e di systemd riguardo l'unità. */
export async function serviceJournal(name: string, lines: number) {
  if (!NAME.test(name)) throw Object.assign(new Error('Nome servizio non valido'), { status: 400 });
  const n = Math.min(Math.max(lines, 10), 1000);
  const out = await journalctl(['-u', name, '-n', String(n), '-o', 'json', '--output-fields=MESSAGE,PRIORITY,_PID,SYSLOG_IDENTIFIER,_COMM,_SYSTEMD_UNIT,UNIT']);
  return toLines(out);
}

/** Errori di sistema recenti (priorità ≤ err) di tutto l'host. */
export async function systemErrors(hours: number) {
  const h = Math.min(Math.max(hours, 1), 168);
  const out = await journalctl(['-p', '0..3', `--since=-${h}h`, '-n', '300', '-o', 'json', '--output-fields=MESSAGE,PRIORITY,_PID,SYSLOG_IDENTIFIER,_COMM,_SYSTEMD_UNIT,UNIT']);
  return toLines(out).reverse();
}

/**
 * Pacchetti bloccati da UFW (righe "[UFW BLOCK]" del kernel nel journal), aggregati.
 * Sola lettura: le regole del firewall non sono leggibili senza root, i blocchi sì.
 */
export async function firewallBlocked(hours: number) {
  const h = Math.min(Math.max(Math.round(hours), 1), 168);
  const out = await journalctl(['-k', `--since=-${h}h`, '--grep', 'UFW BLOCK', '-r', '-n', '20000', '-q', '-o', 'json', '--output-fields=MESSAGE'], 64 * 1024 * 1024);
  const field = (msg: string, k: string) => new RegExp(`(?:^|\\s)${k}=(\\S*)`).exec(msg)?.[1] ?? '';
  const bySource = new Map<string, { src: string; count: number; ports: Set<string>; last: number; iface: string }>();
  const byPort = new Map<string, { port: string; count: number; sources: Set<string> }>();
  const recent: { t: number; src: string; dst: string; proto: string; dport: string; iface: string }[] = [];
  let total = 0;
  for (const e of parseJson(out)) {
    const msg = e.MESSAGE ?? '';
    const t = Math.round(Number(e.__REALTIME_TIMESTAMP) / 1000);
    const src = field(msg, 'SRC');
    const proto = field(msg, 'PROTO');
    const dport = field(msg, 'DPT');
    const iface = field(msg, 'IN');
    if (!src) continue;
    total++;
    const port = dport ? `${dport}/${proto.toLowerCase()}` : proto.toLowerCase();
    const s = bySource.get(src) ?? { src, count: 0, ports: new Set(), last: t, iface };
    s.count++;
    s.ports.add(port);
    bySource.set(src, s);
    const p = byPort.get(port) ?? { port, count: 0, sources: new Set() };
    p.count++;
    p.sources.add(src);
    byPort.set(port, p);
    if (recent.length < 100) recent.push({ t, src, dst: field(msg, 'DST'), proto, dport, iface });
  }
  return {
    hours: h,
    total,
    truncated: total >= 20000,
    sources: [...bySource.values()].sort((a, b) => b.count - a.count).slice(0, 30).map((s) => ({ ...s, ports: [...s.ports].slice(0, 10) })),
    ports: [...byPort.values()].sort((a, b) => b.count - a.count).slice(0, 30).map((p) => ({ port: p.port, count: p.count, sources: p.sources.size })),
    recent,
  };
}
