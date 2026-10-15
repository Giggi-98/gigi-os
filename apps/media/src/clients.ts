// Client minimi verso qBittorrent e Jellyfin. Le credenziali arrivano dall'API a ogni richiesta
// e restano solo in memoria: il worker non ha accesso al vault né salva segreti su disco.

export type Creds = {
  qbt: { baseUrl: string; auth: 'apikey' | 'password'; secret: Record<string, string> } | null;
  jf: { baseUrl: string; apiKey: string } | null;
  /** mappature percorso: container qBittorrent → host, host → container Jellyfin */
  qbtPathMap: { from: string; to: string }[];
  jfPathMap: { host: string; jf: string }[];
};

async function req(url: string, init: RequestInit & { timeoutMs?: number } = {}) {
  const res = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(init.timeoutMs ?? 15000) });
  return res;
}

export class HttpError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

// ───────── qBittorrent ─────────
let qbtSid: { sid: string; t: number; base: string } | null = null;

async function qbtHeaders(c: NonNullable<Creds['qbt']>): Promise<Record<string, string>> {
  if (c.auth === 'apikey') return { Authorization: `Bearer ${c.secret.apiKey}` };
  if (qbtSid && qbtSid.base === c.baseUrl && Date.now() - qbtSid.t < 20 * 60_000) return { Cookie: `SID=${qbtSid.sid}`, Referer: c.baseUrl };
  const r = await req(`${c.baseUrl}/api/v2/auth/login`, {
    method: 'POST',
    body: new URLSearchParams({ username: c.secret.username ?? '', password: c.secret.password ?? '' }),
    headers: { 'content-type': 'application/x-www-form-urlencoded', Referer: c.baseUrl, Origin: c.baseUrl },
  });
  const sid = /SID=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')?.[1];
  if ((await r.text()).trim() !== 'Ok.' || !sid) throw new HttpError('qBittorrent: login rifiutato', 401);
  qbtSid = { sid, t: Date.now(), base: c.baseUrl };
  return { Cookie: `SID=${sid}`, Referer: c.baseUrl };
}

export type QbtTorrent = {
  hash: string;
  name: string;
  state: string;
  progress: number;
  amount_left: number;
  category: string;
  save_path: string;
  content_path: string;
  completion_on: number;
};
export type QbtFile = { name: string; size: number; progress: number; priority: number };

async function qbtGet<T>(c: NonNullable<Creds['qbt']>, path: string): Promise<T> {
  const r = await req(`${c.baseUrl}${path}`, { headers: await qbtHeaders(c) });
  if (r.status === 401 || r.status === 403) {
    qbtSid = null;
    throw new HttpError('qBittorrent: accesso negato', r.status);
  }
  if (!r.ok) throw new HttpError(`qBittorrent: HTTP ${r.status}`, r.status);
  return (await r.json()) as T;
}

export const qbt = {
  torrents: (c: NonNullable<Creds['qbt']>) => qbtGet<QbtTorrent[]>(c, '/api/v2/torrents/info'),
  files: (c: NonNullable<Creds['qbt']>, hash: string) => qbtGet<QbtFile[]>(c, `/api/v2/torrents/files?hash=${encodeURIComponent(hash)}`),
};

// ───────── Jellyfin ─────────
function jfHeaders(c: NonNullable<Creds['jf']>) {
  return {
    Authorization: `MediaBrowser Client="GIGI OS", Device="gigi-media", DeviceId="gigi-media", Version="0.1.0", Token="${c.apiKey}"`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

async function jf<T>(c: NonNullable<Creds['jf']>, path: string, init: RequestInit = {}): Promise<T> {
  const r = await req(`${c.baseUrl}${path}`, { ...init, headers: jfHeaders(c) });
  if (r.status === 401 || r.status === 403) throw new HttpError('Jellyfin: API key rifiutata', r.status);
  if (!r.ok) throw new HttpError(`Jellyfin: HTTP ${r.status} su ${path.split('?')[0]}`, r.status);
  const t = await r.text();
  return (t ? JSON.parse(t) : null) as T;
}

export type RemoteResult = { Name: string; ProductionYear?: number; ProviderIds?: Record<string, string>; SearchProviderName?: string; Overview?: string };
export type JfItem = { Id: string; Name: string; Type: string; Path?: string; ProductionYear?: number; ProviderIds?: Record<string, string> };

export const jellyfin = {
  remoteSearch: (c: NonNullable<Creds['jf']>, type: 'Series' | 'Movie', name: string, year?: number | null) =>
    jf<RemoteResult[]>(c, `/Items/RemoteSearch/${type}`, {
      method: 'POST',
      body: JSON.stringify({ SearchInfo: { Name: name, ...(year ? { Year: year } : {}) } }),
    }),
  findLocal: (c: NonNullable<Creds['jf']>, type: 'Series' | 'Movie', term: string) =>
    jf<{ Items: JfItem[] }>(
      c,
      `/Items?Recursive=true&IncludeItemTypes=${type}&Fields=Path,ProviderIds,ProductionYear&searchTerm=${encodeURIComponent(term)}&Limit=20`,
    ).then((r) => r.Items),
  // CollapseBoxSetItems=false: senza, i film che appartengono a una collezione vengono sostituiti dal boxset
  recentByPath: (c: NonNullable<Creds['jf']>) =>
    jf<{ Items: JfItem[] }>(c, '/Items?Recursive=true&IncludeItemTypes=Movie,Episode&Fields=Path&CollapseBoxSetItems=false&SortBy=DateCreated&SortOrder=Descending&Limit=300').then(
      (r) => r.Items,
    ),
  /** Notifica mirata di nuovi file (stessa API usata da Sonarr/Radarr). */
  mediaUpdated: (c: NonNullable<Creds['jf']>, paths: string[]) =>
    jf<null>(c, '/Library/Media/Updated', { method: 'POST', body: JSON.stringify({ Updates: paths.map((Path) => ({ Path, UpdateType: 'Created' })) }) }),
  refreshAll: (c: NonNullable<Creds['jf']>) => jf<null>(c, '/Library/Refresh', { method: 'POST' }),
};

export function mapPath(p: string, map: { from: string; to: string }[]) {
  for (const m of map) {
    if (p === m.from || p.startsWith(m.from.endsWith('/') ? m.from : `${m.from}/`)) return m.to + p.slice(m.from.length);
  }
  return null;
}
