// Client API: cookie di sessione HttpOnly + header CSRF per le mutazioni. Nessun token in localStorage.
let csrf: string | null = null;
export const setCsrf = (t: string | null) => (csrf = t);
export const getCsrf = () => csrf;

export class ApiError extends Error {
  constructor(message: string, public status: number, public body?: unknown) {
    super(message);
  }
}

let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);
let onMfaSetupRequired: (() => void) | null = null;
export const setMfaSetupHandler = (fn: () => void) => (onMfaSetupRequired = fn);

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      credentials: 'same-origin',
      signal: init.signal,
    });
  } catch {
    throw new ApiError('GIGI OS non raggiungibile', 0);
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) onUnauthorized?.();
    // 2FA azzerata o disattivata mentre la pagina era aperta: si torna alla schermata di configurazione.
    if (res.status === 403 && (body as { code?: string })?.code === 'mfa_setup_required') onMfaSetupRequired?.();
    throw new ApiError((body as { error?: string })?.error ?? `Errore ${res.status}`, res.status, body);
  }
  return body as T;
}

// ───────── Tipi condivisi con l'API ─────────
export type Role = 'admin' | 'operator' | 'viewer';
export const ROLE_LABEL: Record<Role, string> = { admin: 'Amministratore', operator: 'Operatore', viewer: 'Sola lettura' };
export type User = {
  id: string;
  username: string;
  role: Role;
  csrf: string;
  /** setupRequired: ruolo con 2FA obbligatoria ma non ancora configurata (il backend blocca tutto il resto). */
  mfa: { enabled: boolean; required: boolean; setupRequired: boolean };
};
export type LoginResult = { user: User; recoveryLeft?: number } | { mfaRequired: true; ticket: string };
export type AuthState = { setupRequired: boolean; user: User | null };

export type SystemSnapshot = {
  t: number;
  hostname: string;
  os: string;
  kernel: string;
  arch: string;
  cpuModel: string;
  gpu: string | null;
  uptime: number;
  load: [number, number, number];
  cpu: { usage: number; cores: number; perCore: number[] };
  memory: { total: number; available: number; used: number; cached: number; swapTotal: number; swapUsed: number };
  temps: { sensor: string; label: string; celsius: number; high?: number; crit?: number }[];
  cpuTemp: number | null;
  disks: { label: string; total: number; free: number; used: number; ok: boolean }[];
  network: {
    interfaces: { name: string; state: string; rxBytes: number; txBytes: number; rxRate: number; txRate: number }[];
    rxRate: number;
    txRate: number;
  };
};
export type Sample = { t: number; cpu: number; mem: number; rx: number; tx: number; load1: number; temp: number | null };

// Storico persistente (D-027): valori null = nessun dato in quel punto (GIGI OS fermo, agent riavviato).
export type MetricsRange = '1h' | '24h' | '7d' | '30d';
type Col = (number | null)[];
export type HostMetrics = { range: MetricsRange; bucketMs: number; since: number | null; times: number[]; cpu: Col; cpuMax: Col; mem: Col; rx: Col; tx: Col; temp: Col };
export type ContainerMetrics = {
  range: MetricsRange;
  metric: 'cpu' | 'mem';
  bucketMs: number;
  times: number[];
  series: { name: string; values: Col }[];
  ranking: { name: string; cpuAvg: number; cpuPeak: number; memAvg: number; memMax: number; lastSeen: number }[];
};
export type DiskForecast =
  | { status: 'insufficient'; dataDays: number }
  | { status: 'stable' | 'shrinking'; perDay: number; dataDays: number }
  | { status: 'growing'; perDay: number; days: number; daysMin: number; daysMax: number | null; dataDays: number };
export type DiskMetrics = { label: string; points: { t: number; used: number; free: number; total: number }[]; forecast: DiskForecast }[];

export type Container = {
  id: string;
  shortId: string;
  name: string;
  image: string;
  state: string;
  status: string;
  health: string | null;
  created: number;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  restartCount: number;
  restartPolicy: string | null;
  networkMode: string | null;
  composeProject: string | null;
  composeService: string | null;
  ports: { ip: string | null; private: number; public: number | null; type: string }[];
  stats: { cpu: number; memUsed: number; memLimit: number; rx: number; tx: number; t: number } | null;
  controllable: boolean;
};

export type ContainerDetail = {
  id: string;
  name: string;
  image: string;
  imageId: string;
  created: string;
  state: {
    status: string;
    running: boolean;
    startedAt: string;
    finishedAt: string;
    exitCode: number;
    oomKilled: boolean;
    error: string | null;
    health: { status: string; failingStreak: number; log: { start: string; exitCode: number; output: string }[] } | null;
  };
  restartCount: number;
  restartPolicy: { Name: string; MaximumRetryCount?: number };
  privileged: boolean;
  user: string | null;
  networkMode: string;
  cmd: string[] | null;
  entrypoint: string[] | null;
  env: { key: string; value: string; redacted: boolean }[] | null;
  labels: { key: string; value: string }[] | null;
  mounts: { type: string; source: string; destination: string; rw: boolean; name: string | null }[];
  ports: { container: string; host: string[] }[];
  networks: { name: string; ip: string | null }[];
  devices: string[];
  capAdd: string[];
  healthcheck: { test: string[]; interval: number | null } | null;
  stats: Container['stats'];
  controllable: boolean;
};

export type IntegrationStatus = 'online' | 'unhealthy' | 'offline' | 'unauthorized' | 'unconfigured' | 'unsupported' | 'error' | 'disabled';

export type Integration = {
  id: string;
  type: string;
  typeLabel: string;
  name: string;
  baseUrl: string;
  webUrl: string;
  auth: string;
  secretFields: string[];
  config: Record<string, string>;
  enabled: boolean;
  capabilities: string[];
  status: IntegrationStatus | null;
  message: string | null;
  lastChecked: number | null;
  latency: number | null;
};

export type IntegrationType = {
  type: string;
  label: string;
  description: string;
  defaultUrl: string;
  defaultWebUrl: string | null;
  defaultName: string;
  defaultContainer: string | null;
  auth: { id: string; label: string; fields: { key: string; label: string; type: 'password' | 'text'; required: boolean; help?: string }[] }[];
  configFields: { key: string; label: string; placeholder?: string; help?: string }[];
  capabilities: string[];
  resources: string[];
};

export type EventRow = { id: number; ts: number; level: 'info' | 'warning' | 'error'; source: string; title: string; details: string | null };

export type Overview = {
  system: SystemSnapshot | null;
  systemError: string | null;
  containers: { total: number; running: number; stopped: number; unhealthy: string[]; restarting: string[]; list: Container[] } | null;
  containersError: string | null;
  integrations: Integration[];
  events: EventRow[];
};
