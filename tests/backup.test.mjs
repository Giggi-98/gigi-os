import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../apps/api/dist/db.js';
import { Backups } from '../apps/api/dist/backup.js';
import { Events } from '../apps/api/dist/events.js';

const base = mkdtempSync(path.join(tmpdir(), 'gigi-bk-'));
after(() => rmSync(base, { recursive: true, force: true }));

test('backup: tar.gz valido, database integri, chiave esclusa di default, retention', async () => {
  const data = path.join(base, 'data');
  const db = openDb(data);
  db.prepare("INSERT INTO settings (key, value) VALUES ('prova', 'valore')").run();
  mkdirSync(path.join(data, 'media'));
  const m = new DatabaseSync(path.join(data, 'media', 'media.sqlite'));
  m.exec("CREATE TABLE t (x TEXT); INSERT INTO t VALUES ('media ok');");
  m.close();
  writeFileSync(path.join(base, '.env'), 'GIGI_PORT=8470\n');
  writeFileSync(path.join(base, 'master.key'), 'a'.repeat(64));
  const events = new Events(db);
  const out = path.join(base, 'backups');
  const b = new Backups(db, data, out, [{ label: 'env', file: path.join(base, '.env') }], path.join(base, 'master.key'), events);

  const r = await b.run('test');
  const listing = execFileSync('tar', ['-tzf', path.join(out, r.name)], { encoding: 'utf8' }).trim().split('\n').sort();
  assert.deepEqual(listing, ['MANIFEST.json', 'config/env', 'data/gigi.sqlite', 'data/media.sqlite']);
  const x = path.join(base, 'x');
  mkdirSync(x);
  execFileSync('tar', ['-xzf', path.join(out, r.name), '-C', x]);
  const restored = new DatabaseSync(path.join(x, 'data/gigi.sqlite'), { readOnly: true });
  assert.equal(restored.prepare("SELECT value FROM settings WHERE key = 'prova'").get().value, 'valore');
  assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  restored.close();
  assert.equal(JSON.parse(readFileSync(path.join(x, 'MANIFEST.json'), 'utf8')).includesMasterKey, false);
  assert.ok(!existsSync(path.join(x, 'secrets')));
  assert.ok(events.list(5).some((e) => e.source === 'backup' && e.level === 'info'));

  b.setSettings({ enabled: true, hour: '03:30', keep: 2, includeKey: true });
  await new Promise((res) => setTimeout(res, 1100));
  const r2 = await b.run('test');
  assert.ok(execFileSync('tar', ['-tzf', path.join(out, r2.name)], { encoding: 'utf8' }).includes('secrets/master.key'));
  await new Promise((res) => setTimeout(res, 1100));
  await b.run('test');
  assert.equal(readdirSync(out).filter((f) => f.endsWith('.tar.gz')).length, 2, 'retention applicata');
  assert.ok(!readdirSync(out).some((f) => f.startsWith('.tmp')), 'nessuna cartella temporanea rimasta');
  assert.throws(() => b.file('../../etc/passwd'), /non valido/);
  db.close();
});
