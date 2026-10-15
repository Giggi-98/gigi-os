// Operazioni sul filesystem confinate a radici consentite. Ogni percorso è risolto con realpath e verificato
// dentro la radice: niente "..", niente symlink che portano fuori. Le eliminazioni passano dal cestino.
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { copyFile, link, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

export class FsError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export type Root = { id: string; label: string; path: string };
export const TRASH = '.gigi-trash';
const COPY_MAX = Number(process.env.GIGI_FILES_COPY_MAX ?? 4 * 1024 ** 3);

export function parseRoots(spec: string): Root[] {
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [label, p] = s.split('=');
      return { id: label.toLowerCase().replace(/[^a-z0-9]+/g, '-'), label, path: path.resolve(p) };
    });
}

const users = new Map<number, string>([[0, 'root']]);
export async function loadUsers(file: string) {
  try {
    for (const line of (await readFile(file, 'utf8')).split('\n')) {
      const [name, , uid] = line.split(':');
      if (name && uid) users.set(Number(uid), name);
    }
  } catch {}
}
const owner = (uid: number) => users.get(uid) ?? String(uid);

export function validName(n: unknown): string {
  if (typeof n !== 'string') throw new FsError('Nome non valido');
  const s = n.trim();
  if (!s || s === '.' || s === '..' || s.length > 255 || /[/\\\0]/.test(s)) throw new FsError('Nome non valido: niente barre, «.» o «..»');
  if (s === TRASH) throw new FsError('Nome riservato');
  return s;
}

export class Files {
  constructor(public roots: Root[]) {}

  root(id: unknown): Root {
    const r = this.roots.find((x) => x.id === id);
    if (!r) throw new FsError('Radice non consentita', 403);
    return r;
  }

  /** Risolve un percorso relativo dentro la radice. `mustExist=false` per destinazioni nuove (si verifica il genitore). */
  async resolve(rootId: unknown, rel: unknown, mustExist = true): Promise<{ root: Root; abs: string; rel: string }> {
    const root = this.root(rootId);
    const r = typeof rel === 'string' ? rel : '';
    if (r.includes('\0')) throw new FsError('Percorso non valido');
    const parts = r.split('/').filter((p) => p && p !== '.');
    if (parts.some((p) => p === '..')) throw new FsError('Percorso non valido', 403);
    const abs = path.join(root.path, ...parts);
    const realRoot = await realpath(root.path);
    const check = async (p: string) => {
      const real = await realpath(p);
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new FsError('Percorso fuori dalla radice consentita', 403);
    };
    if (mustExist) {
      try {
        await check(abs);
      } catch (e) {
        if (e instanceof FsError) throw e;
        throw new FsError('Percorso inesistente', 404);
      }
    } else {
      try {
        await check(path.dirname(abs));
      } catch (e) {
        if (e instanceof FsError) throw e;
        throw new FsError('Cartella di destinazione inesistente', 404);
      }
    }
    return { root, abs, rel: parts.join('/') };
  }

  private async entry(abs: string, name: string) {
    const ls = await lstat(abs);
    const link = ls.isSymbolicLink();
    const type = link ? 'symlink' : ls.isDirectory() ? 'dir' : ls.isFile() ? 'file' : 'other';
    return {
      name,
      type,
      size: ls.isFile() ? ls.size : null,
      mtime: ls.mtimeMs,
      mode: (ls.mode & 0o777).toString(8).padStart(3, '0'),
      owner: owner(ls.uid),
      group: owner(ls.gid),
      links: ls.isFile() ? ls.nlink : null,
    };
  }

  async list(rootId: unknown, rel: unknown) {
    const { root, abs, rel: r } = await this.resolve(rootId, rel);
    const st = await stat(abs);
    if (!st.isDirectory()) throw new FsError('Non è una cartella');
    const names = (await readdir(abs)).filter((n) => n !== TRASH || r !== '');
    const entries = [];
    for (const n of names.slice(0, 5000)) {
      try {
        entries.push(await this.entry(path.join(abs, n), n));
      } catch {}
    }
    entries.sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name, 'it', { numeric: true }));
    return { root: root.id, path: r, entries, truncated: names.length > 5000 };
  }

  async mkdir(rootId: unknown, rel: unknown, name: unknown) {
    const dir = await this.resolve(rootId, rel);
    const n = validName(name);
    const target = path.join(dir.abs, n);
    await mkdir(target, { mode: 0o775 }).catch((e: NodeJS.ErrnoException) => {
      throw new FsError(e.code === 'EEXIST' ? 'Esiste già' : e.code === 'EACCES' ? 'Permesso negato' : e.message, e.code === 'EEXIST' ? 409 : 400);
    });
    return { ok: true };
  }

  async rename(rootId: unknown, rel: unknown, newName: unknown) {
    const src = await this.resolve(rootId, rel);
    if (!src.rel) throw new FsError('Non si può rinominare la radice');
    const n = validName(newName);
    const dest = path.join(path.dirname(src.abs), n);
    await this.noClobber(dest);
    await rename(src.abs, dest).catch((e: NodeJS.ErrnoException) => this.fail(e));
    return { ok: true };
  }

  private async noClobber(dest: string) {
    try {
      await lstat(dest);
      throw new FsError('Esiste già un elemento con questo nome', 409);
    } catch (e) {
      if (e instanceof FsError) throw e;
    }
  }

  private fail(e: NodeJS.ErrnoException): never {
    if (e.code === 'EACCES' || e.code === 'EPERM') throw new FsError('Permesso negato', 403);
    if (e.code === 'EXDEV') throw new FsError('Destinazione su un altro filesystem: usa «copia»', 409);
    if (e.code === 'ENOSPC') throw new FsError('Spazio su disco esaurito', 507);
    throw new FsError(e.message, 500);
  }

  /** Sposta, copia o collega (hardlink) elementi in un'altra cartella, anche di un'altra radice. */
  async transfer(op: unknown, rootId: unknown, items: unknown, destRoot: unknown, destRel: unknown) {
    if (op !== 'move' && op !== 'copy' && op !== 'link') throw new FsError('Operazione non valida');
    const list = Array.isArray(items) ? items : [];
    if (!list.length || list.length > 500) throw new FsError('Seleziona da 1 a 500 elementi');
    const dest = await this.resolve(destRoot, destRel);
    if (!(await stat(dest.abs)).isDirectory()) throw new FsError('La destinazione non è una cartella');
    const done: string[] = [];
    for (const it of list) {
      const src = await this.resolve(rootId, it);
      if (!src.rel) throw new FsError('Non si può spostare la radice');
      const target = path.join(dest.abs, path.basename(src.abs));
      if (target === src.abs || target.startsWith(src.abs + path.sep)) throw new FsError('Destinazione dentro l’elemento stesso');
      await this.noClobber(target);
      const st = await lstat(src.abs);
      if (op === 'move') await rename(src.abs, target).catch((e: NodeJS.ErrnoException) => this.fail(e));
      else if (op === 'link') {
        if (!st.isFile()) throw new FsError('L’hardlink si crea solo per i file');
        await link(src.abs, target).catch((e: NodeJS.ErrnoException) => this.fail(e));
      } else {
        if (!st.isFile()) throw new FsError('La copia è supportata solo per i file (per le cartelle usa «sposta»)');
        if (st.size > COPY_MAX) throw new FsError(`File oltre ${Math.round(COPY_MAX / 1024 ** 3)} GB: usa «hardlink» (stesso disco, nessuno spazio extra)`, 413);
        await copyFile(src.abs, target, constants.COPYFILE_EXCL).catch((e: NodeJS.ErrnoException) => this.fail(e));
      }
      done.push(src.rel);
    }
    return { ok: true, done };
  }

  /** Eliminazione = spostamento nel cestino della radice (istantaneo, stesso filesystem, ripristinabile). */
  async trash(rootId: unknown, items: unknown) {
    const root = this.root(rootId);
    const list = Array.isArray(items) ? items : [];
    if (!list.length || list.length > 500) throw new FsError('Seleziona da 1 a 500 elementi');
    const batch = new Date().toISOString().replace(/[:.]/g, '-');
    const bin = path.join(root.path, TRASH, batch);
    await mkdir(bin, { recursive: true, mode: 0o700 });
    const moved: { from: string; name: string }[] = [];
    for (const it of list) {
      const src = await this.resolve(rootId, it);
      if (!src.rel || src.rel === TRASH || src.rel.startsWith(TRASH + '/')) throw new FsError('Elemento non eliminabile');
      const name = path.basename(src.abs);
      await rename(src.abs, path.join(bin, name)).catch((e: NodeJS.ErrnoException) => this.fail(e));
      moved.push({ from: src.rel, name });
    }
    await writeFile(path.join(bin, '.gigi-trash.json'), JSON.stringify({ ts: Date.now(), items: moved }));
    return { ok: true, batch, count: moved.length };
  }

  async trashList(rootId: unknown) {
    const root = this.root(rootId);
    const dir = path.join(root.path, TRASH);
    const out: { batch: string; ts: number; items: { from: string; name: string; size: number | null }[] }[] = [];
    let batches: string[] = [];
    try {
      batches = await readdir(dir);
    } catch {
      return out;
    }
    for (const b of batches.sort().reverse()) {
      try {
        const meta = JSON.parse(await readFile(path.join(dir, b, '.gigi-trash.json'), 'utf8')) as { ts: number; items: { from: string; name: string }[] };
        const items = [];
        for (const i of meta.items) {
          const s = await lstat(path.join(dir, b, i.name)).catch(() => null);
          if (s) items.push({ ...i, size: s.isFile() ? s.size : null });
        }
        if (items.length) out.push({ batch: b, ts: meta.ts, items });
      } catch {}
    }
    return out;
  }

  async restore(rootId: unknown, batch: unknown, name: unknown) {
    const root = this.root(rootId);
    if (typeof batch !== 'string' || !/^[\w-]+$/.test(batch)) throw new FsError('Elemento non valido');
    const n = validName(name);
    const dir = path.join(root.path, TRASH, batch);
    const meta = JSON.parse(await readFile(path.join(dir, '.gigi-trash.json'), 'utf8')) as { items: { from: string; name: string }[] };
    const it = meta.items.find((i) => i.name === n);
    if (!it) throw new FsError('Elemento non trovato nel cestino', 404);
    const dest = await this.resolve(root.id, it.from, false);
    await this.noClobber(dest.abs);
    await mkdir(path.dirname(dest.abs), { recursive: true, mode: 0o775 });
    await rename(path.join(dir, n), dest.abs).catch((e: NodeJS.ErrnoException) => this.fail(e));
    return { ok: true, restored: it.from };
  }

  /** Unica eliminazione definitiva: svuota un lotto del cestino (o tutto). */
  async emptyTrash(rootId: unknown, batch?: unknown) {
    const root = this.root(rootId);
    const dir = path.join(root.path, TRASH);
    if (batch !== undefined && (typeof batch !== 'string' || !/^[\w-]+$/.test(batch))) throw new FsError('Lotto non valido');
    const target = batch ? path.join(dir, batch as string) : dir;
    if (!target.startsWith(path.join(root.path, TRASH))) throw new FsError('Percorso non valido', 403);
    await rm(target, { recursive: true, force: true });
    return { ok: true };
  }

  async search(rootId: unknown, rel: unknown, q: unknown) {
    const term = typeof q === 'string' ? q.trim().toLowerCase() : '';
    if (term.length < 2) throw new FsError('Scrivi almeno 2 caratteri');
    const base = await this.resolve(rootId, rel);
    const results: { path: string; name: string; type: string; size: number | null }[] = [];
    let visited = 0;
    const walk = async (abs: string, r: string, depth: number) => {
      if (depth > 12 || results.length >= 300 || visited > 50_000) return;
      let ents;
      try {
        ents = await readdir(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of ents) {
        visited++;
        if (e.name === TRASH) continue;
        const rp = r ? `${r}/${e.name}` : e.name;
        if (e.name.toLowerCase().includes(term)) {
          const s = await lstat(path.join(abs, e.name)).catch(() => null);
          results.push({ path: rp, name: e.name, type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other', size: s?.isFile() ? s.size : null });
        }
        if (e.isDirectory() && !e.isSymbolicLink()) await walk(path.join(abs, e.name), rp, depth + 1);
      }
    };
    await walk(base.abs, base.rel, 0);
    return { results, truncated: results.length >= 300 };
  }

  async info(rootId: unknown, rel: unknown) {
    const { abs, rel: r } = await this.resolve(rootId, rel);
    const e = await this.entry(abs, path.basename(abs));
    // Altri percorsi dello stesso file (hardlink) nelle radici consentite: utile prima di eliminare
    const others: string[] = [];
    if (e.type === 'file' && (e.links ?? 1) > 1) {
      const st = await stat(abs);
      for (const root of this.roots) {
        const walk = async (dir: string, depth: number) => {
          if (depth > 8 || others.length > 10) return;
          let ents;
          try {
            ents = await readdir(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const x of ents) {
            const p = path.join(dir, x.name);
            if (x.isDirectory() && x.name !== TRASH) await walk(p, depth + 1);
            else if (x.isFile() && p !== abs) {
              const s = await stat(p).catch(() => null);
              if (s && s.ino === st.ino && s.dev === st.dev) others.push(`${root.label}/${path.relative(root.path, p)}`);
            }
          }
        };
        await walk(root.path, 0);
      }
    }
    return { ...e, path: r, hardlinks: others };
  }

  async preview(rootId: unknown, rel: unknown) {
    const { abs } = await this.resolve(rootId, rel);
    const st = await stat(abs);
    if (!st.isFile()) throw new FsError('Non è un file');
    const fh = await open(abs, 'r');
    try {
      const buf = Buffer.alloc(Math.min(st.size, 256 * 1024));
      await fh.read(buf, 0, buf.length, 0);
      if (buf.includes(0)) throw new FsError('File binario: anteprima testuale non disponibile', 415);
      return { text: buf.toString('utf8'), truncated: st.size > buf.length, size: st.size };
    } finally {
      await fh.close();
    }
  }

  async readStream(rootId: unknown, rel: unknown, range?: string) {
    const { abs } = await this.resolve(rootId, rel);
    const st = await stat(abs);
    if (!st.isFile()) throw new FsError('Non è un file');
    let start = 0;
    let end = st.size - 1;
    let partial = false;
    const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
    if (m && (m[1] || m[2])) {
      if (m[1]) start = Number(m[1]);
      if (m[2]) end = m[1] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
      if (!m[1] && m[2]) start = Math.max(0, st.size - Number(m[2]));
      if (start > end || start >= st.size) throw new FsError('Intervallo non valido', 416);
      partial = true;
    }
    return { stream: createReadStream(abs, { start, end }), size: st.size, start, end, partial, name: path.basename(abs) };
  }

  /** Upload: scrittura in un file temporaneo e rinomina atomica; mai sovrascrittura. */
  async write(rootId: unknown, rel: unknown, name: unknown, body: Readable, maxBytes: number) {
    const dir = await this.resolve(rootId, rel);
    const n = validName(name);
    const dest = path.join(dir.abs, n);
    await this.noClobber(dest);
    const tmp = path.join(dir.abs, `.${n}.gigi-upload-${process.pid}-${Date.now()}`);
    let size = 0;
    body.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) body.destroy(new FsError('File troppo grande', 413));
    });
    try {
      await pipeline(body, createWriteStream(tmp, { flags: 'wx', mode: 0o664 }));
      await this.noClobber(dest);
      await rename(tmp, dest);
    } catch (e) {
      await rm(tmp, { force: true });
      if (e instanceof FsError) throw e;
      this.fail(e as NodeJS.ErrnoException);
    }
    return { ok: true, size };
  }
}
