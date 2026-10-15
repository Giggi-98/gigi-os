// gigi-media: worker del motore media. Unico processo con /srv in scrittura (per gli hardlink).
// Ascolta solo su un socket Unix condiviso con gigi-api; nessuna porta di rete; nessun segreto su disco.
import http from 'node:http';
import { chmod, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Creds } from './clients.js';
import { Engine } from './engine.js';
import type { Libraries } from './decide.js';

const SOCKET = process.env.GIGI_MEDIA_SOCKET ?? '/run/gigi/media.sock';
const DATA = process.env.GIGI_DATA_DIR ?? path.resolve('data/media');

function parseLibraries(): Libraries {
  const def = 'movies=/srv/media/Film,series=/srv/media/SerieTV,animeMovies=/srv/media/Anime/Film,animeSeries=/srv/media/Anime/Serie';
  const out = Object.fromEntries((process.env.GIGI_MEDIA_LIBRARIES ?? def).split(',').map((kv) => kv.split('=').map((s) => s.trim())));
  for (const k of ['movies', 'series', 'animeMovies', 'animeSeries']) if (!out[k]) throw new Error(`Libreria ${k} non configurata`);
  return out as Libraries;
}

const log = (level: string, msg: string, extra: object = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));
const engine = new Engine(DATA, parseLibraries(), log);

async function body<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 256 * 1024) throw Object.assign(new Error('Richiesta troppo grande'), { status: 413 });
    chunks.push(c as Buffer);
  }
  return (chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) as T;
}

function send(res: http.ServerResponse, status: number, data: unknown) {
  const s = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

type Ctx = { creds: Creds; actor: string };
const ID = /^[0-9a-f]{20}$/;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://media');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && p === '/v1/health') return send(res, 200, { ok: true });
    if (req.method === 'GET' && p === '/v1/summary') return send(res, 200, { ...engine.summary(), libraryCheck: await engine.librariesCheck() });
    if (req.method === 'GET' && p === '/v1/items') return send(res, 200, engine.list(url.searchParams.get('status') ?? undefined, Math.min(Number(url.searchParams.get('limit') ?? 200), 1000)));
    let m = /^\/v1\/items\/([^/]+)$/.exec(p);
    if (req.method === 'GET' && m) {
      if (!ID.test(m[1])) return send(res, 400, { error: 'id non valido' });
      return send(res, 200, engine.detail(m[1]));
    }
    if (req.method === 'POST' && p === '/v1/scan') {
      const b = await body<Ctx>(req);
      return send(res, 200, await engine.scan(b.creds, b.actor));
    }
    if (req.method === 'PUT' && p === '/v1/settings') {
      const b = await body<{ autoImport?: boolean; threshold?: number }>(req);
      return send(res, 200, engine.setSettings(b));
    }
    m = /^\/v1\/items\/([^/]+)\/(import|override|ignore|restore|reanalyze|removed)$/.exec(p);
    if (req.method === 'POST' && m) {
      if (!ID.test(m[1])) return send(res, 400, { error: 'id non valido' });
      const b = await body<Ctx & { override?: Record<string, unknown> }>(req);
      const id = m[1];
      if (m[2] === 'import') return send(res, 200, await engine.importItem(id, b.creds, b.actor));
      if (m[2] === 'override') return send(res, 200, await engine.setOverride(id, b.override ?? {}, b.creds, b.actor));
      if (m[2] === 'ignore') return send(res, 200, engine.setIgnored(id, true, b.actor));
      if (m[2] === 'restore') return send(res, 200, engine.setIgnored(id, false, b.actor));
      if (m[2] === 'removed') return send(res, 200, engine.setRemoved(id, b.actor, (b as { details?: unknown }).details));
      return send(res, 200, await engine.reanalyze(id, b.creds, b.actor));
    }
    send(res, 404, { error: 'route sconosciuta' });
  } catch (e) {
    const err = e as Error & { status?: number };
    log(err.status && err.status < 500 ? 'warn' : 'error', 'richiesta fallita', { path: p, err: err.message });
    if (!res.headersSent) send(res, err.status ?? 500, { error: err.message });
  }
});

async function main() {
  await mkdir(path.dirname(SOCKET), { recursive: true });
  await rm(SOCKET, { force: true });
  server.listen(SOCKET, async () => {
    await chmod(SOCKET, 0o660);
    log('info', 'media worker in ascolto', { socket: SOCKET, libraries: engine.libraries });
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

void main();
