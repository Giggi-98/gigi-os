// qBittorrent WebUI API v2 (≥ 5.0: start/stop al posto di resume/pause).
// Autenticazione: API key Bearer (≥ 5.2) oppure login con cookie SID tenuto in memoria; nessun retry automatico
// dopo credenziali errate (qBittorrent banna l'IP dopo troppi tentativi falliti).
// La ricerca usa il motore integrato di qBittorrent con i plugin già installati dall'utente: GIGI OS non ne aggiunge.
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

async function call(ctx: ConnectorContext, path: string, what: string, body?: URLSearchParams | FormData) {
  const init = (auth: Record<string, string>): RequestInit & { timeoutMs?: number } => ({
    method: body ? 'POST' : 'GET',
    body,
    headers: { ...auth, Referer: ctx.baseUrl, ...(body instanceof URLSearchParams ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    timeoutMs: 20_000,
  });
  if (ctx.auth === 'apikey') {
    const r = await ctx.http(path, init({ Authorization: `Bearer ${ctx.secret.apiKey}` }));
    if (r.status === 401 || r.status === 403) throw new ConnectorError(`${what}: API key rifiutata`, 'unauthorized');
    return checked(r, what);
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const cached = sids.get(ctx.id);
    const sid = cached && Date.now() - cached.t < SID_TTL ? cached.sid : await login(ctx);
    const r = await ctx.http(path, init({ Cookie: `SID=${sid}` }));
    if (r.status === 403 && attempt === 0) {
      sids.delete(ctx.id);
      continue;
    }
    return checked(r, what);
  }
  throw new ConnectorError(`${what}: accesso negato`, 'unauthorized');
}

function checked(r: Awaited<ReturnType<ConnectorContext['http']>>, what: string) {
  if (r.status === 409) throw new ConnectorError(`${what}: ${r.body.toString('utf8').trim() || 'conflitto'}`, 'error', 409);
  if (r.status === 400 || r.status === 415) throw new ConnectorError(`${what}: richiesta rifiutata da qBittorrent (${r.body.toString('utf8').trim().slice(0, 120) || r.status})`, 'error', 400);
  if (r.status === 404) throw new ConnectorError(`${what}: non trovato`, 'error', 404);
  return expectOk(r, what);
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
  uploaded?: number;
  downloaded?: number;
  seeding_time?: number;
  ratio_limit?: number;
  seeding_time_limit?: number;
  max_ratio?: number;
  max_seeding_time?: number;
  tags?: string;
};

// ───────── validazione input azioni ─────────
const HASH = /^[a-f0-9]{40}$|^[a-f0-9]{64}$/;
function hashes(b: Record<string, unknown>): string {
  const h = Array.isArray(b.hashes) ? b.hashes : [];
  if (h.length === 0 || h.length > 200 || !h.every((x) => typeof x === 'string' && HASH.test(x))) throw new ConnectorError('Elenco torrent non valido', 'error', 400);
  return h.join('|');
}
const obj = (b: unknown) => (b && typeof b === 'object' ? (b as Record<string, unknown>) : {});
const str = (v: unknown, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const searchId = (v: unknown) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new ConnectorError('Ricerca non valida', 'error', 400);
  return String(n);
};
function limit(v: unknown, max: number): number {
  // -2 = usa il limite globale, -1 = nessun limite
  const n = Number(v);
  if (n === -2 || n === -1) return n;
  if (!Number.isFinite(n) || n < 0 || n > max) throw new ConnectorError('Limite non valido', 'error', 400);
  return n;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function hashSet(ctx: ConnectorContext): Promise<Set<string>> {
  const list = json<{ hash: string }[]>(await call(ctx, '/api/v2/torrents/info', 'Torrent'));
  return new Set(list.map((t) => t.hash));
}

async function lastLogId(ctx: ConnectorContext): Promise<number> {
  const l = json<{ id: number }[]>(await call(ctx, '/api/v2/log/main?normal=true&info=false&warning=true&critical=true&last_known_id=-1', 'Log'));
  return l.length ? l[l.length - 1].id : -1;
}

function explain(msg: string) {
  if (/bencod|expected value/i.test(msg)) return 'il link non porta a un file .torrent valido (probabilmente è una pagina web)';
  if (/duplicate|already/i.test(msg)) return 'il torrent è già presente in qBittorrent';
  if (/Forbidden|403/i.test(msg)) return 'il sito ha rifiutato lo scaricamento (403)';
  if (/timed out|timeout/i.test(msg)) return 'il sito non ha risposto in tempo';
  return msg.replace(/^Failed to add torrent\.?\s*/i, '').slice(0, 200);
}

/**
 * qBittorrent accetta le aggiunte in modo asincrono: «Ok.» non significa che il torrent esista.
 * Si attende che compaia un hash nuovo; se nel log compare un errore di aggiunta, lo si riporta.
 */
async function confirmAdded(ctx: ConnectorContext, before: Set<string>, logId: number, timeoutMs = 20_000): Promise<string[]> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await sleep(1000);
    const now = await hashSet(ctx);
    const added = [...now].filter((h) => !before.has(h));
    if (added.length) return added;
    const log = json<{ id: number; message: string }[]>(
      await call(ctx, `/api/v2/log/main?normal=true&info=false&warning=true&critical=true&last_known_id=${logId}`, 'Log'),
    );
    const fail = log.find((e) => /failed to add torrent|duplicate torrent|already present|unable to download/i.test(e.message));
    if (fail) throw new ConnectorError(`qBittorrent non ha aggiunto il torrent: ${explain(fail.message)}`, 'error', 409);
  }
  throw new ConnectorError('qBittorrent non ha aggiunto il torrent entro 20 secondi (link non valido o sito irraggiungibile)', 'error', 504);
}

export const qbittorrent: ConnectorDef = {
  type: 'qbittorrent',
  label: 'qBittorrent',
  description: 'Client torrent: download, ricerca con i plugin installati, aggiunta, gestione e seeding.',
  defaultUrl: 'http://127.0.0.1:8080',
  defaultName: 'qBittorrent',
  defaultContainer: 'qbittorrent',
  auth: [
    {
      id: 'apikey',
      label: 'API key (qBittorrent ≥ 5.2)',
      fields: [{ key: 'apiKey', label: 'API key', type: 'password', required: true, help: 'Opzioni → Web UI → API key (inizia con qbt_)' }],
    },
    {
      id: 'password',
      label: 'Utente e password',
      fields: [
        { key: 'username', label: 'Utente', type: 'text', required: true },
        { key: 'password', label: 'Password', type: 'password', required: true },
      ],
    },
  ],
  capabilities: ['health', 'torrents', 'transfer', 'search', 'add', 'control', 'seeding'],

  async test(ctx) {
    if (ctx.auth === 'apikey') {
      const v = (await call(ctx, '/api/v2/app/version', 'Versione')).body.toString('utf8').trim();
      return { status: 'online', message: 'Autenticato con API key', version: v };
    }
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
        uploaded: t.uploaded ?? null,
        seedingTime: t.seeding_time ?? null,
        ratioLimit: t.ratio_limit ?? -2,
        seedingTimeLimit: t.seeding_time_limit ?? -2,
        stopped: /^(stopped|paused)/.test(t.state),
      }));
    },
    async transfer(ctx) {
      const t = json<{ dl_info_speed: number; up_info_speed: number; dl_info_data: number; up_info_data: number; connection_status: string }>(
        await call(ctx, '/api/v2/transfer/info', 'Trasferimento'),
      );
      return { dlSpeed: t.dl_info_speed, upSpeed: t.up_info_speed, dlSession: t.dl_info_data, upSession: t.up_info_data, connection: t.connection_status };
    },
    async categories(ctx) {
      const c = json<Record<string, { name: string; savePath: string }>>(await call(ctx, '/api/v2/torrents/categories', 'Categorie'));
      return Object.values(c).map((x) => ({ name: x.name, savePath: x.savePath }));
    },
    async plugins(ctx) {
      const p = json<{ name: string; fullName: string; enabled: boolean; version: string; supportedCategories: { id: string; name: string }[] }[]>(
        await call(ctx, '/api/v2/search/plugins', 'Plugin di ricerca'),
      );
      return p.map((x) => ({ name: x.name, fullName: x.fullName, enabled: x.enabled, version: x.version, categories: x.supportedCategories.map((c) => c.id) }));
    },
    async seeding(ctx) {
      const p = json<Record<string, unknown>>(await call(ctx, '/api/v2/app/preferences', 'Preferenze'));
      return {
        ratioEnabled: !!p.max_ratio_enabled,
        ratio: Number(p.max_ratio ?? -1),
        timeEnabled: !!p.max_seeding_time_enabled,
        minutes: Number(p.max_seeding_time ?? -1),
        // 0 = ferma il torrent, 1 = rimuovi, 2 = super seeding, 3 = rimuovi con i file
        action: Number(p.max_ratio_act ?? 0),
        upLimit: Number(p.up_limit ?? 0),
        dlLimit: Number(p.dl_limit ?? 0),
      };
    },
  },

  actions: {
    /** start / stop / recheck / reannounce su uno o più torrent. */
    async control(ctx, body) {
      const b = obj(body);
      const op = str(b.op, 20);
      const map: Record<string, string> = { start: 'start', stop: 'stop', recheck: 'recheck', reannounce: 'reannounce' };
      if (!map[op]) throw new ConnectorError('Operazione non consentita', 'error', 400);
      await call(ctx, `/api/v2/torrents/${map[op]}`, 'Controllo torrent', new URLSearchParams({ hashes: hashes(b) }));
      return { ok: true };
    },
    async setCategory(ctx, body) {
      const b = obj(body);
      await call(ctx, '/api/v2/torrents/setCategory', 'Categoria', new URLSearchParams({ hashes: hashes(b), category: str(b.category, 100) }));
      return { ok: true };
    },
    /** Limiti di condivisione per torrent: ratio e minuti di seeding (-2 globale, -1 illimitato). */
    async shareLimits(ctx, body) {
      const b = obj(body);
      await call(
        ctx,
        '/api/v2/torrents/setShareLimits',
        'Limiti di condivisione',
        new URLSearchParams({
          hashes: hashes(b),
          ratioLimit: String(limit(b.ratio, 9998)),
          seedingTimeLimit: String(limit(b.minutes, 525600)),
          inactiveSeedingTimeLimit: '-2',
        }),
      );
      return { ok: true };
    },
    /** Limiti globali di seeding. Azione al raggiungimento forzata a «ferma» (mai rimozione automatica). */
    async seedingPrefs(ctx, body) {
      const b = obj(body);
      const prefs = {
        max_ratio_enabled: !!b.ratioEnabled,
        max_ratio: b.ratioEnabled ? limit(b.ratio, 9998) : -1,
        max_seeding_time_enabled: !!b.timeEnabled,
        max_seeding_time: b.timeEnabled ? limit(b.minutes, 525600) : -1,
        max_ratio_act: 0,
      };
      await call(ctx, '/api/v2/app/setPreferences', 'Preferenze seeding', new URLSearchParams({ json: JSON.stringify(prefs) }));
      return { ok: true };
    },
    async delete(ctx, body) {
      const b = obj(body);
      await call(ctx, '/api/v2/torrents/delete', 'Eliminazione', new URLSearchParams({ hashes: hashes(b), deleteFiles: b.deleteFiles === true ? 'true' : 'false' }));
      return { ok: true, deleteFiles: b.deleteFiles === true };
    },
    /** Aggiunta da magnet/URL oppure da file .torrent (base64). L'URL lo scarica qBittorrent, non GIGI OS. */
    async add(ctx, body) {
      const b = obj(body);
      const urls = (Array.isArray(b.urls) ? b.urls : []).map((u) => str(u, 4000)).filter(Boolean);
      if (urls.length > 20) throw new ConnectorError('Massimo 20 link alla volta', 'error', 400);
      for (const u of urls) if (!/^(magnet:\?xt=urn:bt[im]h:|https?:\/\/)/i.test(u)) throw new ConnectorError('Sono ammessi solo link magnet o http(s)', 'error', 400);
      const category = str(b.category, 100);
      const plugin = /^[a-z0-9_]{1,40}$/.test(str(b.plugin, 40)) ? str(b.plugin, 40) : '';
      const before = await hashSet(ctx);
      const logId = await lastLogId(ctx);

      // Risultato di ricerca che punta a una pagina web: lo risolve il plugin, come fa l'interfaccia di qBittorrent
      const viaPlugin = plugin && urls.length === 1 && /^https?:/i.test(urls[0]) && !/\.torrent(\?|$)/i.test(urls[0]);
      if (viaPlugin) {
        await call(ctx, '/api/v2/search/downloadTorrent', 'Download dal plugin', new URLSearchParams({ torrentUrl: urls[0], pluginName: plugin }));
      } else {
        const fd = new FormData();
        if (urls.length) fd.set('urls', urls.join('\n'));
        if (typeof b.torrentBase64 === 'string' && b.torrentBase64) {
          const buf = Buffer.from(b.torrentBase64, 'base64');
          if (buf.length > 4 * 1024 * 1024) throw new ConnectorError('File .torrent troppo grande', 'error', 400);
          if (buf[0] !== 0x64) throw new ConnectorError('Il file non sembra un .torrent valido', 'error', 400);
          fd.set('torrents', new Blob([buf], { type: 'application/x-bittorrent' }), (str(b.fileName, 150) || 'file.torrent').replace(/[^\w.\- ]/g, '_'));
        }
        if (!urls.length && !fd.has('torrents')) throw new ConnectorError('Indica un link magnet o un file .torrent', 'error', 400);
        if (category) fd.set('category', category);
        if (b.stopped === true) fd.set('stopped', 'true');
        const r = await call(ctx, '/api/v2/torrents/add', 'Aggiunta torrent', fd);
        if (/^fails\.?$/i.test(r.body.toString('utf8').trim())) throw new ConnectorError('qBittorrent ha rifiutato il torrent (già presente o non valido)', 'error', 409);
      }
      const added = await confirmAdded(ctx, before, logId);
      // Il risolutore dei plugin non accetta categoria/stato: si applicano dopo, sul torrent appena comparso
      if (viaPlugin && category) await call(ctx, '/api/v2/torrents/setCategory', 'Categoria', new URLSearchParams({ hashes: added.join('|'), category }));
      if (viaPlugin && b.stopped === true) await call(ctx, '/api/v2/torrents/stop', 'Stop', new URLSearchParams({ hashes: added.join('|') }));
      return { ok: true, hashes: added };
    },
    async searchStart(ctx, body) {
      const b = obj(body);
      const pattern = str(b.pattern, 200);
      if (pattern.length < 2) throw new ConnectorError('Scrivi almeno 2 caratteri', 'error', 400);
      const category = ['all', 'anime', 'movies', 'tv', 'music', 'books', 'software', 'games', 'pictures'].includes(str(b.category, 20)) ? str(b.category, 20) : 'all';
      const r = json<{ id: number }>(await call(ctx, '/api/v2/search/start', 'Ricerca', new URLSearchParams({ pattern, plugins: 'enabled', category })));
      return { id: r.id };
    },
    async searchResults(ctx, body) {
      const b = obj(body);
      const id = searchId(b.id);
      const r = json<{
        status: string;
        total: number;
        results: { fileName: string; fileUrl: string; fileSize: number; nbSeeders: number; nbLeechers: number; siteUrl: string; descrLink: string; engineName?: string; pubDate?: number }[];
      }>(await call(ctx, `/api/v2/search/results?id=${id}&limit=500&offset=0`, 'Risultati'));
      const results = r.results
        .filter((x) => /^(magnet:|https?:)/i.test(x.fileUrl))
        .map((x) => ({
          name: x.fileName,
          url: x.fileUrl,
          size: x.fileSize,
          seeders: x.nbSeeders,
          leechers: x.nbLeechers,
          site: x.siteUrl,
          engine: x.engineName ?? x.siteUrl.replace(/^https?:\/\/(www\.)?/, ''),
          plugin: x.engineName && /^[a-z0-9_]{1,40}$/.test(x.engineName) ? x.engineName : null,
          info: /^https?:/i.test(x.descrLink) ? x.descrLink : null,
          published: x.pubDate ? x.pubDate * 1000 : null,
        }))
        .sort((a, b2) => b2.seeders - a.seeders);
      return { status: r.status, total: r.total, results };
    },
    async searchStop(ctx, body) {
      const id = searchId(obj(body).id);
      await call(ctx, '/api/v2/search/stop', 'Ricerca', new URLSearchParams({ id })).catch(() => undefined);
      await call(ctx, '/api/v2/search/delete', 'Ricerca', new URLSearchParams({ id })).catch(() => undefined);
      return { ok: true };
    },
  },
};

/** Tutti i torrent con i loro file, con i percorsi visti da qBittorrent (per riconoscere gli hardlink in libreria). */
export async function qbtTorrentFiles(ctx: ConnectorContext, only?: string[]) {
  const q = only?.length ? `?hashes=${only.map((h) => h.toLowerCase()).join('|')}` : '';
  const list = json<Torrent[]>(await call(ctx, `/api/v2/torrents/info${q}`, 'Torrent'));
  const out: { hash: string; name: string; files: { path: string; size: number }[] }[] = [];
  for (const t of list.slice(0, 500)) {
    const files = json<{ name: string; size: number }[]>(await call(ctx, `/api/v2/torrents/files?hash=${t.hash}`, 'File del torrent'));
    const base = t.save_path.replace(/\/+$/, '');
    out.push({ hash: t.hash, name: t.name, files: files.map((f) => ({ path: `${base}/${f.name}`, size: f.size })) });
  }
  return out;
}
