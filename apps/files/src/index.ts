// gigi-files: worker del file manager. Ascolta solo su socket Unix condiviso con gigi-api; nessuna porta.
// Autorizzazione e audit sono nell'API: qui si applicano i confini del filesystem.
import http from 'node:http';
import { chmod, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { Files, FsError, loadUsers, parseRoots } from './fsops.js';

const SOCKET = process.env.GIGI_FILES_SOCKET ?? '/run/gigi/files.sock';
const ROOTS = parseRoots(process.env.GIGI_FILES_ROOTS ?? 'Media=/srv');
const UPLOAD_MAX = Number(process.env.GIGI_FILES_UPLOAD_MAX ?? 8 * 1024 ** 3);
const files = new Files(ROOTS);
const log = (level: string, msg: string, extra: object = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));

async function body(req: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 512 * 1024) throw new FsError('Richiesta troppo grande', 413);
    chunks.push(c as Buffer);
  }
  return chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {};
}

function send(res: http.ServerResponse, status: number, data: unknown) {
  const s = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://files');
  const q = url.searchParams;
  const p = url.pathname;
  try {
    if (req.method === 'GET') {
      if (p === '/v1/health') return send(res, 200, { ok: true });
      if (p === '/v1/roots') return send(res, 200, ROOTS.map((r) => ({ id: r.id, label: r.label, path: r.path })));
      if (p === '/v1/list') return send(res, 200, await files.list(q.get('root'), q.get('path')));
      if (p === '/v1/info') return send(res, 200, await files.info(q.get('root'), q.get('path')));
      if (p === '/v1/search') return send(res, 200, await files.search(q.get('root'), q.get('path'), q.get('q')));
      if (p === '/v1/preview') return send(res, 200, await files.preview(q.get('root'), q.get('path')));
      if (p === '/v1/trash') return send(res, 200, await files.trashList(q.get('root')));
      if (p === '/v1/read') {
        const r = await files.readStream(q.get('root'), q.get('path'), req.headers.range);
        res.writeHead(r.partial ? 206 : 200, {
          'content-length': r.end - r.start + 1,
          'accept-ranges': 'bytes',
          'x-file-size': r.size,
          'x-file-name': encodeURIComponent(r.name),
          ...(r.partial ? { 'content-range': `bytes ${r.start}-${r.end}/${r.size}` } : {}),
        });
        r.stream.pipe(res);
        req.on('close', () => r.stream.destroy());
        return;
      }
    }
    if (req.method === 'PUT' && p === '/v1/upload') {
      return send(res, 200, await files.write(q.get('root'), q.get('path'), q.get('name'), req, UPLOAD_MAX));
    }
    if (req.method === 'POST') {
      const b = await body(req);
      if (p === '/v1/mkdir') return send(res, 200, await files.mkdir(b.root, b.path, b.name));
      if (p === '/v1/rename') return send(res, 200, await files.rename(b.root, b.path, b.name));
      if (p === '/v1/transfer') return send(res, 200, await files.transfer(b.op, b.root, b.items, b.destRoot, b.destPath));
      if (p === '/v1/trash') return send(res, 200, await files.trash(b.root, b.items));
      if (p === '/v1/restore') return send(res, 200, await files.restore(b.root, b.batch, b.name));
      if (p === '/v1/empty-trash') return send(res, 200, await files.emptyTrash(b.root, b.batch));
      if (p === '/v1/purge') return send(res, 200, await files.purge(b.root, b.items, b.stopAt));
    }
    send(res, 404, { error: 'route sconosciuta' });
  } catch (e) {
    const err = e as Error & { status?: number; code?: string };
    const status = e instanceof FsError ? err.status! : err.code === 'ENOENT' ? 404 : err.code === 'EACCES' ? 403 : 500;
    if (status >= 500) log('error', 'operazione fallita', { path: p, err: err.message });
    if (!res.headersSent) send(res, status, { error: e instanceof FsError ? err.message : status === 404 ? 'Non trovato' : status === 403 ? 'Permesso negato' : 'Errore del file manager' });
    else res.destroy();
  }
});

async function main() {
  await loadUsers(process.env.GIGI_PASSWD_FILE ?? '/host/passwd');
  await mkdir(path.dirname(SOCKET), { recursive: true });
  await rm(SOCKET, { force: true });
  server.requestTimeout = 0;
  server.listen(SOCKET, async () => {
    await chmod(SOCKET, 0o660);
    log('info', 'file manager in ascolto', { socket: SOCKET, roots: ROOTS });
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

void main();
