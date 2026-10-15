// GIGI OS agent: unico processo con accesso a docker.sock e alle metriche host.
// Ascolta SOLO su un socket Unix condiviso con gigi-api; nessuna porta di rete.
import http from 'node:http';
import { chmod, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import {
  containerAction,
  engineInfo,
  eventStream,
  inspectContainer,
  listContainers,
  listImages,
  listNetworks,
  listVolumes,
  logStream,
  startStatsLoop,
} from './docker.js';
import { getHistory, getSnapshot, startSampler } from './system.js';
import { listServices, serviceDetail, serviceJournal, systemErrors } from './systemd.js';

const SOCKET = process.env.GIGI_AGENT_SOCKET ?? '/run/gigi/agent.sock';
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.@:-]{0,199}$/;

const log = (level: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));

function send(res: http.ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, params: string[], q: URLSearchParams) => Promise<void>;
const routes: [string, RegExp, Handler][] = [
  ['GET', /^\/v1\/health$/, async (_q, res) => send(res, 200, { ok: true })],
  ['GET', /^\/v1\/system$/, async (_q, res) => send(res, 200, getSnapshot())],
  [
    'GET',
    /^\/v1\/system\/history$/,
    async (_q, res, _p, q) => send(res, 200, getHistory(q.get('since') ? Number(q.get('since')) : undefined)),
  ],
  ['GET', /^\/v1\/systemd\/services$/, async (_q, res) => send(res, 200, await listServices())],
  ['GET', /^\/v1\/systemd\/services\/([^/]+)$/, async (_q, res, p) => send(res, 200, await serviceDetail(p[0]))],
  ['GET', /^\/v1\/systemd\/services\/([^/]+)\/journal$/, async (_q, res, p, q) => send(res, 200, await serviceJournal(p[0], Number(q.get('lines') ?? 200) || 200))],
  ['GET', /^\/v1\/journal\/errors$/, async (_q, res, _p, q) => send(res, 200, await systemErrors(Number(q.get('hours') ?? 24) || 24))],
  ['GET', /^\/v1\/docker\/info$/, async (_q, res) => send(res, 200, await engineInfo())],
  ['GET', /^\/v1\/containers$/, async (_q, res) => send(res, 200, await listContainers())],
  ['GET', /^\/v1\/containers\/([^/]+)$/, async (_q, res, p) => send(res, 200, await inspectContainer(p[0]))],
  [
    'GET',
    /^\/v1\/containers\/([^/]+)\/logs$/,
    async (req, res, p, q) => {
      const tail = Math.min(Math.max(Number(q.get('tail') ?? 200) || 200, 1), 5000);
      const follow = q.get('follow') === '1';
      const since = q.get('since') ? Number(q.get('since')) : undefined;
      const stream = await logStream(p[0], { tail, follow, since });
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      stream.pipe(res);
      req.on('close', () => stream.destroy());
    },
  ],
  [
    'POST',
    /^\/v1\/containers\/([^/]+)\/(start|stop|restart)$/,
    async (_q, res, p) => {
      const r = await containerAction(p[0], p[1] as 'start' | 'stop' | 'restart');
      log('info', 'container action', r);
      send(res, 200, r);
    },
  ],
  ['GET', /^\/v1\/images$/, async (_q, res) => send(res, 200, await listImages())],
  ['GET', /^\/v1\/volumes$/, async (_q, res) => send(res, 200, await listVolumes())],
  ['GET', /^\/v1\/networks$/, async (_q, res) => send(res, 200, await listNetworks())],
  [
    'GET',
    /^\/v1\/events$/,
    async (req, res) => {
      const ev = await eventStream();
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const rl = createInterface({ input: ev });
      rl.on('line', (line) => {
        try {
          const e = JSON.parse(line);
          res.write(
            JSON.stringify({
              t: e.time ? e.time * 1000 : Date.now(),
              action: e.Action ?? e.status,
              id: e.Actor?.ID ?? e.id,
              name: e.Actor?.Attributes?.name ?? null,
              exitCode: e.Actor?.Attributes?.exitCode ?? null,
            }) + '\n',
          );
        } catch {}
      });
      req.on('close', () => (ev as unknown as { destroy: () => void }).destroy());
    },
  ],
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://agent');
  for (const [method, re, handler] of routes) {
    const m = re.exec(url.pathname);
    if (!m || req.method !== method) continue;
    const params = m.slice(1).map(decodeURIComponent);
    if (params.some((p) => !ID_RE.test(p) && !['start', 'stop', 'restart'].includes(p))) return send(res, 400, { error: 'id non valido' });
    try {
      await handler(req, res, params, url.searchParams);
    } catch (e) {
      const err = e as { statusCode?: number; status?: number; message?: string };
      const status = err.status ?? (err.statusCode === 404 ? 404 : err.statusCode === 304 ? 409 : 500);
      log('error', 'request failed', { path: url.pathname, status, err: err.message });
      if (!res.headersSent) send(res, status, { error: status === 404 ? 'non trovato' : err.message ?? 'errore' });
      else res.end();
    }
    return;
  }
  send(res, 404, { error: 'route sconosciuta' });
});

async function main() {
  await mkdir(path.dirname(SOCKET), { recursive: true });
  await rm(SOCKET, { force: true });
  startSampler();
  startStatsLoop();
  server.listen(SOCKET, async () => {
    await chmod(SOCKET, 0o660);
    log('info', 'agent listening', { socket: SOCKET });
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

void main();
