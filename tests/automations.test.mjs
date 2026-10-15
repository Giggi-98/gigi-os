import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { openDb } from '../apps/api/dist/db.js';
import { Automations, watchDownloads } from '../apps/api/dist/automations.js';
import { Events } from '../apps/api/dist/events.js';
import { buildBlockList } from '../apps/api/dist/ssrf.js';
import { Vault } from '../apps/api/dist/vault.js';

const dir = mkdtempSync(path.join(tmpdir(), 'gigi-auto-'));
let db, a, events, srv, port;
const received = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  db = openDb(dir);
  events = new Events(db);
  const fakeIntegrations = { list: () => [], contextFor: () => { throw new Error('no'); } };
  a = new Automations(db, new Vault(randomBytes(32)), fakeIntegrations, buildBlockList(['127.0.0.0/8']), buildBlockList, () => {});
  events.onAdd = (e) => a.onEvent(e);
  srv = http.createServer(async (req, res) => {
    let b = '';
    for await (const c of req) b += c;
    received.push({ auth: req.headers.authorization, body: JSON.parse(b) });
    res.end('ok');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  port = srv.address().port;
});
after(() => {
  srv.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('regole suggerite create disattivate e senza canali', () => {
  a.seedRules();
  const r = a.rules();
  assert.ok(r.length >= 6);
  assert.ok(r.every((x) => !x.enabled && x.channels.length === 0));
  a.seedRules();
  assert.equal(a.rules().length, r.length, 'idempotente');
});

let ch;
test('canale webhook: segreto cifrato, mai restituito', () => {
  const id = a.createChannel({ type: 'webhook', name: 'Test', config: { url: `http://127.0.0.1:${port}/hook` }, secret: { authHeader: 'Bearer segretissimo' } });
  ch = a.channels().find((c) => c.id === id);
  assert.deepEqual(ch.secretFields, ['authHeader']);
  assert.ok(!JSON.stringify(a.channels()).includes('segretissimo'));
  const row = db.prepare('SELECT secret_enc FROM notify_channels WHERE id = ?').get(id);
  assert.ok(!row.secret_enc.includes('segretissimo'));
});

test('validazione canali', () => {
  assert.throws(() => a.createChannel({ type: 'homeassistant', name: 'x', config: { service: 'light.turn_on' } }), /Servizio HA/);
  assert.throws(() => a.createChannel({ type: 'telegram', name: 'x', config: { chatId: '123' }, secret: { botToken: 'nonvalido' } }), /Telegram/);
  assert.throws(() => a.createChannel({ type: 'ntfy', name: 'x', config: { topic: 'a b/c' } }), /Topic/);
});

test('regola: sorgente, livello minimo, filtro testo → invio con autenticazione', async () => {
  a.saveRule({ name: 'Container', sources: ['docker'], minLevel: 'warning', matchText: null, channels: [ch.id], throttleMin: 30 });
  events.add('info', 'docker', 'jellyfin avviato');
  events.add('warning', 'sistema', 'altro');
  events.add('error', 'docker', 'jellyfin è diventato unhealthy', 'dettaglio');
  await wait(300);
  assert.equal(received.length, 1);
  assert.equal(received[0].auth, 'Bearer segretissimo');
  assert.equal(received[0].body.title, 'jellyfin è diventato unhealthy');
  assert.equal(received[0].body.level, 'error');
});

test('antiripetizione: stesso titolo entro la finestra non viene reinviato', async () => {
  events.add('error', 'docker', 'jellyfin è diventato unhealthy');
  await wait(300);
  assert.equal(received.length, 1);
  const h = a.history();
  assert.ok(h.some((x) => x.status === 'throttled'));
  assert.ok(h.some((x) => x.status === 'sent'));
});

test('canale verso indirizzo privato non autorizzato: invio fallito e registrato', async () => {
  const bad = a.createChannel({ type: 'webhook', name: 'Interno', config: { url: 'http://10.1.2.3/x' } });
  a.saveRule({ name: 'Tutto', sources: [], minLevel: 'info', matchText: 'privato', channels: [bad], throttleMin: 0 });
  events.add('info', 'media', 'test privato');
  await wait(300);
  const f = a.history().find((x) => x.title === 'test privato');
  assert.equal(f.status, 'failed');
  assert.match(f.error, /non consentita/);
});

test('download completati: niente notifiche retroattive, poi un evento per hash', async () => {
  let torrents = [{ hash: 'a', name: 'Vecchio', complete: true, size: 1, category: '' }];
  let seen = [];
  const integ = { list: () => [{ id: 'q', type: 'qbittorrent', enabled: true, status: 'online' }], resource: async () => torrents };
  const w = watchDownloads(integ, events, () => seen, (h) => (seen = h));
  await w();
  assert.ok(!events.list(50).some((e) => e.title.includes('Vecchio')));
  torrents = [...torrents, { hash: 'b', name: 'Nuovo', complete: true, size: 1, category: 'Film' }, { hash: 'c', name: 'In corso', complete: false, size: 1, category: '' }];
  await w();
  await w();
  const ev = events.list(50).filter((e) => e.source === 'download');
  assert.deepEqual(ev.map((e) => e.title), ['Download completato: Nuovo']);
});
