// Backup di GIGI OS: database (VACUUM INTO, coerente a caldo, verificato con integrity_check) e configurazione,
// impacchettati in .tar.gz senza dipendenze. La chiave master è esclusa salvo richiesta esplicita.
import { DatabaseSync } from 'node:sqlite';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSetting, setSetting, type DB } from './db.js';
import type { Events } from './events.js';
import type { Audit } from './security.js';

/** Header ustar minimale (file regolari, nomi < 100 caratteri). */
function tarEntry(name: string, data: Buffer, mtime = Math.floor(Date.now() / 1000)): Buffer {
  const h = Buffer.alloc(512, 0);
  let prefix = '';
  if (Buffer.byteLength(name) > 99) {
    const cut = name.lastIndexOf('/', 154);
    if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 99) throw new Error(`Nome troppo lungo per l'archivio: ${name}`);
    prefix = name.slice(0, cut);
    name = name.slice(cut + 1);
  }
  h.write(name, 0, 100, 'utf8');
  if (prefix) h.write(prefix, 345, 155, 'utf8');
  h.write('0000600\0', 100);
  h.write('0001750\0', 108);
  h.write('0001750\0', 116);
  h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
  h.write(mtime.toString(8).padStart(11, '0') + '\0', 136);
  h.write('        ', 148);
  h.write('0', 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512, 0);
  return Buffer.concat([h, data, pad]);
}

export type BackupSettings = { enabled: boolean; hour: string; keep: number; includeKey: boolean; includeServices: boolean };

/** Configurazioni di altri servizi: radice montata in sola lettura, file da includere, database SQLite da copiare a caldo. */
export type ServiceSource = { name: string; root: string; include: RegExp; sqlite?: string[] };
const NAME = /^gigi-os-\d{8}-\d{6}\.tar\.gz$/;

export class Backups {
  private running = false;

  constructor(
    private db: DB,
    private dataDir: string,
    private dir: string,
    private extra: { label: string; file: string }[],
    private keyFile: string,
    private events: Events,
    private services: ServiceSource[] = [],
  ) {}

  private async walk(root: string, rel = ''): Promise<string[]> {
    const out: string[] = [];
    let ents;
    try {
      ents = await readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) out.push(...(await this.walk(root, r)));
      else if (e.isFile()) out.push(r);
    }
    return out;
  }

  settings(): BackupSettings {
    const s = JSON.parse(getSetting(this.db, 'backup.settings') ?? '{}') as Partial<BackupSettings>;
    return { enabled: s.enabled ?? true, hour: s.hour ?? '03:30', keep: s.keep ?? 14, includeKey: s.includeKey ?? false, includeServices: s.includeServices ?? true };
  }
  setSettings(s: BackupSettings) {
    setSetting(this.db, 'backup.settings', JSON.stringify(s));
    return this.settings();
  }

  async list() {
    if (!existsSync(this.dir)) return [];
    const out = [];
    for (const f of (await readdir(this.dir)).filter((x) => NAME.test(x))) {
      const s = await stat(path.join(this.dir, f));
      out.push({ name: f, size: s.size, created: s.mtimeMs });
    }
    return out.sort((a, b) => b.created - a.created);
  }

  private snapshot(src: string, tmp: string) {
    const d = new DatabaseSync(src, { readOnly: true });
    try {
      d.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    } finally {
      d.close();
    }
    const c = new DatabaseSync(tmp, { readOnly: true });
    try {
      const r = c.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      if (r.integrity_check !== 'ok') throw new Error(`integrity_check: ${r.integrity_check}`);
    } finally {
      c.close();
    }
  }

  async run(trigger: string) {
    if (this.running) throw Object.assign(new Error('Backup già in corso'), { statusCode: 409 });
    this.running = true;
    const started = Date.now();
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const name = `gigi-os-${stamp}.tar.gz`;
    const work = path.join(this.dir, `.tmp-${stamp}`);
    try {
      await mkdir(work, { recursive: true, mode: 0o700 });
      const parts: Buffer[] = [];
      const manifest: Record<string, unknown> = { created: new Date().toISOString(), trigger, version: '0.2.0', files: [] as string[] };
      const add = (n: string, b: Buffer) => {
        parts.push(tarEntry(n, b));
        (manifest.files as string[]).push(n);
      };
      for (const [label, rel] of [['gigi.sqlite', 'gigi.sqlite'], ['media.sqlite', 'media/media.sqlite']] as const) {
        const src = path.join(this.dataDir, rel);
        if (!existsSync(src)) continue;
        const tmp = path.join(work, label);
        this.snapshot(src, tmp);
        add(`data/${label}`, await readFile(tmp));
      }
      for (const x of this.extra) if (existsSync(x.file)) add(`config/${x.label}`, await readFile(x.file));
      const svcReport: Record<string, number> = {};
      if (this.settings().includeServices) {
        for (const svc of this.services) {
          if (!existsSync(svc.root)) continue;
          let n = 0;
          for (const rel of await this.walk(svc.root)) {
            if (svc.sqlite?.includes(rel)) {
              const tmp = path.join(work, `${svc.name}-${path.basename(rel)}`);
              this.snapshot(path.join(svc.root, rel), tmp);
              add(`services/${svc.name}/${rel}`, await readFile(tmp));
              n++;
            } else if (svc.include.test(rel) && !/-(wal|shm|journal)$/.test(rel)) {
              const st = await stat(path.join(svc.root, rel));
              if (st.size > 50 * 1024 * 1024) continue;
              add(`services/${svc.name}/${rel}`, await readFile(path.join(svc.root, rel)));
              n++;
            }
          }
          svcReport[svc.name] = n;
        }
      }
      manifest.services = svcReport;
      const s = this.settings();
      if (s.includeKey && existsSync(this.keyFile)) add('secrets/master.key', await readFile(this.keyFile));
      manifest.includesMasterKey = s.includeKey;
      add('MANIFEST.json', Buffer.from(JSON.stringify(manifest, null, 2)));
      parts.push(Buffer.alloc(1024, 0));
      const gz = gzipSync(Buffer.concat(parts), { level: 9 });
      await writeFile(path.join(this.dir, name), gz, { mode: 0o600 });
      await this.prune();
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      this.events.add('info', 'backup', `Backup completato (${Math.round(gz.length / 1024)} KB)`, `${name} · ${secs} s`);
      return { name, size: gz.length };
    } catch (e) {
      this.events.add('error', 'backup', 'Backup non riuscito', (e as Error).message);
      throw e;
    } finally {
      await rm(work, { recursive: true, force: true });
      this.running = false;
    }
  }

  private async prune() {
    const keep = this.settings().keep;
    const all = await this.list();
    for (const b of all.slice(keep)) await rm(path.join(this.dir, b.name), { force: true });
  }

  async remove(name: string) {
    if (!NAME.test(name)) throw Object.assign(new Error('Nome non valido'), { statusCode: 400 });
    await rm(path.join(this.dir, name), { force: true });
  }

  file(name: string) {
    if (!NAME.test(name)) throw Object.assign(new Error('Nome non valido'), { statusCode: 400 });
    const p = path.join(this.dir, name);
    if (!existsSync(p)) throw Object.assign(new Error('Backup non trovato'), { statusCode: 404 });
    return p;
  }

  /** Pianificazione: controlla ogni minuto se è l'ora configurata e se oggi non è già stato fatto. */
  schedule(log: (m: string, e?: object) => void) {
    setInterval(() => {
      const s = this.settings();
      if (!s.enabled) return;
      const now = new Date();
      const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const today = now.toISOString().slice(0, 10);
      if (hm !== s.hour || getSetting(this.db, 'backup.lastDay') === today) return;
      setSetting(this.db, 'backup.lastDay', today);
      void this.run('pianificato').catch((e) => log('backup pianificato fallito', { err: (e as Error).message }));
    }, 60_000).unref();
  }
}

export function registerBackups(app: FastifyInstance, b: Backups, audit: Audit, admin: object) {
  app.get('/api/v1/backups', admin, async () => ({ settings: b.settings(), backups: await b.list() }));
  app.post('/api/v1/backups', admin, async (req) => {
    const r = await b.run('manuale');
    audit.log(req, 'backup.run', 'ok', r.name, { size: r.size });
    return r;
  });
  app.put('/api/v1/backups/settings', admin, async (req) => {
    const s = z.object({ enabled: z.boolean(), hour: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), keep: z.number().int().min(1).max(90), includeKey: z.boolean(), includeServices: z.boolean().default(true) }).parse(req.body);
    audit.log(req, 'backup.settings', 'ok', null, s);
    return b.setSettings(s);
  });
  app.delete('/api/v1/backups/:name', admin, async (req) => {
    const { name } = req.params as { name: string };
    await b.remove(name);
    audit.log(req, 'backup.delete', 'ok', name);
    return { ok: true };
  });
  app.get('/api/v1/backups/:name/download', admin, async (req, reply) => {
    const { name } = req.params as { name: string };
    const p = b.file(name);
    audit.log(req, 'backup.download', 'ok', name);
    return reply
      .header('Content-Type', 'application/gzip')
      .header('Content-Disposition', `attachment; filename="${name}"`)
      .header('Cache-Control', 'no-store')
      .send(createReadStream(p));
  });
}
