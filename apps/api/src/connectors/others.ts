// Connettori per Navidrome, Home Assistant, Armony, Apollo e HTTP generico.
import { createHash, randomBytes } from 'node:crypto';
import { ConnectorError, expectOk, json, type ConnectorContext, type ConnectorDef } from './types.js';

function subsonicQuery(ctx: ConnectorContext) {
  const salt = randomBytes(6).toString('hex');
  const token = createHash('md5').update(ctx.secret.password + salt).digest('hex');
  return new URLSearchParams({ u: ctx.secret.username, t: token, s: salt, v: '1.16.1', c: 'gigi-os', f: 'json' }).toString();
}

export const navidrome: ConnectorDef = {
  type: 'navidrome',
  label: 'Navidrome',
  description: 'Server musicale usato da Armony. Senza credenziali: solo health; con credenziali: stato scansione.',
  defaultUrl: 'http://127.0.0.1:4533',
  defaultName: 'Navidrome (Armony)',
  defaultContainer: 'armony-navidrome',
  auth: [
    { id: 'none', label: 'Nessuna (solo health)', fields: [] },
    {
      id: 'subsonic',
      label: 'Utente Subsonic',
      fields: [
        { key: 'username', label: 'Utente', type: 'text', required: true },
        { key: 'password', label: 'Password', type: 'password', required: true },
      ],
    },
  ],
  capabilities: ['health', 'scan-status'],
  async test(ctx) {
    const r = await ctx.http('/ping');
    if (r.status >= 400) return { status: 'offline', message: `HTTP ${r.status}` };
    if (ctx.auth !== 'subsonic') return { status: 'online', message: 'Raggiungibile (health)' };
    const p = json<{ 'subsonic-response': { status: string; serverVersion?: string; error?: { message: string } } }>(
      expectOk(await ctx.http(`/rest/ping.view?${subsonicQuery(ctx)}`), 'Ping'),
    )['subsonic-response'];
    if (p.status !== 'ok') return { status: 'unauthorized', message: p.error?.message ?? 'Credenziali rifiutate' };
    return { status: 'online', message: 'Autenticato', version: p.serverVersion ?? null };
  },
  resources: {
    async scan(ctx) {
      if (ctx.auth !== 'subsonic') return { supported: false };
      const r = json<{ 'subsonic-response': { scanStatus?: { scanning: boolean; count: number; lastScan?: string } } }>(
        expectOk(await ctx.http(`/rest/getScanStatus.view?${subsonicQuery(ctx)}`), 'Scansione'),
      )['subsonic-response'];
      return { supported: true, ...r.scanStatus };
    },
  },
};

export const homeassistant: ConnectorDef = {
  type: 'homeassistant',
  label: 'Home Assistant',
  description: 'Domotica: stato del core, versione, numero di entità.',
  defaultUrl: 'http://127.0.0.1:8123',
  defaultWebUrl: 'http://192.168.222.200:8123',
  defaultName: 'Home Assistant',
  defaultContainer: 'homeassistant',
  auth: [
    {
      id: 'token',
      label: 'Long-lived access token',
      fields: [{ key: 'token', label: 'Token', type: 'password', required: true, help: 'Profilo utente → Sicurezza → Token di accesso a lunga durata' }],
    },
  ],
  capabilities: ['health', 'system-info', 'entities'],
  async test(ctx) {
    if (!ctx.secret.token) {
      const r = await ctx.http('/manifest.json');
      return { status: r.status < 500 ? 'unconfigured' : 'offline', message: 'Raggiungibile, token mancante' };
    }
    const r = await ctx.http('/api/config', { headers: { Authorization: `Bearer ${ctx.secret.token}` } });
    if (r.status === 401 || r.status === 403) return { status: 'unauthorized', message: 'Token rifiutato' };
    const c = json<{ version: string; location_name: string; state?: string }>(expectOk(r, 'Config'));
    return {
      status: c.state && c.state !== 'RUNNING' ? 'unhealthy' : 'online',
      message: `${c.location_name}${c.state ? ` — ${c.state}` : ''}`,
      version: c.version,
    };
  },
  resources: {
    async overview(ctx) {
      const h = { headers: { Authorization: `Bearer ${ctx.secret.token}` } };
      const [c, states] = await Promise.all([
        ctx.http('/api/config', h).then((r) => json<{ version: string; location_name: string; state?: string }>(expectOk(r, 'Config'))),
        ctx.http('/api/states', { ...h, maxBytes: 20 * 1024 * 1024 }).then((r) => json<{ entity_id: string; state: string }[]>(expectOk(r, 'Stati'))),
      ]);
      const domains: Record<string, number> = {};
      for (const s of states) {
        const d = s.entity_id.split('.')[0];
        domains[d] = (domains[d] ?? 0) + 1;
      }
      return {
        version: c.version,
        location: c.location_name,
        state: c.state ?? null,
        entities: states.length,
        unavailable: states.filter((s) => s.state === 'unavailable').length,
        domains,
      };
    },
    /** Servizi notify.* disponibili (es. notify.mobile_app_telefono) per il canale di notifica. */
    async notify(ctx) {
      const r = await ctx.http('/api/services', { headers: { Authorization: `Bearer ${ctx.secret.token}` }, maxBytes: 10 * 1024 * 1024 });
      const all = json<{ domain: string; services: Record<string, unknown> }[]>(expectOk(r, 'Servizi'));
      return (all.find((d) => d.domain === 'notify')?.services ? Object.keys(all.find((d) => d.domain === 'notify')!.services) : []).map((s) => `notify.${s}`);
    },
  },
};

// Armony: app dell'utente. Con la chiave API (arm_…) GIGI OS legge stato, dispositivi e registro, e può inviare
// i comandi musicali consentiti. Le chiavi Armony valgono solo da casa/Tailscale e mai su /rest (Navidrome).
const ARMONY_CMDS = new Set(['play', 'pause', 'toggle', 'next', 'prev', 'volume']);

function armonyHeaders(ctx: ConnectorContext): Record<string, string> {
  return ctx.auth === 'apikey' && ctx.secret.apiKey ? { Authorization: `Bearer ${ctx.secret.apiKey}`, Accept: 'application/json' } : { Accept: 'application/json' };
}

async function armonyGet<T>(ctx: ConnectorContext, path: string, what: string): Promise<T> {
  if (ctx.auth !== 'apikey') throw new ConnectorError('Serve la chiave API di Armony', 'unconfigured', 409);
  return json<T>(expectOk(await ctx.http(path, { headers: armonyHeaders(ctx) }), what));
}

type ArmonyTrack = { id: string; title: string; artist: string; album: string; duration?: number; genre?: string };
type ArmonyState = {
  device: string;
  name: string;
  playing: boolean;
  position: number;
  duration: number;
  volume: number;
  shuffle: boolean;
  repeat: string;
  at: number;
  track: ArmonyTrack | null;
  radio: unknown;
};
type ArmonySample = { t: number; cpu: number; mem: number; rss: number; req: number; live: number; load: number; jobs: number; audio: number };

export const armony: ConnectorDef = {
  type: 'armony',
  label: 'Armony',
  description: 'La tua app musicale. Con la chiave API: dispositivi e brani in riproduzione, stato del server, registro eventi e comandi di riproduzione.',
  defaultUrl: 'http://127.0.0.1:8080',
  defaultWebUrl: 'http://192.168.222.200:8080',
  defaultName: 'Armony',
  defaultContainer: 'armony-app',
  auth: [
    {
      id: 'apikey',
      label: 'Chiave API Armony',
      fields: [{ key: 'apiKey', label: 'Chiave API', type: 'password', required: true, help: 'Armony → Profilo → Chiavi API (inizia con arm_). Una chiave «con comandi» abilita play/pausa/volume.' }],
    },
    { id: 'none', label: 'Nessuna (solo /api/info pubblico)', fields: [] },
  ],
  capabilities: ['health', 'info', 'now-playing', 'server-status', 'log', 'playback-control'],
  adminResources: ['log', 'server'],
  async test(ctx) {
    const r = await ctx.http('/api/info');
    if (r.status >= 400) return { status: 'offline', message: `HTTP ${r.status}` };
    const i = json<{ armony?: boolean; version?: string; name?: string }>(r);
    if (!i.armony) return { status: 'error', message: 'Il servizio non si identifica come Armony' };
    if (ctx.auth !== 'apikey') return { status: 'online', message: i.name ? `Istanza «${i.name}» (senza chiave: solo info)` : 'Operativa', version: i.version ?? null };
    const m = await ctx.http('/api/me', { headers: armonyHeaders(ctx) });
    if (m.status === 401 || m.status === 403) return { status: 'unauthorized', message: 'Chiave API rifiutata (revocata o non valida da questa rete)', version: i.version ?? null };
    const me = json<{ user?: string; admin?: boolean }>(expectOk(m, 'Profilo'));
    if (!me.user) return { status: 'unauthorized', message: 'Chiave API non riconosciuta', version: i.version ?? null };
    return { status: 'online', message: `Autenticato come ${me.user}${me.admin ? ' (amministratore)' : ''}`, version: i.version ?? null };
  },
  resources: {
    async info(ctx) {
      const i = json<{ api: number; version?: string; name?: string; public?: string; caps?: string[] }>(expectOk(await ctx.http('/api/info'), 'Info'));
      return { api: i.api, version: i.version ?? null, name: i.name ?? null, publicUrl: i.public ?? null, capabilities: i.caps ?? [] };
    },
    async me(ctx) {
      const m = await armonyGet<{ user: string; admin: boolean; version: string; perm?: Record<string, boolean> }>(ctx, '/api/me', 'Profilo');
      return { user: m.user, admin: m.admin, version: m.version, permissions: Object.entries(m.perm ?? {}).filter(([, v]) => v).map(([k]) => k) };
    },
    async live(ctx) {
      const d = await armonyGet<{ devices: { device: string; name: string }[]; states: ArmonyState[]; now: number }>(ctx, '/api/live/stato', 'Dispositivi');
      return {
        now: d.now,
        devices: d.devices.map((dev) => {
          const st = d.states.find((s) => s.device === dev.device);
          return {
            device: dev.device,
            name: dev.name,
            state: st
              ? {
                  playing: st.playing,
                  position: st.position,
                  duration: st.duration,
                  volume: st.volume,
                  shuffle: st.shuffle,
                  repeat: st.repeat,
                  at: st.at,
                  radio: !!st.radio,
                  track: st.track ? { title: st.track.title, artist: st.track.artist, album: st.track.album, genre: st.track.genre ?? null } : null,
                }
              : null,
          };
        }),
      };
    },
    async server(ctx) {
      const s = await armonyGet<{
        version: string;
        uptime: number;
        started: number;
        cores: number;
        threads: number;
        mem: { total: number; available: number };
        disk: { total: number; used: number; free: number };
        streams: unknown[];
        live: { user: string; name: string; net: string; since: number }[];
        jobs: { byStatus: Record<string, number>; queue: number };
        navidrome_ms: number | null;
        dominio?: { domain: string; issuer: string; until: number; days: number; port: number; problemi: string[] };
        fast: ArmonySample[];
      }>(ctx, '/api/stato', 'Stato server');
      return {
        version: s.version,
        uptime: s.uptime,
        started: s.started,
        threads: s.threads,
        disk: s.disk,
        streams: s.streams.length,
        listeners: s.live.map((l) => ({ user: l.user, name: l.name, net: l.net, since: l.since })),
        jobs: s.jobs,
        navidromeMs: s.navidrome_ms,
        domain: s.dominio
          ? { name: s.dominio.domain, issuer: s.dominio.issuer, expires: s.dominio.until * 1000, days: s.dominio.days, port: s.dominio.port, problems: s.dominio.problemi }
          : null,
        series: s.fast.slice(-120).map((x) => ({ t: x.t * 1000, cpu: x.cpu, rss: x.rss, req: x.req, live: x.live })),
      };
    },
    async log(ctx, params) {
      const limit = Math.min(Number(params.get('limit') ?? 50) || 50, 200);
      const l = await armonyGet<{ items: { id: number; level: string; area: string; msg: string; detail: string; n: number; last: number; user: string | null }[]; day: Record<string, number> }>(
        ctx,
        `/api/log?limit=${limit}`,
        'Registro',
      );
      return { day: l.day, items: l.items.map((x) => ({ id: x.id, level: x.level, area: x.area, msg: x.msg, detail: x.detail, count: x.n, last: x.last * 1000, user: x.user })) };
    },
  },
  actions: {
    async command(ctx, body) {
      const b = (body ?? {}) as { to?: unknown; cmd?: unknown; value?: unknown };
      const to = typeof b.to === 'string' ? b.to.slice(0, 80) : '';
      const cmd = typeof b.cmd === 'string' ? b.cmd : '';
      if (!to || !ARMONY_CMDS.has(cmd)) throw new ConnectorError('Comando non consentito', 'error', 400);
      const value = cmd === 'volume' && typeof b.value === 'number' ? Math.max(0, Math.min(100, Math.round(b.value))) : undefined;
      if (ctx.auth !== 'apikey') throw new ConnectorError('Serve la chiave API di Armony', 'unconfigured', 409);
      const r = await ctx.http('/api/live/cmd', {
        method: 'POST',
        headers: { ...armonyHeaders(ctx), 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, cmd, ...(value !== undefined ? { value } : {}), from: 'GIGI OS' }),
      });
      if (r.status === 405 || r.status === 403) throw new ConnectorError('La chiave Armony è di sola lettura: crea una chiave «con comandi»', 'unauthorized', 403);
      if (r.status === 404) throw new ConnectorError('Il dispositivo non è più collegato', 'error', 404);
      return json(expectOk(r, 'Comando'));
    },
  },
};

export const apollo: ConnectorDef = {
  type: 'apollo',
  label: 'Apollo',
  description: 'Client web per Jellyfin (DPilat-Dev/Apollo). Nessuna API amministrativa: solo health; i contenuti visibili dipendono da Jellyfin.',
  defaultUrl: 'http://127.0.0.1:4173',
  defaultWebUrl: 'http://192.168.222.200:4173',
  defaultName: 'Apollo',
  defaultContainer: 'apollo',
  auth: [{ id: 'none', label: 'Nessuna', fields: [] }],
  capabilities: ['health'],
  async test(ctx) {
    const r = await ctx.http('/', { maxBytes: 1024 * 1024 });
    if (r.status >= 400) return { status: 'offline', message: `HTTP ${r.status}` };
    return { status: 'online', message: 'Interfaccia raggiungibile' };
  },
  resources: {},
};

export const genericHttp: ConnectorDef = {
  type: 'http',
  label: 'Servizio HTTP generico',
  description: 'Health check di un URL con autenticazione opzionale (Bearer, header API key o Basic).',
  defaultUrl: 'http://192.168.222.200',
  defaultName: 'Servizio',
  auth: [
    { id: 'none', label: 'Nessuna', fields: [] },
    { id: 'bearer', label: 'Bearer token', fields: [{ key: 'token', label: 'Token', type: 'password', required: true }] },
    {
      id: 'header',
      label: 'Header API key',
      fields: [
        { key: 'header', label: 'Nome header', type: 'text', required: true },
        { key: 'value', label: 'Valore', type: 'password', required: true },
      ],
    },
    {
      id: 'basic',
      label: 'Basic auth',
      fields: [
        { key: 'username', label: 'Utente', type: 'text', required: true },
        { key: 'password', label: 'Password', type: 'password', required: true },
      ],
    },
  ],
  configFields: [{ key: 'healthPath', label: 'Percorso health', placeholder: '/' }],
  capabilities: ['health'],
  async test(ctx) {
    const headers: Record<string, string> = {};
    if (ctx.auth === 'bearer') headers.Authorization = `Bearer ${ctx.secret.token}`;
    if (ctx.auth === 'header' && /^[A-Za-z0-9-]{1,64}$/.test(ctx.secret.header ?? '')) headers[ctx.secret.header] = ctx.secret.value;
    if (ctx.auth === 'basic') headers.Authorization = `Basic ${Buffer.from(`${ctx.secret.username}:${ctx.secret.password}`).toString('base64')}`;
    const p = ctx.config.healthPath || '/';
    const r = await ctx.http(p.startsWith('/') ? p : `/${p}`, { headers, maxBytes: 1024 * 1024 });
    if (r.status === 401 || r.status === 403) return { status: 'unauthorized', message: `HTTP ${r.status}` };
    if (r.status >= 500) return { status: 'unhealthy', message: `HTTP ${r.status}` };
    if (r.status >= 400) return { status: 'error', message: `HTTP ${r.status}` };
    return { status: 'online', message: `HTTP ${r.status} in ${r.latency} ms` };
  },
  resources: {},
};
