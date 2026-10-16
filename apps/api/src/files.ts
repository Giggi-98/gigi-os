// Ponte API ↔ gigi-files. Tutto il file manager è riservato agli amministratori; ogni modifica va in audit.
import http from 'node:http';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';
import type { Audit } from './security.js';

const INLINE: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.opus': 'audio/ogg',
  '.pdf': 'application/pdf',
};

/** Avvisi verso le librerie (Jellyfin) quando il file manager toglie o rimette dei file. */
export type LibraryHooks = { removed(absPaths: string[]): Promise<unknown>; restored(): Promise<unknown> };

export function registerFiles(app: FastifyInstance, socketPath: string, audit: Audit, admin: object, hooks?: LibraryHooks) {
  const call = (method: string, p: string, opts: { body?: unknown; stream?: Readable; headers?: Record<string, string> } = {}) =>
    new Promise<http.IncomingMessage>((resolve, reject) => {
      const data = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
      const req = http.request(
        {
          socketPath,
          path: p,
          method,
          headers: {
            ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
            ...(opts.headers ?? {}),
          },
        },
        resolve,
      );
      req.on('error', (e: NodeJS.ErrnoException) => reject(Object.assign(new Error(`File manager non raggiungibile: ${e.code ?? e.message}`), { statusCode: 503 })));
      if (opts.stream) opts.stream.pipe(req);
      else req.end(data);
    });

  const text = async (res: http.IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const c of res) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  };
  const json = async (reply: FastifyReply, res: http.IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const c of res) chunks.push(c as Buffer);
    return reply.code(res.statusCode ?? 500).type('application/json').send(Buffer.concat(chunks));
  };

  const qs = (q: Record<string, unknown>, keys: string[]) =>
    new URLSearchParams(Object.fromEntries(keys.filter((k) => typeof q[k] === 'string').map((k) => [k, q[k] as string]))).toString();

  for (const [route, keys] of [
    ['roots', []],
    ['list', ['root', 'path']],
    ['info', ['root', 'path']],
    ['search', ['root', 'path', 'q']],
    ['preview', ['root', 'path']],
    ['trash', ['root']],
  ] as [string, string[]][]) {
    app.get(`/api/v1/files/${route}`, admin, async (req, reply) => json(reply, await call('GET', `/v1/${route}?${qs(req.query as Record<string, unknown>, keys)}`)));
  }

  app.get('/api/v1/files/read', admin, async (req: FastifyRequest, reply: FastifyReply) => {
    const q = req.query as Record<string, string>;
    const res = await call('GET', `/v1/read?${qs(q, ['root', 'path'])}`, { headers: req.headers.range ? { range: req.headers.range } : {} });
    if ((res.statusCode ?? 500) >= 400) return json(reply, res);
    const name = decodeURIComponent(String(res.headers['x-file-name'] ?? 'file'));
    const type = INLINE[path.extname(name).toLowerCase()];
    const inline = q.download !== '1' && !!type;
    if (q.download === '1') audit.log(req, 'files.download', 'ok', `${q.root}:${q.path}`);
    reply.hijack();
    reply.raw.writeHead(res.statusCode ?? 200, {
      'content-type': inline ? type : 'application/octet-stream',
      'content-length': res.headers['content-length'] ?? '',
      'accept-ranges': 'bytes',
      ...(res.headers['content-range'] ? { 'content-range': res.headers['content-range'] } : {}),
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
      'content-security-policy': "sandbox; default-src 'none'; img-src 'self'; media-src 'self'",
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    });
    res.pipe(reply.raw);
    req.raw.on('close', () => res.destroy());
  });

  // Upload in streaming (application/octet-stream), senza bufferizzare in memoria
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));
  app.put('/api/v1/files/upload', { ...admin, bodyLimit: 8 * 1024 ** 3 }, async (req, reply) => {
    const q = req.query as Record<string, string>;
    const res = await call('PUT', `/v1/upload?${qs(q, ['root', 'path', 'name'])}`, {
      stream: req.body as Readable,
      headers: { 'content-type': 'application/octet-stream', ...(req.headers['content-length'] ? { 'content-length': String(req.headers['content-length']) } : {}) },
    });
    audit.log(req, 'files.upload', (res.statusCode ?? 500) < 400 ? 'ok' : 'error', `${q.root}:${q.path}/${q.name}`);
    return json(reply, res);
  });

  const mutation = (route: string, action: string, target: (b: Record<string, unknown>) => string, guard?: (b: Record<string, unknown>) => string | null) =>
    app.post(`/api/v1/files/${route}`, admin, async (req, reply) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const denied = guard?.(b);
      if (denied) return reply.code(400).send({ error: denied });
      const res = await call('POST', `/v1/${route}`, { body: b });
      const ok = (res.statusCode ?? 500) < 400;
      audit.log(req, action, ok ? 'ok' : 'error', target(b), { ...b, root: undefined });
      if (ok && hooks && (route === 'trash' || route === 'restore')) void notify(route, b).catch(() => undefined);
      return json(reply, res);
    });
  const notify = async (route: string, b: Record<string, unknown>) => {
    if (route === 'restore') return hooks!.restored();
    const r = await call('GET', '/v1/roots');
    const roots = JSON.parse(await text(r)) as { id: string; path: string }[];
    const root = roots.find((x) => x.id === b.root);
    if (!root || !Array.isArray(b.items)) return;
    return hooks!.removed((b.items as unknown[]).filter((i): i is string => typeof i === 'string').map((i) => path.posix.join(root.path, i)));
  };

  const where = (b: Record<string, unknown>) => `${b.root}:${b.path ?? ''}`;
  mutation('mkdir', 'files.mkdir', (b) => `${where(b)}/${b.name}`);
  mutation('rename', 'files.rename', (b) => `${where(b)} → ${b.name}`);
  mutation('transfer', 'files.transfer', (b) => `${b.op} ${b.root}:[${(b.items as unknown[] | undefined)?.length ?? 0}] → ${b.destRoot}:${b.destPath ?? ''}`);
  mutation('trash', 'files.trash', (b) => `${b.root}:[${(b.items as string[] | undefined)?.join(', ') ?? ''}]`);
  mutation('restore', 'files.restore', (b) => `${b.root}:${b.name}`);
  mutation('empty-trash', 'files.empty-trash', (b) => `${b.root}:${b.batch ?? 'tutto'}`, (b) => (b.confirm === 'SVUOTA' ? null : 'Conferma richiesta: scrivi SVUOTA'));
}
