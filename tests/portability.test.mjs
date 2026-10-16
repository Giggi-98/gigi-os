// Fase A della repo pubblica: niente valori di un singolo server nel codice (rete LAN e indirizzi web ricavati).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { lanOf } from '../apps/api/dist/config.js';
import { Integrations } from '../apps/api/dist/integrations.js';
import { openDb } from '../apps/api/dist/db.js';
import { Events } from '../apps/api/dist/events.js';
import { buildBlockList } from '../apps/api/dist/ssrf.js';
import { Vault } from '../apps/api/dist/vault.js';

test('lanOf: rete dell’interfaccia con l’IP di ascolto', () => {
  const ifaces = { eth0: [{ address: '192.168.1.20', family: 'IPv4', cidr: '192.168.1.20/24' }], wg0: [{ address: '10.8.0.2', family: 'IPv4', cidr: '10.8.0.2/16' }] };
  assert.deepEqual(lanOf('192.168.1.20', ifaces), ['192.168.1.0/24']);
  assert.deepEqual(lanOf('10.8.0.2', ifaces), ['10.8.0.0/16']);
  assert.deepEqual(lanOf('172.16.0.1', ifaces), [], 'IP non presente: nessuna rete aggiunta');
  assert.deepEqual(lanOf(undefined, ifaces), []);
});

test('indirizzo web: 127.0.0.1 → IP di GIGI OS solo per le app che rispondono in LAN', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gigi-port-'));
  const db = openDb(dir);
  try {
    const i = new Integrations(db, new Vault(randomBytes(32)), buildBlockList(['127.0.0.0/8']), new Events(db), '192.168.1.20');
    assert.equal(i.lanUrl('jellyfin', 'http://127.0.0.1:8096'), 'http://192.168.1.20:8096');
    assert.equal(i.lanUrl('homeassistant', 'http://localhost:8123/'), 'http://192.168.1.20:8123');
    assert.equal(i.lanUrl('navidrome', 'http://127.0.0.1:4533'), null, 'Navidrome di solito ascolta solo in locale');
    assert.equal(i.lanUrl('jellyfin', 'http://192.168.1.30:8096'), null, 'già un indirizzo LAN: resta com’è');
    const local = new Integrations(db, new Vault(randomBytes(32)), buildBlockList(['127.0.0.0/8']), new Events(db), '127.0.0.1');
    assert.equal(local.lanUrl('jellyfin', 'http://127.0.0.1:8096'), null, 'GIGI OS in ascolto solo in locale: nessuna sostituzione');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
