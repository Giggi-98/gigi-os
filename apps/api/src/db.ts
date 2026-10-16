// SQLite via modulo integrato node:sqlite (nessuna dipendenza nativa). Migrazioni numerate append-only.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type DB = DatabaseSync;

export function openDb(dataDir: string, file = 'gigi.sqlite'): DB {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(dataDir, file));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  migrate(db);
  return db;
}

export function migrate(db: DB, dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations')) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  const applied = new Set((db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version));
  const files = readdirSync(dir).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  for (const f of files) {
    const version = Number(f.slice(0, 3));
    if (applied.has(version)) continue;
    const sql = readFileSync(path.join(dir, f), 'utf8');
    // Ricostruzione di tabelle referenziate (procedura ufficiale SQLite): chiavi esterne spente fuori dalla transazione,
    // altrimenti DROP TABLE cancellerebbe a cascata le righe collegate; verifica prima del COMMIT.
    const fkOff = /^--\s*gigi:foreign-keys-off\b/m.test(sql);
    if (fkOff) db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      if (fkOff) {
        const broken = db.prepare('PRAGMA foreign_key_check').all();
        if (broken.length) throw new Error(`chiavi esterne non valide: ${JSON.stringify(broken.slice(0, 3))}`);
      }
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(version, f, Date.now());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`Migrazione ${f} fallita: ${(e as Error).message}`);
    } finally {
      if (fkOff) db.exec('PRAGMA foreign_keys = ON');
    }
  }
}

export function getSetting(db: DB, key: string): string | null {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return r?.value ?? null;
}

export function setSetting(db: DB, key: string, value: string) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
