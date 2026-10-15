// Connettori per Navidrome, Home Assistant, Armony, Apollo e HTTP generico.
import { createHash, randomBytes } from 'node:crypto';
import { expectOk, json, type ConnectorContext, type ConnectorDef } from './types.js';

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
  },
};

export const armony: ConnectorDef = {
  type: 'armony',
  label: 'Armony',
  description: 'App musicale personale. GIGI OS legge /api/info (pubblico) senza modificarla.',
  defaultUrl: 'http://127.0.0.1:8080',
  defaultWebUrl: 'http://192.168.222.200:8080',
  defaultName: 'Armony',
  defaultContainer: 'armony-app',
  auth: [{ id: 'none', label: 'Nessuna (endpoint pubblico)', fields: [] }],
  capabilities: ['health', 'info'],
  async test(ctx) {
    const r = await ctx.http('/api/info');
    if (r.status >= 400) return { status: 'offline', message: `HTTP ${r.status}` };
    const i = json<{ armony?: boolean; version?: string; name?: string }>(r);
    if (!i.armony) return { status: 'error', message: 'Il servizio non si identifica come Armony' };
    return { status: 'online', message: i.name ? `Istanza «${i.name}»` : 'Operativa', version: i.version ?? null };
  },
  resources: {
    async info(ctx) {
      const i = json<{ api: number; version?: string; name?: string; public?: string; caps?: string[] }>(expectOk(await ctx.http('/api/info'), 'Info'));
      return { api: i.api, version: i.version ?? null, name: i.name ?? null, publicUrl: i.public ?? null, capabilities: i.caps ?? [] };
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
