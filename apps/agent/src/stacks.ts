// Stack Docker Compose creati da GIGI OS (D-025).
// - Solo dentro le radici in GIGI_STACK_ROOTS, montate nell'agent con lo STESSO percorso dell'host:
//   così i percorsi relativi del compose (./data) arrivano al daemon come percorsi host corretti.
// - Uno stack è "gestito" solo se la sua cartella contiene .gigi-stack.json: le azioni (up/stop/down)
//   sono possibili solo su questi. Gli stack esistenti (jellyfin, armony, …) sono elencati in sola lettura.
// - docker-compose gira con argomenti fissi (nessuna shell) e un ambiente minimo: le variabili dell'agent
//   non finiscono nell'interpolazione del compose.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { docker } from './docker.js';
import { redactLine } from './redact.js';

export type Root = { label: string; path: string };
export const ROOTS: Root[] = (process.env.GIGI_STACK_ROOTS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const i = s.indexOf('=');
    return i > 0 ? { label: s.slice(0, i), path: path.resolve(s.slice(i + 1)) } : { label: path.basename(s), path: path.resolve(s) };
  });

const COMPOSE_BIN = process.env.GIGI_COMPOSE_BIN ?? 'docker-compose';
const MARKER = '.gigi-stack.json';
const COMPOSE_FILE = 'compose.yaml';
const PREV_FILE = 'compose.yaml.prev';
const ENV_FILE = '.env';
const MAX_OUTPUT = 256 * 1024;

export const PROJECT_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const SEG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

// Percorsi dell'host che un compose non dovrebbe montare senza un motivo preciso.
const OWN_STATE = ['/opt/gigi-os'];
const OTHER_SERVICES = ['/opt/docker', '/opt/homeassistant', '/home/gigi/armony'];
const SYSTEM_PATHS = ['/', '/etc', '/root', '/boot', '/usr', '/var', '/proc', '/sys', '/dev', '/home', '/opt', '/run', '/lib', '/bin', '/sbin'];
const DOCKER_SOCKETS = ['/var/run/docker.sock', '/run/docker.sock'];
const DANGEROUS_CAPS = new Set(['ALL', 'SYS_ADMIN', 'SYS_MODULE', 'SYS_PTRACE', 'SYS_RAWIO', 'NET_ADMIN', 'DAC_READ_SEARCH', 'SYS_BOOT']);

const fail = (status: number, msg: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(msg), { status, ...extra });
const under = (p: string, base: string) => p === base || p.startsWith(base === '/' ? '/' : `${base}/`);

export type Marker = { project: string; createdAt: number; updatedAt: number; createdBy: string | null; updatedBy: string | null };
export type Finding = { level: 'error' | 'danger' | 'warn' | 'info'; service?: string; message: string };

// ───────────── Percorsi ─────────────

export function findRoot(label: string) {
  const r = ROOTS.find((x) => x.label === label);
  if (!r) throw fail(400, 'Radice non consentita');
  return r;
}

/** Risolve root + percorso relativo senza seguire symlink e senza uscire dalla radice. */
export async function resolveDir(rootLabel: string, rel: string) {
  const root = findRoot(rootLabel);
  const segs = rel.split('/').filter(Boolean);
  if (segs.length === 0 || segs.length > 3) throw fail(400, 'Indica una sottocartella (massimo 3 livelli)');
  if (segs.some((s) => !SEG_RE.test(s))) throw fail(400, 'Nome cartella non valido: lettere, numeri, punto, trattino, underscore');
  let base: string;
  try {
    base = await realpath(root.path);
  } catch {
    throw fail(503, `La radice ${root.path} non esiste o non è montata nell'agent`);
  }
  if (base !== root.path) throw fail(500, `La radice ${root.path} è un collegamento simbolico: non supportato`);
  let cur = base;
  for (const s of segs) {
    cur = path.join(cur, s);
    try {
      const st = await lstat(cur);
      if (st.isSymbolicLink()) throw fail(400, `${cur} è un collegamento simbolico`);
      if (!st.isDirectory()) throw fail(400, `${cur} esiste e non è una cartella`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw e;
    }
  }
  return { root, dir: path.join(base, ...segs), rel: segs.join('/') };
}

async function exists(p: string) {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function readMarker(dir: string): Promise<Marker | null> {
  try {
    const st = await lstat(path.join(dir, MARKER));
    if (!st.isFile()) return null;
    const m = JSON.parse(await readFile(path.join(dir, MARKER), 'utf8')) as Marker;
    return PROJECT_RE.test(m.project) ? m : null;
  } catch {
    return null;
  }
}

async function writeAtomic(file: string, data: string, mode: number) {
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, data, { mode });
  await rename(tmp, file);
}

/** Cartelle di una radice, per scegliere la posizione nel wizard. */
export async function browse(rootLabel: string, rel: string) {
  const root = findRoot(rootLabel);
  const dir = rel ? (await resolveDir(rootLabel, rel)).dir : root.path;
  let entries: import('node:fs').Dirent[] = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const dirs = await Promise.all(
    entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .slice(0, 500)
      .map(async (e) => {
        const p = path.join(dir, e.name);
        const marker = await readMarker(p);
        let empty = false;
        try {
          empty = (await readdir(p)).length === 0;
        } catch {}
        return { name: e.name, stack: marker?.project ?? null, empty };
      }),
  );
  return { root: root.label, rootPath: root.path, rel, path: dir, dirs: dirs.sort((a, b) => a.name.localeCompare(b.name)) };
}

// ───────────── .env ─────────────

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    let v = line.slice(i + 1);
    if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1);
    else if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1).replace(/\\(["\\$])/g, '$1');
    if (ENV_KEY_RE.test(key)) out[key] = v;
  }
  return out;
}

export function serializeEnv(env: Record<string, string>): string {
  return (
    Object.entries(env)
      .map(([k, v]) => {
        if (!ENV_KEY_RE.test(k)) throw fail(400, `Nome variabile non valido: ${k}`);
        if (/[\r\n\0]/.test(v)) throw fail(400, `La variabile ${k} contiene un a capo`);
        // Apici singoli: valore letterale, nessuna interpolazione. Con un apice nel valore si usano i doppi apici.
        if (!v.includes("'")) return `${k}='${v}'`;
        return `${k}="${v.replace(/(["\\$])/g, '\\$1')}"`;
      })
      .join('\n') + '\n'
  );
}

/** Unisce i valori inviati con quelli già salvati: null = mantieni il valore attuale. */
function mergeEnv(current: Record<string, string>, input: Record<string, string | null> | undefined) {
  if (!input) return current;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === null) {
      if (k in current) out[k] = current[k];
    } else out[k] = v;
  }
  return out;
}

// ───────────── docker-compose ─────────────

function composeEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: '/tmp',
    DOCKER_CONFIG: '/tmp/.docker',
    DOCKER_HOST: `unix://${process.env.DOCKER_SOCKET ?? '/var/run/docker.sock'}`,
    COMPOSE_ANSI: 'never',
    NO_COLOR: '1',
  };
}

function runCompose(args: string[], opts: { input?: string; timeoutMs?: number; onOutput?: (s: string) => void } = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(COMPOSE_BIN, args, { env: composeEnv(), cwd: '/tmp', stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs ?? 60_000);
    child.stdout.on('data', (c: Buffer) => {
      const s = c.toString('utf8');
      if (stdout.length < MAX_OUTPUT * 4) stdout += s;
      opts.onOutput?.(s);
    });
    child.stderr.on('data', (c: Buffer) => {
      const s = c.toString('utf8');
      if (stderr.length < MAX_OUTPUT) stderr += s;
      opts.onOutput?.(s);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(fail(503, `docker-compose non disponibile nell'agent: ${(e as NodeJS.ErrnoException).code ?? e.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? (signal ? 124 : 1), stdout, stderr });
    });
    child.stdin.end(opts.input ?? '');
  });
}

const cleanError = (s: string) =>
  s
    .split('\n')
    .map((l) => redactLine(l.trim()))
    .filter(Boolean)
    .slice(-12)
    .join('\n');

// ───────────── Porte in ascolto sull'host (l'agent è in rete host) ─────────────

async function listeningPorts() {
  const out = new Set<string>();
  const read = async (file: string, proto: 'tcp' | 'udp', state: string) => {
    try {
      const lines = (await readFile(file, 'utf8')).split('\n').slice(1);
      for (const l of lines) {
        const cols = l.trim().split(/\s+/);
        if (cols.length < 4 || cols[3] !== state) continue;
        const port = parseInt(cols[1].split(':').pop() ?? '', 16);
        if (port) out.add(`${proto}/${port}`);
      }
    } catch {}
  };
  await Promise.all([
    read('/proc/net/tcp', 'tcp', '0A'),
    read('/proc/net/tcp6', 'tcp', '0A'),
    read('/proc/net/udp', 'udp', '07'),
    read('/proc/net/udp6', 'udp', '07'),
  ]);
  return out;
}

function expandPorts(published: string | number | undefined): number[] {
  if (published === undefined || published === '') return [];
  const [a, b] = String(published).split('-').map(Number);
  if (!Number.isInteger(a)) return [];
  if (!b) return [a];
  if (b < a || b - a > 1000) return [a];
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

// ───────────── Analisi ─────────────

type ComposeService = {
  image?: string;
  build?: unknown;
  container_name?: string;
  privileged?: boolean;
  network_mode?: string;
  pid?: string;
  ipc?: string;
  userns_mode?: string;
  cap_add?: string[];
  devices?: unknown[];
  security_opt?: string[];
  restart?: string;
  volumes?: { type: string; source?: string; target: string; read_only?: boolean }[];
  ports?: { published?: string | number; target: number; host_ip?: string; protocol?: string }[];
};
type ComposeConfig = { services?: Record<string, ComposeService>; volumes?: Record<string, { external?: boolean; name?: string }>; networks?: Record<string, { external?: boolean; name?: string }> };

export type PreflightInput = { root: string; path: string; project: string; compose: string; env?: Record<string, string | null> };

export async function preflight(input: PreflightInput) {
  const findings: Finding[] = [];
  const err = (message: string, service?: string) => findings.push({ level: 'error', message, service });
  if (!PROJECT_RE.test(input.project)) throw fail(400, 'Nome stack non valido: minuscole, numeri, - e _ (max 63)');
  if (!input.compose.trim()) throw fail(400, 'Il file compose è vuoto');
  if (input.compose.length > 200_000) throw fail(400, 'Il file compose supera 200 KB');

  const { root, dir, rel } = await resolveDir(input.root, input.path);
  const dirExists = await exists(dir);
  const marker = dirExists ? await readMarker(dir) : null;
  if (dirExists && !marker) {
    const content = await readdir(dir);
    if (content.length) err(`La cartella ${dir} esiste già e non è uno stack di GIGI OS: scegli una cartella nuova o vuota`);
  }
  if (marker && marker.project !== input.project) err(`In ${dir} c'è già lo stack «${marker.project}»`);

  // Progetti compose già presenti sul daemon (anche quelli non creati da GIGI OS)
  const containers = await docker.listContainers({ all: true });
  const projectDirs = new Map<string, string>();
  for (const c of containers) {
    const p = c.Labels?.['com.docker.compose.project'];
    if (p) projectDirs.set(p, c.Labels?.['com.docker.compose.project.working_dir'] ?? '?');
  }
  const otherDir = projectDirs.get(input.project);
  if (otherDir && otherDir !== dir) err(`Esiste già uno stack Docker «${input.project}» in ${otherDir}: scegli un altro nome`);
  if (!otherDir) {
    const managed = await scanManaged();
    const twin = managed.find((m) => m.marker.project === input.project && m.dir !== dir);
    if (twin) err(`Lo stack «${input.project}» esiste già in ${twin.dir}`);
  }

  const currentEnv = marker ? await readEnvFile(dir) : {};
  const env = mergeEnv(currentEnv, input.env);
  const envText = serializeEnv(env);

  // Normalizzazione con docker-compose (stessa logica che userà `up`). .env temporaneo su tmpfs, 0600.
  const tmpEnv = `/tmp/gigi-env-${randomUUID()}`;
  await writeFile(tmpEnv, envText, { mode: 0o600 });
  let cfg: ComposeConfig | null = null;
  try {
    const r = await runCompose(['-p', input.project, '--project-directory', dir, '-f', '-', '--env-file', tmpEnv, 'config', '--format', 'json'], {
      input: input.compose,
      timeoutMs: 30_000,
    });
    if (r.code !== 0) err(`Compose non valido:\n${cleanError(r.stderr || r.stdout)}`);
    else cfg = JSON.parse(r.stdout) as ComposeConfig;
  } finally {
    await unlink(tmpEnv).catch(() => {});
  }

  const services: { name: string; image: string | null; build: boolean; ports: string[]; mounts: string[]; networkMode: string | null; restart: string | null }[] = [];
  if (cfg) {
    const svcs = Object.entries(cfg.services ?? {});
    if (svcs.length === 0) err('Il compose non definisce alcun servizio');
    const listening = await listeningPorts();
    // Porte già pubblicate da container di questo stesso progetto (aggiornamento): non sono conflitti
    const own = new Set<string>();
    for (const c of containers) {
      if (c.Labels?.['com.docker.compose.project'] !== input.project) continue;
      for (const p of c.Ports ?? []) if (p.PublicPort) own.add(`${p.Type}/${p.PublicPort}`);
    }
    const usedNames = new Map(containers.map((c) => [(c.Names[0] ?? '').replace(/^\//, ''), c.Labels?.['com.docker.compose.project'] ?? null]));
    const claimed = new Set<string>();

    for (const [name, s] of svcs) {
      const w = (level: Finding['level'], message: string) => findings.push({ level, message, service: name });
      if (!s.image && !s.build) w('error', 'Manca «image»');
      if (s.build)
        w('warn', 'Build sul mini PC con il builder classico (buildx non presente): il Dockerfile deve già trovarsi nella cartella dello stack, «dockerfile_inline» e le funzioni solo BuildKit non sono supportate');
      if (s.container_name) {
        const owner = usedNames.get(s.container_name);
        if (usedNames.has(s.container_name) && owner !== input.project) w('error', `Il nome container «${s.container_name}» è già usato da un altro container`);
      }
      if (s.privileged) w('danger', 'privileged: il container ha accesso completo all’host');
      if (s.network_mode === 'host') w('warn', 'Rete host: nessun isolamento di rete, le porte del servizio si aprono direttamente sull’host');
      if (s.pid === 'host') w('danger', 'pid: host — vede e può segnalare tutti i processi dell’host');
      if (s.ipc === 'host') w('warn', 'ipc: host — memoria condivisa con l’host');
      if (s.userns_mode === 'host') w('warn', 'userns_mode: host');
      for (const cap of s.cap_add ?? []) {
        const c = cap.toUpperCase().replace(/^CAP_/, '');
        w(DANGEROUS_CAPS.has(c) ? 'danger' : 'warn', `Capability aggiunta: ${c}`);
      }
      if (s.devices?.length) w('warn', `Accesso a dispositivi dell’host (${s.devices.length})`);
      for (const so of s.security_opt ?? []) if (/unconfined/.test(so)) w('danger', `security_opt ${so}: protezioni del kernel disattivate`);
      if (!s.restart || s.restart === 'no') w('info', 'Nessuna policy di riavvio: dopo un reboot il servizio resterà fermo');

      const mounts: string[] = [];
      for (const v of s.volumes ?? []) {
        const ro = !!v.read_only;
        mounts.push(`${v.type === 'bind' ? v.source : v.type === 'volume' ? `volume:${v.source ?? '(anonimo)'}` : v.type} → ${v.target}${ro ? ' (ro)' : ''}`);
        if (v.type !== 'bind' || !v.source) continue;
        const src = path.resolve(v.source);
        if (under(src, dir)) continue;
        if (DOCKER_SOCKETS.includes(src)) w('danger', `Monta il socket Docker (${src}): equivale ad accesso root all’host`);
        else if (OWN_STATE.some((p) => under(src, p))) w('error', `Non è consentito montare lo stato di GIGI OS (${src})`);
        else if (OTHER_SERVICES.some((p) => under(src, p))) w('danger', `Monta la cartella di un altro servizio (${src})${ro ? '' : ' in scrittura'}`);
        else if (SYSTEM_PATHS.some((p) => src === p) || ['/etc', '/root', '/boot', '/proc', '/sys', '/dev'].some((p) => under(src, p)))
          w(ro ? 'warn' : 'danger', `Monta una cartella di sistema (${src})${ro ? ' in sola lettura' : ' in scrittura'}`);
        else if (under(src, '/srv') && !ro) w('warn', `Scrittura su ${src} (media/download): verifica che sia voluto`);
        else w('info', `Cartella dell’host ${src}${ro ? ' (sola lettura)' : ''}: se non esiste Docker la crea con proprietario root`);
      }

      const ports: string[] = [];
      for (const p of s.ports ?? []) {
        const proto = p.protocol ?? 'tcp';
        const ip = p.host_ip ?? '';
        ports.push(`${ip ? `${ip}:` : ''}${p.published ?? '(casuale)'}→${p.target}/${proto}`);
        if (!p.published) continue;
        if (!ip || ip === '0.0.0.0' || ip === '::')
          w('warn', `Porta ${p.published}/${proto} su tutte le interfacce: le porte pubblicate da Docker scavalcano UFW (usa 192.168.222.200:${p.published}:… per la sola LAN)`);
        for (const port of expandPorts(p.published)) {
          const key = `${proto}/${port}`;
          if (claimed.has(key)) w('error', `Porta ${port}/${proto} dichiarata due volte nello stack`);
          claimed.add(key);
          if (listening.has(key) && !own.has(key)) w('error', `Porta ${port}/${proto} già in uso sull’host`);
        }
      }
      services.push({
        name,
        image: s.image ?? null,
        build: !!s.build,
        ports,
        mounts,
        networkMode: s.network_mode ?? null,
        restart: s.restart ?? null,
      });
    }
    for (const [k, v] of Object.entries(cfg.networks ?? {})) if (v.external) findings.push({ level: 'info', message: `Usa la rete esistente «${v.name ?? k}»` });
    for (const [k, v] of Object.entries(cfg.volumes ?? {})) if (v.external) findings.push({ level: 'info', message: `Usa il volume esistente «${v.name ?? k}»` });
  }

  const order = { error: 0, danger: 1, warn: 2, info: 3 };
  findings.sort((a, b) => order[a.level] - order[b.level]);
  return {
    ok: !findings.some((f) => f.level === 'error'),
    needsConfirm: findings.some((f) => f.level === 'danger' || f.level === 'warn'),
    root: root.label,
    rel,
    dir,
    project: input.project,
    update: !!marker,
    services,
    findings,
    envKeys: Object.keys(env),
  };
}

async function readEnvFile(dir: string) {
  try {
    return parseEnv(await readFile(path.join(dir, ENV_FILE), 'utf8'));
  } catch {
    return {};
  }
}

// ───────────── Stack gestiti ─────────────

async function scanManaged() {
  const found: { root: Root; rel: string; dir: string; marker: Marker }[] = [];
  const walk = async (root: Root, dir: string, depth: number) => {
    const marker = await readMarker(dir);
    if (marker && depth > 0) {
      found.push({ root, rel: path.relative(root.path, dir), dir, marker });
      return;
    }
    if (depth >= 3) return;
    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.slice(0, 500)) if (e.isDirectory() && !e.name.startsWith('.')) await walk(root, path.join(dir, e.name), depth + 1);
  };
  for (const r of ROOTS) await walk(r, r.path, 0);
  return found;
}

async function findManaged(project: string) {
  if (!PROJECT_RE.test(project)) throw fail(400, 'Nome stack non valido');
  const m = (await scanManaged()).find((x) => x.marker.project === project);
  if (!m) throw fail(404, `Lo stack «${project}» non è gestito da GIGI OS`);
  return m;
}

export async function listStacks() {
  const [managed, containers] = await Promise.all([scanManaged(), docker.listContainers({ all: true })]);
  const byProject = new Map<string, { dir: string | null; containers: { name: string; service: string | null; state: string; status: string; image: string }[] }>();
  for (const c of containers) {
    const p = c.Labels?.['com.docker.compose.project'];
    if (!p) continue;
    const e = byProject.get(p) ?? { dir: c.Labels?.['com.docker.compose.project.working_dir'] ?? null, containers: [] };
    e.containers.push({ name: (c.Names[0] ?? '').replace(/^\//, ''), service: c.Labels?.['com.docker.compose.service'] ?? null, state: c.State, status: c.Status, image: c.Image });
    byProject.set(p, e);
  }
  const out = managed.map((m) => {
    const e = byProject.get(m.marker.project);
    byProject.delete(m.marker.project);
    return {
      project: m.marker.project,
      managed: true,
      root: m.root.label,
      rel: m.rel,
      dir: m.dir,
      createdAt: m.marker.createdAt,
      updatedAt: m.marker.updatedAt,
      createdBy: m.marker.createdBy,
      containers: e?.containers ?? [],
    };
  });
  for (const [project, e] of byProject)
    out.push({ project, managed: false, root: '', rel: '', dir: e.dir ?? '', createdAt: 0, updatedAt: 0, createdBy: null, containers: e.containers });
  return out.sort((a, b) => Number(b.managed) - Number(a.managed) || a.project.localeCompare(b.project));
}

export async function getStack(project: string) {
  const m = await findManaged(project);
  const compose = await readFile(path.join(m.dir, COMPOSE_FILE), 'utf8').catch(() => '');
  const env = await readEnvFile(m.dir);
  return {
    project,
    root: m.root.label,
    rel: m.rel,
    dir: m.dir,
    marker: m.marker,
    compose,
    // I valori del .env non lasciano mai l'agent: solo i nomi.
    envKeys: Object.keys(env),
    hasPrevious: await exists(path.join(m.dir, PREV_FILE)),
  };
}

// ───────────── Job (operazioni lunghe: pull, up, down) ─────────────

type Job = { id: string; project: string; action: string; status: 'running' | 'ok' | 'error'; startedAt: number; endedAt: number | null; exitCode: number | null; output: string };
const jobs = new Map<string, Job>();
const busy = new Set<string>();

function startJob(project: string, action: string, steps: (job: Job) => Promise<number>) {
  if (busy.has(project)) throw fail(409, `C'è già un'operazione in corso sullo stack «${project}»`);
  busy.add(project);
  const job: Job = { id: randomUUID(), project, action, status: 'running', startedAt: Date.now(), endedAt: null, exitCode: null, output: '' };
  jobs.set(job.id, job);
  if (jobs.size > 30) jobs.delete(jobs.keys().next().value as string);
  void steps(job)
    .then((code) => {
      job.exitCode = code;
      job.status = code === 0 ? 'ok' : 'error';
    })
    .catch((e) => {
      job.output += `\n${(e as Error).message}\n`;
      job.status = 'error';
    })
    .finally(() => {
      job.endedAt = Date.now();
      busy.delete(project);
    });
  return job;
}

export function getJob(id: string) {
  const j = jobs.get(id);
  if (!j) throw fail(404, 'Operazione non trovata');
  return { ...j, output: j.output.split('\n').map(redactLine).join('\n') };
}

const composeArgs = (project: string, dir: string) => ['-p', project, '--project-directory', dir, '-f', path.join(dir, COMPOSE_FILE), '--ansi', 'never', '--progress', 'plain'];

async function composeStep(job: Job, args: string[], timeoutMs = 20 * 60_000) {
  let last = '';
  let partial = '';
  const say = (s: string) => (job.output = (job.output + s).slice(-MAX_OUTPUT));
  // --progress plain ripete alcune righe: si scartano i duplicati consecutivi
  const onOutput = (chunk: string) => {
    const lines = (partial + chunk).split('\n');
    partial = lines.pop() ?? '';
    for (const l of lines) if (l.trim() && l !== last) say(`${(last = l)}\n`);
  };
  say(`$ docker compose ${args.slice(args.indexOf('plain') + 1).join(' ')}\n`);
  const r = await runCompose(args, { timeoutMs, onOutput });
  if (partial.trim()) say(`${partial}\n`);
  if (r.code === 124) say('\nTempo massimo superato: operazione interrotta\n');
  else if (r.code !== 0) say(`\nTerminato con codice ${r.code}\n`);
  return r.code;
}

export type DeployInput = PreflightInput & { pull?: 'missing' | 'always'; user?: string | null };

/** Scrive i file (con copia del compose precedente) e avvia `up -d` come job. Ripete l'analisi lato agent. */
export async function deploy(input: DeployInput) {
  const pf = await preflight(input);
  if (!pf.ok) throw fail(409, 'Il compose ha errori bloccanti', { findings: pf.findings });
  if (busy.has(input.project)) throw fail(409, `C'è già un'operazione in corso sullo stack «${input.project}»`);
  const dir = pf.dir;
  await mkdir(dir, { recursive: true, mode: 0o755 });
  const prev = await readMarker(dir);
  const currentEnv = prev ? await readEnvFile(dir) : {};
  const env = mergeEnv(currentEnv, input.env);
  const composePath = path.join(dir, COMPOSE_FILE);
  if (prev && (await exists(composePath))) await writeAtomic(path.join(dir, PREV_FILE), await readFile(composePath, 'utf8'), 0o644);
  await writeAtomic(composePath, input.compose.endsWith('\n') ? input.compose : `${input.compose}\n`, 0o644);
  if (Object.keys(env).length || (await exists(path.join(dir, ENV_FILE)))) await writeAtomic(path.join(dir, ENV_FILE), serializeEnv(env), 0o600);
  const now = Date.now();
  const marker: Marker = {
    project: input.project,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
    createdBy: prev?.createdBy ?? input.user ?? null,
    updatedBy: input.user ?? null,
  };
  await writeAtomic(path.join(dir, MARKER), JSON.stringify(marker, null, 2) + '\n', 0o644);
  const pull = input.pull === 'always' ? 'always' : 'missing';
  const job = startJob(input.project, prev ? 'update' : 'create', (j) =>
    composeStep(j, [...composeArgs(input.project, dir), 'up', '-d', '--remove-orphans', '--pull', pull]),
  );
  return { job: getJob(job.id), preflight: pf };
}

export type StackAction = 'up' | 'stop' | 'restart' | 'pull' | 'down' | 'remove' | 'rollback';

export async function stackAction(project: string, action: StackAction, opts: { removeVolumes?: boolean } = {}) {
  const m = await findManaged(project);
  const base = composeArgs(project, m.dir);
  const v = opts.removeVolumes ? ['-v'] : [];
  if (action === 'rollback' && !(await exists(path.join(m.dir, PREV_FILE)))) throw fail(409, 'Nessuna versione precedente del compose');
  const job = startJob(project, action, async (j) => {
    switch (action) {
      case 'up':
        return composeStep(j, [...base, 'up', '-d', '--remove-orphans']);
      case 'stop':
        return composeStep(j, [...base, 'stop']);
      case 'restart':
        return composeStep(j, [...base, 'restart']);
      case 'pull': {
        const c = await composeStep(j, [...base, 'pull']);
        return c !== 0 ? c : composeStep(j, [...base, 'up', '-d', '--remove-orphans']);
      }
      case 'down':
        return composeStep(j, [...base, 'down', '--remove-orphans', ...v]);
      case 'rollback': {
        // Scambia compose.yaml e compose.yaml.prev, poi riapplica
        const cur = await readFile(path.join(m.dir, COMPOSE_FILE), 'utf8');
        const prev = await readFile(path.join(m.dir, PREV_FILE), 'utf8');
        await writeAtomic(path.join(m.dir, COMPOSE_FILE), prev, 0o644);
        await writeAtomic(path.join(m.dir, PREV_FILE), cur, 0o644);
        j.output += 'Ripristinata la versione precedente del compose\n';
        return composeStep(j, [...base, 'up', '-d', '--remove-orphans']);
      }
      case 'remove': {
        const c = await composeStep(j, [...base, 'down', '--remove-orphans', ...v]);
        if (c !== 0) return c;
        // Rimuove SOLO i file creati da GIGI OS; i dati dell'app (es. ./data) restano dove sono.
        for (const f of [COMPOSE_FILE, PREV_FILE, ENV_FILE, MARKER]) await unlink(path.join(m.dir, f)).catch(() => {});
        try {
          await rmdir(m.dir);
          j.output += `Cartella ${m.dir} rimossa (era vuota)\n`;
        } catch {
          j.output += `I dati in ${m.dir} sono stati conservati: eliminali a mano se non servono più\n`;
        }
        return 0;
      }
    }
  });
  return getJob(job.id);
}
