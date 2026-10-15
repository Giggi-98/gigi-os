// qBittorrent WebUI API v2. Login con cookie SID tenuto in memoria; nessun retry automatico
// dopo credenziali errate (qBittorrent banna l'IP dopo troppi tentativi falliti).
import { ConnectorError, expectOk, json, type ConnectorContext, type ConnectorDef } from './types.js';

const sids = new Map<string, { sid: string; t: number }>();
const SID_TTL = 20 * 60_000;

async function login(ctx: ConnectorContext): Promise<string> {
  if (!ctx.secret.username || !ctx.secret.password) throw new ConnectorError('Credenziali mancanti', 'unconfigured', 400);
  const body = new URLSearchParams({ username: ctx.secret.username, password: ctx.secret.password });
  const r = await ctx.http('/api/v2/auth/login', {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/x-www-form-urlencoded', Referer: ctx.baseUrl, Origin: ctx.baseUrl },
  });
  const text = r.body.toString('utf8').trim();
  if (r.status === 403) throw new ConnectorError('IP temporaneamente bannato da qBittorrent per troppi tentativi', 'unauthorized');
  if (text !== 'Ok.') throw new ConnectorError('Credenziali rifiutate', 'unauthorized');
  const sid = /SID=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')?.[1];
  if (!sid) throw new ConnectorError('Login riuscito ma cookie SID assente', 'error');
  sids.set(ctx.id, { sid, t: Date.now() });
  return sid;
}

async function call(ctx: ConnectorContext, path: string, what: string) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const cached = sids.get(ctx.id);
    const sid = cached && Date.now() - cached.t < SID_TTL ? cached.sid : await login(ctx);
    const r = await ctx.http(path, { headers: { Cookie: `SID=${sid}`, Referer: ctx.baseUrl } });
    if (r.status === 403 && attempt === 0) {
      sids.delete(ctx.id);
      continue;
    }
    return expectOk(r, what);
  }
  throw new ConnectorError(`${what}: accesso negato`, 'unauthorized');
}

export function forgetSession(id: string) {
  sids.delete(id);
}

type Torrent = {
  hash: string;
  name: string;
  state: string;
  progress: number;
  size: number;
  dlspeed: number;
  upspeed: number;
  eta: number;
  category: string;
  save_path: string;
  content_path: string;
  added_on: number;
  completion_on: number;
  ratio: number;
  num_seeds: number;
  num_leechs: number;
  amount_left: number;
};

export const qbittorrent: ConnectorDef = {
  type: 'qbittorrent',
  label: 'qBittorrent',
  description: 'Client torrent: download, avanzamento, categorie e velocità.',
  defaultUrl: 'http://192.168.222.200:8085',
  defaultName: 'qBittorrent',
  defaultContainer: 'qbittorrent',
  auth: [
    {
      id: 'password',
      label: 'Utente e password',
      fields: [
        { key: 'username', label: 'Utente', type: 'text', required: true },
        { key: 'password', label: 'Password', type: 'password', required: true },
      ],
    },
  ],
  capabilities: ['health', 'torrents', 'transfer'],

  async test(ctx) {
    if (!ctx.secret.username) {
      const r = await ctx.http('/', {});
      return { status: r.status < 500 ? 'unconfigured' : 'offline', message: 'Raggiungibile, credenziali mancanti' };
    }
    sids.delete(ctx.id);
    const v = (await call(ctx, '/api/v2/app/version', 'Versione')).body.toString('utf8').trim();
    return { status: 'online', message: 'Autenticato', version: v };
  },

  resources: {
    async torrents(ctx) {
      const list = json<Torrent[]>(await call(ctx, '/api/v2/torrents/info?sort=added_on&reverse=true', 'Torrent'));
      return list.map((t) => ({
        hash: t.hash,
        name: t.name,
        state: t.state,
        progress: t.progress,
        size: t.size,
        dlspeed: t.dlspeed,
        upspeed: t.upspeed,
        eta: t.eta,
        category: t.category,
        savePath: t.save_path,
        addedOn: t.added_on * 1000,
        completedOn: t.completion_on > 0 ? t.completion_on * 1000 : null,
        ratio: t.ratio,
        seeds: t.num_seeds,
        leechs: t.num_leechs,
        complete: t.amount_left === 0 && t.progress >= 1,
      }));
    },
    async transfer(ctx) {
      const t = json<{ dl_info_speed: number; up_info_speed: number; dl_info_data: number; up_info_data: number; connection_status: string }>(
        await call(ctx, '/api/v2/transfer/info', 'Trasferimento'),
      );
      return { dlSpeed: t.dl_info_speed, upSpeed: t.up_info_speed, dlSession: t.dl_info_data, upSession: t.up_info_data, connection: t.connection_status };
    },
  },
};
