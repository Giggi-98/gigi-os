// Motore media: rileva i download completati, li analizza, propone una destinazione e importa con hardlink.
// Regole ferree: mai spostare, rinominare o cancellare la sorgente; mai sovrascrivere; mai toccare file incompleti.
import { createHash } from 'node:crypto';
import { access, constants, link, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { jellyfin, mapPath, qbt, HttpError, type Creds, type QbtTorrent } from './clients.js';
import { decide, LIBRARY_LABEL, type Candidate, type Libraries, type Override, type Plan, type Reason } from './decide.js';
import { parseReleaseName, SUB_EXT, VIDEO_EXT, type Parsed } from './parse.js';
import { probe, type Probe } from './probe.js';

export type Status =
  | 'waiting'
  | 'review'
  | 'ready'
  | 'conflict'
  | 'importing'
  | 'imported'
  | 'indexed'
  | 'ignored'
  | 'error'
  | 'missing';

type Row = {
  id: string;
  torrent_hash: string;
  torrent_name: string;
  category: string | null;
  rel_path: string;
  src_path: string;
  size: number;
  mtime: number | null;
  ino: number | null;
  dev: number | null;
  first_seen: number;
  stable_since: number | null;
  status: Status;
  kind: string | null;
  anime: number;
  parsed: string | null;
  probe: string | null;
  match: string | null;
  plan: string | null;
  confidence: number | null;
  reasons: string | null;
  override: string | null;
  error: string | null;
  jf_item_id: string | null;
  jf_name: string | null;
  imported_at: number | null;
  indexed_at: number | null;
  verify_attempts: number;
  updated_at: number;
};

const BAD_STATES = new Set(['checkingDL', 'checkingUP', 'checkingResumeData', 'moving', 'missingFiles', 'error', 'allocating', 'metaDL', 'forcedMetaDL']);
const STABLE_MS = Number(process.env.GIGI_MEDIA_STABLE_MS ?? 60_000);
const MIN_VIDEO_BYTES = 50 * 1024 * 1024;
/** Incrementare quando cambia la logica di analisi: gli elementi non importati vengono rianalizzati. */
export const ENGINE_VERSION = '2';

export type ScanReport = { detected: number; analyzed: number; imported: string[]; indexed: string[]; errors: string[] };

export class Engine {
  db: DatabaseSync;
  private busy = false;
  private inodeCache: { t: number; map: Map<string, string> } | null = null;

  /** Indice inode → percorso dei file già presenti nelle librerie (rileva import precedenti con altro nome). */
  private async libraryInodes(): Promise<Map<string, string>> {
    if (this.inodeCache && Date.now() - this.inodeCache.t < 60_000) return this.inodeCache.map;
    const map = new Map<string, string>();
    const walk = async (dir: string, depth: number) => {
      if (depth > 6) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p, depth + 1);
        else if (e.isFile() && VIDEO_EXT.has(path.extname(e.name).slice(1).toLowerCase())) {
          try {
            const st = await stat(p);
            map.set(`${st.dev}:${st.ino}`, p);
          } catch {}
        }
      }
    };
    for (const root of new Set(Object.values(this.libraries))) await walk(root, 0);
    this.inodeCache = { t: Date.now(), map };
    return map;
  }

  constructor(dataDir: string, public libraries: Libraries, private log: (l: string, m: string, e?: object) => void) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'media.sqlite'));
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
    this.migrate();
    if (this.setting('engineVersion', '') !== ENGINE_VERSION) {
      const n = this.db.prepare("UPDATE media_items SET status = 'waiting', stable_since = 0 WHERE status IN ('ready', 'review', 'conflict', 'error')").run().changes;
      this.db.prepare("INSERT INTO media_settings (key, value) VALUES ('engineVersion', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(ENGINE_VERSION);
      if (n) this.log('info', 'motore aggiornato: elementi da rianalizzare', { n: Number(n), versione: ENGINE_VERSION });
    }
  }

  private migrate() {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
    const done = new Set((this.db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version));
    for (const f of readdirSync(dir).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort()) {
      const v = Number(f.slice(0, 3));
      if (done.has(v)) continue;
      this.db.exec('BEGIN');
      try {
        this.db.exec(readFileSync(path.join(dir, f), 'utf8'));
        this.db.prepare('INSERT INTO schema_migrations VALUES (?,?,?)').run(v, f, Date.now());
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
  }

  // ───────── impostazioni ─────────
  setting(key: string, def: string) {
    return (this.db.prepare('SELECT value FROM media_settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? def;
  }
  settings() {
    return { autoImport: this.setting('autoImport', 'false') === 'true', threshold: Number(this.setting('threshold', '85')), lastScan: Number(this.setting('lastScan', '0')) || null };
  }
  setSettings(s: { autoImport?: boolean; threshold?: number }) {
    const put = this.db.prepare('INSERT INTO media_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    if (s.autoImport !== undefined) put.run('autoImport', String(s.autoImport));
    if (s.threshold !== undefined) put.run('threshold', String(Math.max(60, Math.min(100, Math.round(s.threshold)))));
    return this.settings();
  }

  history(itemId: string, actor: string, action: string, details?: unknown) {
    this.db
      .prepare('INSERT INTO media_history (item_id, ts, actor, action, details) VALUES (?,?,?,?,?)')
      .run(itemId, Date.now(), actor, action, details === undefined ? null : JSON.stringify(details));
  }

  private update(id: string, fields: Partial<Row>) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    this.db
      .prepare(`UPDATE media_items SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...(keys.map((k) => (fields as Record<string, unknown>)[k]) as (string | number | null)[]), Date.now(), id);
  }

  private row(id: string): Row {
    const r = this.db.prepare('SELECT * FROM media_items WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw Object.assign(new Error('Elemento non trovato'), { status: 404 });
    return r;
  }

  // ───────── viste ─────────
  view(r: Row) {
    const plan = r.plan ? (JSON.parse(r.plan) as Plan & { subtitles?: { src: string; dest: string }[] }) : null;
    return {
      id: r.id,
      torrentHash: r.torrent_hash,
      torrentName: r.torrent_name,
      category: r.category,
      fileName: path.basename(r.rel_path),
      relPath: r.rel_path,
      srcPath: r.src_path,
      size: r.size,
      status: r.status,
      kind: r.kind,
      anime: !!r.anime,
      confidence: r.confidence,
      reasons: r.reasons ? (JSON.parse(r.reasons) as Reason[]) : [],
      parsed: r.parsed ? (JSON.parse(r.parsed) as Parsed) : null,
      probe: r.probe ? (JSON.parse(r.probe) as Probe) : null,
      match: r.match ? JSON.parse(r.match) : null,
      plan,
      libraryLabel: plan ? LIBRARY_LABEL[plan.library] : null,
      override: r.override ? (JSON.parse(r.override) as Override) : null,
      error: r.error,
      jellyfin: r.jf_item_id ? { id: r.jf_item_id, name: r.jf_name } : null,
      firstSeen: r.first_seen,
      importedAt: r.imported_at,
      indexedAt: r.indexed_at,
      updatedAt: r.updated_at,
      hardlinked: r.status === 'imported' || r.status === 'indexed',
    };
  }

  list(status?: string, limit = 200) {
    const rows = status
      ? (this.db.prepare('SELECT * FROM media_items WHERE status = ? ORDER BY updated_at DESC LIMIT ?').all(status, limit) as Row[])
      : (this.db.prepare('SELECT * FROM media_items ORDER BY updated_at DESC LIMIT ?').all(limit) as Row[]);
    return rows.map((r) => this.view(r));
  }

  detail(id: string) {
    return {
      ...this.view(this.row(id)),
      history: this.db.prepare('SELECT ts, actor, action, details FROM media_history WHERE item_id = ? ORDER BY ts DESC LIMIT 100').all(id),
    };
  }

  summary() {
    const counts = Object.fromEntries(
      (this.db.prepare('SELECT status, COUNT(*) AS n FROM media_items GROUP BY status').all() as { status: string; n: number }[]).map((r) => [r.status, r.n]),
    );
    return { counts, settings: this.settings(), libraries: this.libraries, busy: this.busy };
  }

  async librariesCheck() {
    const out: { key: string; label: string; path: string; exists: boolean; writable: boolean; dev: number | null }[] = [];
    for (const [k, p] of Object.entries(this.libraries)) {
      try {
        const s = await stat(p);
        const writable = await access(p, constants.W_OK).then(() => true, () => false);
        out.push({ key: k, label: LIBRARY_LABEL[k as keyof Libraries], path: p, exists: s.isDirectory(), writable, dev: Number(s.dev) });
      } catch {
        out.push({ key: k, label: LIBRARY_LABEL[k as keyof Libraries], path: p, exists: false, writable: false, dev: null });
      }
    }
    return out;
  }

  // ───────── ciclo principale ─────────
  async scan(creds: Creds, actor = 'sistema'): Promise<ScanReport> {
    if (this.busy) return { detected: 0, analyzed: 0, imported: [], indexed: [], errors: ['scansione già in corso'] };
    this.busy = true;
    const report: ScanReport = { detected: 0, analyzed: 0, imported: [], indexed: [], errors: [] };
    try {
      if (creds.qbt) await this.detect(creds, report);
      for (const r of this.db.prepare("SELECT * FROM media_items WHERE status = 'waiting'").all() as Row[]) {
        try {
          if (await this.analyze(r, creds)) report.analyzed++;
        } catch (e) {
          report.errors.push(`${path.basename(r.rel_path)}: ${(e as Error).message}`);
        }
      }
      const s = this.settings();
      if (s.autoImport) {
        for (const r of this.db.prepare("SELECT * FROM media_items WHERE status = 'ready' AND confidence >= ?").all(s.threshold) as Row[]) {
          try {
            await this.importItem(r.id, creds, 'automatico');
            report.imported.push(path.basename(JSON.parse(r.plan!).dest));
          } catch (e) {
            report.errors.push(`${path.basename(r.rel_path)}: ${(e as Error).message}`);
          }
        }
      }
      if (creds.jf) report.indexed.push(...(await this.verify(creds)));
      this.db.prepare("INSERT INTO media_settings (key, value) VALUES ('lastScan', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(Date.now()));
    } catch (e) {
      report.errors.push((e as Error).message);
      this.log('error', 'scan fallita', { err: (e as Error).message, actor });
    } finally {
      this.busy = false;
    }
    return report;
  }

  private async detect(creds: Creds, report: ScanReport) {
    const torrents = await qbt.torrents(creds.qbt!);
    const now = Date.now();
    for (const t of torrents) {
      const complete = t.progress >= 1 && t.amount_left === 0 && !BAD_STATES.has(t.state);
      if (!complete) continue;
      const hostSave = mapPath(t.save_path.replace(/\/+$/, ''), creds.qbtPathMap);
      if (!hostSave) {
        report.errors.push(`${t.name}: percorso ${t.save_path} non mappabile sull'host`);
        continue;
      }
      let files;
      try {
        files = await qbt.files(creds.qbt!, t.hash);
      } catch (e) {
        report.errors.push(`${t.name}: ${(e as Error).message}`);
        continue;
      }
      for (const f of files) {
        const ext = path.extname(f.name).slice(1).toLowerCase();
        if (!VIDEO_EXT.has(ext) || f.size < MIN_VIDEO_BYTES || /(^|[\s._\-/])sample([\s._\-/]|$)/i.test(f.name) || f.progress < 1 || f.priority === 0) continue;
        const src = path.join(hostSave, f.name);
        if (!src.startsWith(hostSave + path.sep)) continue;
        const id = createHash('sha1').update(`${t.hash}:${f.name}`).digest('hex').slice(0, 20);
        const exists = this.db.prepare('SELECT id, status, size, mtime, stable_since FROM media_items WHERE id = ?').get(id) as
          | Pick<Row, 'id' | 'status' | 'size' | 'mtime' | 'stable_since'>
          | undefined;
        let st;
        try {
          st = await stat(src);
        } catch {
          if (exists && !['imported', 'indexed', 'ignored'].includes(exists.status)) this.update(id, { status: 'missing', error: 'File non trovato sul disco' });
          continue;
        }
        const mtime = Math.floor(st.mtimeMs);
        if (!exists) {
          this.db
            .prepare(
              `INSERT INTO media_items (id, torrent_hash, torrent_name, category, rel_path, src_path, size, mtime, ino, dev, first_seen, stable_since, status, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'waiting', ?)`,
            )
            .run(id, t.hash, t.name, t.category || null, f.name, src, st.size, mtime, Number(st.ino), Number(st.dev), now, now, now);
          this.history(id, 'sistema', 'rilevato', { torrent: t.name, categoria: t.category || null });
          report.detected++;
        } else if (exists.size !== st.size || exists.mtime !== mtime) {
          // Il file è cambiato: ricomincia la finestra di stabilità
          this.update(id, { size: st.size, mtime, ino: Number(st.ino), dev: Number(st.dev), stable_since: now, ...(exists.status === 'waiting' ? {} : {}) });
        }
      }
    }
  }

  private async gather(r: Row, creds: Creds, parsed: Parsed, ov: Override | null) {
    const kind = ov?.kind ?? parsed.kind;
    const title = ov?.title ?? parsed.title;
    const year = ov?.year !== undefined ? ov.year : parsed.year;
    const local: Candidate[] = [];
    const remote: Candidate[] = [];
    if (creds.jf && title) {
      const toHost = (p?: string) => (p ? mapPath(p, creds.jfPathMap.map((m) => ({ from: m.jf, to: m.host }))) : null);
      if (kind === 'episode') {
        for (const it of await jellyfin.findLocal(creds.jf, 'Series', title.split(' ').slice(0, 4).join(' ')).catch(() => [])) {
          local.push({ name: it.Name, year: it.ProductionYear ?? null, ids: it.ProviderIds ?? {}, source: 'Jellyfin', hostPath: toHost(it.Path) });
        }
      } else {
        for (const it of await jellyfin.findLocal(creds.jf, 'Movie', title.split(' ').slice(0, 4).join(' ')).catch(() => [])) {
          local.push({ name: it.Name, year: it.ProductionYear ?? null, ids: it.ProviderIds ?? {}, source: 'Jellyfin', hostPath: toHost(it.Path) });
        }
      }
      const rs = await jellyfin.remoteSearch(creds.jf, kind === 'movie' ? 'Movie' : 'Series', title, year ?? undefined);
      for (const x of rs.slice(0, 8)) remote.push({ name: x.Name, year: x.ProductionYear ?? null, ids: x.ProviderIds ?? {}, source: x.SearchProviderName ?? 'provider' });
    }
    return { local, remote };
  }

  private async subtitlesFor(src: string, destBase: string) {
    const dir = path.dirname(src);
    const stem = path.basename(src, path.extname(src));
    const out: { src: string; dest: string }[] = [];
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch {
      return out;
    }
    for (const e of entries) {
      const ext = path.extname(e).slice(1).toLowerCase();
      if (!SUB_EXT.has(ext) || !e.startsWith(stem)) continue;
      const middle = e.slice(stem.length, e.length - ext.length - 1).replace(/^[.\s_-]+/, '');
      const tag = middle ? `.${middle.replace(/[^\w.-]/g, '').slice(0, 20)}` : '';
      out.push({ src: path.join(dir, e), dest: `${destBase}${tag}.${ext}` });
    }
    return out;
  }

  /** Analizza un elemento stabile. Ritorna true se ha prodotto una proposta. */
  async analyze(r: Row, creds: Creds, actor = 'sistema'): Promise<boolean> {
    if (r.status === 'waiting' && r.stable_since && Date.now() - r.stable_since < STABLE_MS) return false;
    const parsed = parseReleaseName(path.basename(r.rel_path));
    // Le cartelle dei pacchetti contengono spesso informazioni utili (es. stagione): si usano solo se il file ne è privo
    if (!parsed.title && r.rel_path.includes('/')) {
      const folder = parseReleaseName(r.rel_path.split('/')[0]);
      parsed.title = folder.title;
      parsed.notes.push('titolo dedotto dalla cartella del torrent');
    }
    const ov = r.override ? (JSON.parse(r.override) as Override) : null;
    const pr = await probe(r.src_path);
    let gathered = { local: [] as Candidate[], remote: [] as Candidate[] };
    let lookupError: string | null = null;
    try {
      gathered = await this.gather(r, creds, parsed, ov);
    } catch (e) {
      lookupError = (e as Error).message;
    }
    const d = decide({ fileName: path.basename(r.rel_path), ext: parsed.ext, category: r.category, parsed, probe: pr, ...gathered, libraries: this.libraries, override: ov });
    if (lookupError) d.reasons.push({ delta: 0, text: `Ricerca metadati non disponibile: ${lookupError}` });

    let status: Status = d.plan ? (d.confidence >= this.settings().threshold ? 'ready' : 'review') : 'review';
    let error: string | null = d.blocking;
    let plan: (Plan & { subtitles: { src: string; dest: string }[] }) | null = null;
    if (d.plan) {
      const destBase = d.plan.dest.slice(0, -path.extname(d.plan.dest).length);
      plan = { ...d.plan, subtitles: await this.subtitlesFor(r.src_path, destBase) };
      // Duplicati 1: lo stesso file (stesso inode) è già in libreria, magari con un altro nome?
      const ss0 = await stat(r.src_path).catch(() => null);
      const already = ss0 ? (await this.libraryInodes()).get(`${ss0.dev}:${ss0.ino}`) : undefined;
      if (already && path.resolve(already) !== path.resolve(d.plan.dest)) {
        status = 'imported';
        plan = { ...plan, dest: already, folder: path.dirname(already), subtitles: [] };
        d.reasons.push({ delta: 0, text: `Già presente in libreria con un altro nome: ${already} (stesso file, nessun duplicato creato)` });
      }
      // Duplicati 2: la destinazione esiste già?
      if (!already || path.resolve(already) === path.resolve(d.plan.dest)) try {
        const ds = await stat(d.plan.dest);
        const ss = await stat(r.src_path);
        if (ds.ino === ss.ino && ds.dev === ss.dev) {
          status = 'imported';
          d.reasons.push({ delta: 0, text: 'Già importato in precedenza (stesso file, hardlink esistente)' });
        } else {
          status = 'conflict';
          error = `Esiste già un file diverso in destinazione (${Math.round(Number(ds.size) / 1048576)} MB)`;
        }
      } catch {}
      if (lookupError && status === 'ready') status = 'review';
    }
    this.update(r.id, {
      status,
      kind: d.plan?.kind ?? parsed.kind,
      anime: d.plan?.anime ? 1 : 0,
      parsed: JSON.stringify(parsed),
      probe: JSON.stringify(pr),
      match: JSON.stringify({ ...gathered, chosen: d.plan?.matched ?? null }),
      plan: plan ? JSON.stringify(plan) : null,
      confidence: d.confidence,
      reasons: JSON.stringify(d.reasons),
      error,
      ...(status === 'imported' && !r.imported_at ? { imported_at: Date.now() } : {}),
    });
    this.history(r.id, actor, 'analizzato', { confidenza: d.confidence, stato: status, destinazione: plan?.dest ?? null });
    return true;
  }

  async reanalyze(id: string, creds: Creds, actor: string) {
    const r = this.row(id);
    if (['imported', 'indexed', 'importing'].includes(r.status)) throw Object.assign(new Error('Elemento già importato'), { status: 409 });
    await this.analyze({ ...r, status: 'review', stable_since: 0 }, creds, actor);
    return this.detail(id);
  }

  async setOverride(id: string, ov: Override, creds: Creds, actor: string) {
    const r = this.row(id);
    if (['imported', 'indexed', 'importing'].includes(r.status)) throw Object.assign(new Error('Elemento già importato: correzione non applicabile'), { status: 409 });
    const clean: Override = { by: actor };
    if (ov.kind === 'movie' || ov.kind === 'episode') clean.kind = ov.kind;
    if (typeof ov.anime === 'boolean') clean.anime = ov.anime;
    if (typeof ov.title === 'string' && ov.title.trim()) clean.title = ov.title.trim().slice(0, 150);
    if (ov.year === null || (Number.isInteger(ov.year) && ov.year! > 1880 && ov.year! < 2100)) clean.year = ov.year;
    if (Number.isInteger(ov.season) && ov.season! >= 0 && ov.season! < 100) clean.season = ov.season;
    if (Array.isArray(ov.episodes) && ov.episodes.length && ov.episodes.every((e) => Number.isInteger(e) && e >= 0 && e < 10000)) clean.episodes = ov.episodes.slice(0, 50);
    this.update(id, { override: JSON.stringify(clean) });
    this.history(id, actor, 'corretto', clean);
    await this.analyze({ ...this.row(id), status: 'review', stable_since: 0 }, creds, actor);
    return this.detail(id);
  }

  setIgnored(id: string, ignored: boolean, actor: string) {
    const r = this.row(id);
    if (['imported', 'indexed', 'importing'].includes(r.status)) throw Object.assign(new Error('Elemento già importato'), { status: 409 });
    this.update(id, { status: ignored ? 'ignored' : 'waiting', stable_since: 0 });
    this.history(id, actor, ignored ? 'ignorato' : 'ripristinato');
    return this.detail(id);
  }

  /** Importazione con hardlink. Idempotente: un secondo tentativo non crea duplicati. */
  async importItem(id: string, creds: Creds, actor: string) {
    const r = this.row(id);
    if (!['ready', 'review'].includes(r.status)) throw Object.assign(new Error(`Stato «${r.status}»: importazione non consentita`), { status: 409 });
    if (!r.plan) throw Object.assign(new Error('Nessuna destinazione proposta'), { status: 409 });
    const plan = JSON.parse(r.plan) as Plan & { subtitles: { src: string; dest: string }[] };
    const root = path.resolve(plan.libraryRoot);
    if (!path.resolve(plan.dest).startsWith(root + path.sep)) throw Object.assign(new Error('Destinazione fuori dalla libreria'), { status: 400 });

    // Il torrent deve essere ancora completo e il file identico a quello analizzato
    if (creds.qbt) {
      const t = (await qbt.torrents(creds.qbt)).find((x: QbtTorrent) => x.hash === r.torrent_hash);
      if (!t || t.progress < 1 || t.amount_left > 0 || BAD_STATES.has(t.state)) throw Object.assign(new Error('Il torrent non risulta completo in qBittorrent'), { status: 409 });
    }
    const ss = await stat(r.src_path).catch(() => null);
    if (!ss) {
      this.update(id, { status: 'missing', error: 'Sorgente non trovata' });
      throw Object.assign(new Error('Sorgente non trovata'), { status: 409 });
    }
    if (ss.size !== r.size) throw Object.assign(new Error('Il file è cambiato dopo l’analisi: rianalizza'), { status: 409 });
    const rootStat = await stat(root).catch(() => null);
    if (!rootStat) throw Object.assign(new Error(`Libreria ${root} non trovata`), { status: 409 });
    if (rootStat.dev !== ss.dev) {
      throw Object.assign(new Error('Sorgente e libreria su filesystem diversi: l’hardlink non è possibile (copia non eseguita automaticamente)'), { status: 409 });
    }

    const already = (await this.libraryInodes()).get(`${ss.dev}:${ss.ino}`);
    if (already) {
      this.update(id, { status: 'imported', imported_at: Date.now(), plan: JSON.stringify({ ...plan, dest: already, folder: path.dirname(already), subtitles: [] }) });
      this.history(id, actor, 'già presente in libreria: nessun nuovo collegamento', { percorso: already });
      return this.detail(id);
    }
    this.update(id, { status: 'importing', error: null });
    this.history(id, actor, 'importazione avviata', { destinazione: plan.dest });
    const created: string[] = [];
    try {
      await mkdir(path.dirname(plan.dest), { recursive: true, mode: 0o775 });
      try {
        await link(r.src_path, plan.dest);
        created.push(plan.dest);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const ds = await stat(plan.dest);
        if (ds.ino !== ss.ino) throw Object.assign(new Error('In destinazione esiste già un file diverso'), { code: 'CONFLICT' });
      }
      for (const sub of plan.subtitles ?? []) {
        if (!path.resolve(sub.dest).startsWith(root + path.sep)) continue;
        try {
          await link(sub.src, sub.dest);
          created.push(sub.dest);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') this.history(id, actor, 'sottotitolo non collegato', { file: sub.src, errore: (e as Error).message });
        }
      }
    } catch (e) {
      const conflict = (e as { code?: string }).code === 'CONFLICT';
      if ((e as NodeJS.ErrnoException).code === 'EACCES' || (e as NodeJS.ErrnoException).code === 'EPERM') {
        (e as Error).message = `Permesso negato su ${path.dirname(plan.dest)}: la cartella non è scrivibile dal motore media (nessun file creato)`;
      }
      this.update(id, { status: conflict ? 'conflict' : 'error', error: (e as Error).message });
      this.history(id, actor, 'importazione fallita', { errore: (e as Error).message });
      throw Object.assign(new Error((e as Error).message), { status: conflict ? 409 : 500 });
    }
    this.inodeCache = null;
    this.update(id, { status: 'imported', imported_at: Date.now(), verify_attempts: 0 });
    this.history(id, actor, 'importato (hardlink)', { file: created });

    if (creds.jf) {
      const jfPath = mapPath(plan.dest, creds.jfPathMap.map((m) => ({ from: m.host, to: m.jf })));
      if (jfPath) {
        try {
          await jellyfin.mediaUpdated(creds.jf, [jfPath]);
          this.history(id, actor, 'Jellyfin notificato', { percorso: jfPath });
        } catch (e) {
          this.history(id, actor, 'notifica Jellyfin fallita', { errore: (e as Error).message });
        }
      } else this.history(id, actor, 'percorso Jellyfin non mappabile', { destinazione: plan.dest });
    }
    return this.detail(id);
  }

  /** Verifica che gli elementi importati compaiano in Jellyfin (e quindi in Apollo). */
  private async verify(creds: Creds) {
    const pending = this.db.prepare("SELECT * FROM media_items WHERE status = 'imported'").all() as Row[];
    if (!pending.length) return [];
    let items;
    try {
      items = await jellyfin.recentByPath(creds.jf!);
    } catch (e) {
      if (e instanceof HttpError) this.log('warn', 'verifica Jellyfin fallita', { err: e.message });
      return [];
    }
    const byPath = new Map(items.filter((i) => i.Path).map((i) => [i.Path!, i]));
    const done: string[] = [];
    let needRefresh = false;
    for (const r of pending) {
      const plan = JSON.parse(r.plan!) as Plan;
      const jfPath = mapPath(plan.dest, creds.jfPathMap.map((m) => ({ from: m.host, to: m.jf })));
      const hit = jfPath ? byPath.get(jfPath) : undefined;
      if (hit) {
        this.update(r.id, { status: 'indexed', jf_item_id: hit.Id, jf_name: hit.Name, indexed_at: Date.now() });
        this.history(r.id, 'sistema', 'indicizzato da Jellyfin', { titolo: hit.Name });
        done.push(hit.Name);
      } else {
        const attempts = r.verify_attempts + 1;
        this.update(r.id, { verify_attempts: attempts });
        if (attempts === 5) needRefresh = true;
        if (attempts === 30) this.history(r.id, 'sistema', 'non ancora indicizzato dopo 30 controlli', { percorso: jfPath });
      }
    }
    if (needRefresh) {
      await jellyfin.refreshAll(creds.jf!).catch(() => undefined);
      this.log('info', 'richiesta scansione completa Jellyfin (fallback)');
    }
    return done;
  }
}
