// Launcher delle app (D-030): parsing, stato, favicon, proposte, controllo HTTP, permessi e header delle icone.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { iconCandidates, Launcher, pageTitle, statusFor } from '../apps/api/dist/launcher.js';
import { buildApp } from '../apps/api/dist/app.js';
import { openDb } from '../apps/api/dist/db.js';
import { Events } from '../apps/api/dist/events.js';
import { Integrations } from '../apps/api/dist/integrations.js';
import { Audit, LoginLimiter, Sessions } from '../apps/api/dist/security.js';
import { buildBlockList } from '../apps/api/dist/ssrf.js';
import { Vault } from '../apps/api/dist/vault.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(40)]);
let server, port, dir, db;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<html><head><title>Mia App &amp; co</title><link rel="icon" href="/i.png"></head></html>');
    }
    if (req.url === '/r') return res.writeHead(302, { location: '/web/' }).end();
    if (req.url === '/x') return res.writeHead(302, { location: 'http://127.0.0.2:9/web/' }).end();
    if (req.url === '/web/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<title>Dopo il redirect</title><link rel="shortcut icon" href="ico.png">');
    }
    if (req.url === '/i.png' || req.url === '/web/ico.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(PNG);
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  dir = mkdtempSync(path.join(tmpdir(), 'gigi-launcher-'));
  db = openDb(dir);
});

after(() => {
  server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('pageTitle: entità decodificate, spazi compattati, assente → null', () => {
  assert.equal(pageTitle('<title>\n Jellyfin &amp; amici </title>'), 'Jellyfin & amici');
  assert.equal(pageTitle('<html></html>'), null);
});

test('iconCandidates: apple-touch prima, URL relativi risolti, /favicon.ico in coda, data: esclusi', () => {
  const html = '<link rel="icon" href="/a.png"><link rel="apple-touch-icon" href="b.png"><link rel="icon" href="data:image/png;base64,xx"><link rel="stylesheet" href="/s.css">';
  const c = iconCandidates(html, 'http://x.lan:8096/web/');
  assert.deepEqual(c.slice(0, 3), ['http://x.lan:8096/web/b.png', 'http://x.lan:8096/a.png', 'http://x.lan:8096/favicon.ico']);
  assert.ok(c.includes('http://x.lan:8096/web/favicon.ico'), 'percorso di Jellyfin quando la home reindirizza');
  assert.ok(!c.some((x) => x.startsWith('data:')));
});

test('statusFor: integrazione, poi container, poi controllo HTTP', () => {
  const ints = new Map([['i1', { enabled: true, status: 'unauthorized' }], ['i2', { enabled: true, status: 'offline' }]]);
  const cs = new Map([['c1', { name: 'c1', state: 'running', health: 'unhealthy' }], ['c2', { name: 'c2', state: 'exited', health: null }]]);
  assert.equal(statusFor({ integration_id: 'i1', container: null, status: null }, cs, ints).status, 'online', 'credenziali rifiutate ma interfaccia raggiungibile');
  assert.equal(statusFor({ integration_id: 'i2', container: 'c1', status: null }, cs, ints).status, 'offline');
  assert.equal(statusFor({ integration_id: null, container: 'c1', status: null }, cs, ints).status, 'degraded');
  assert.equal(statusFor({ integration_id: null, container: 'c2', status: 'online' }, cs, ints).status, 'offline');
  assert.deepEqual(statusFor({ integration_id: null, container: null, status: 'online' }, cs, ints), { status: 'online', source: 'http' });
  assert.equal(statusFor({ integration_id: null, container: null, status: null }, cs, ints).status, 'unknown');
});

const fakeIntegrations = (list) => ({ list: () => list });
const noAgent = { json: async () => [] };

test('favicon scaricata e controllo HTTP: online, offline, destinazione non consentita', async () => {
  const l = new Launcher(db, buildBlockList(['127.0.0.0/8']), fakeIntegrations([]), noAgent, null, '127.0.0.1', 8470);
  const base = { group: '', color: 'chart-1', container: null, integrationId: null };
  const a = l.create({ ...base, name: 'Mia app', url: `http://127.0.0.1:${port}/` });
  assert.equal(await l.refreshIcon(a), true);
  const ic = l.icon(a);
  assert.equal(ic.icon_type, 'image/png');
  assert.deepEqual(Buffer.from(ic.icon_data), PNG);
  const b = l.create({ ...base, name: 'Spenta', url: 'http://127.0.0.1:1/' });
  const c = l.create({ ...base, name: 'Esterna', url: 'https://example.org/' });
  assert.equal(await l.checkHttp(), 3);
  const byId = Object.fromEntries((await l.list()).map((x) => [x.id, x]));
  assert.equal(byId[a].status, 'online');
  assert.match(byId[a].icon, new RegExp(`^/api/v1/launcher/${a}/icon\\?v=\\d+$`));
  assert.equal(byId[b].status, 'offline');
  assert.equal(byId[c].status, 'unknown', 'fuori dalle reti consentite: non verificata, non «offline»');
  assert.equal(byId[c].icon, null);
  l.reorder([c, b, a]);
  assert.deepEqual((await l.list()).map((x) => x.id), [c, b, a]);
  for (const id of [a, b, c]) l.remove(id);
});

test('un solo redirect sulla stessa origine viene seguito per l’icona, verso altre origini no', async () => {
  const l = new Launcher(db, buildBlockList(['127.0.0.1/32']), fakeIntegrations([]), noAgent, null, '127.0.0.1', 8470);
  const base = { group: '', color: 'chart-1', container: null, integrationId: null };
  const same = l.create({ ...base, name: 'Redirect', url: `http://127.0.0.1:${port}/r` });
  assert.equal(await l.refreshIcon(same), true, 'icona trovata in /web/ico.png');
  const other = l.create({ ...base, name: 'Altrove', url: `http://127.0.0.1:${port}/x` });
  assert.equal(await l.refreshIcon(other), false, 'nessuna richiesta verso l’altra origine');
  await l.checkOne(other);
  assert.equal((await l.list()).find((x) => x.id === other).status, 'online', 'un redirect indica comunque un servizio attivo');
  l.remove(same);
  l.remove(other);
});

test('discover: integrazioni apribili e non, porte web, porte escluse, già aggiunte', async () => {
  const ints = [
    { id: 'i-jf', type: 'jellyfin', name: 'Jellyfin', webUrl: `http://127.0.0.1:${port}`, config: { container: 'jellyfin' } },
    { id: 'i-nd', name: 'Navidrome', webUrl: 'http://localhost:4533', config: {} },
  ];
  const listening = async () => ({
    items: [
      { proto: 'tcp', port, scope: 'all', service: null, source: null, ephemeral: false },
      { proto: 'tcp', port: 22, scope: 'all', service: 'SSH', source: 'nota', ephemeral: false },
      { proto: 'tcp', port: 8470, scope: 'specific', service: null, source: null, ephemeral: false },
      { proto: 'tcp', port: 4533, scope: 'local', service: 'Navidrome', source: 'nota', ephemeral: false },
      { proto: 'udp', port: 1900, scope: 'all', service: null, source: null, ephemeral: false },
    ],
  });
  // bindHost diverso dall'host dell'integrazione: la porta del server di prova viene proposta anche come «porta»
  const l = new Launcher(db, buildBlockList(['127.0.0.0/8']), fakeIntegrations(ints), noAgent, listening, '127.0.0.1', 8470);
  let r = await l.discover();
  const jf = r.find((x) => x.integrationId === 'i-jf');
  assert.equal(jf.openable, false, '127.0.0.1 non è apribile da un altro dispositivo');
  const nd = r.find((x) => x.integrationId === 'i-nd');
  assert.equal(nd.openable, false);
  assert.match(nd.reason, /solo dal server/);
  // La porta del server di prova è già quella dell'integrazione Jellyfin (127.0.0.1 = questo PC): non viene riproposta
  assert.equal(r.filter((x) => x.source === 'porta').length, 0, 'nessun doppione tra integrazione e porta');
  const solo = new Launcher(db, buildBlockList(['127.0.0.0/8']), fakeIntegrations([]), noAgent, listening, '127.0.0.1', 8470);
  r = await solo.discover();
  const porte = r.filter((x) => x.source === 'porta');
  assert.equal(porte.length, 1, 'solo la porta web: SSH, GIGI OS, locale e UDP esclusi');
  assert.equal(porte[0].name, 'Mia App & co');
  assert.equal(porte[0].added, false);
  l.create({ name: 'x', url: porte[0].url, group: '', color: 'chart-2', container: null, integrationId: null });
  r = await solo.discover();
  assert.equal(r.find((x) => x.source === 'porta').added, true);
  // Integrazione con indirizzo LAN (nome di prova, non loopback): apribile
  const lan = new Launcher(db, buildBlockList(['127.0.0.0/8']), fakeIntegrations([{ id: 'i-x', name: 'App LAN', webUrl: `http://gigi-mini-pc.test:${port}`, config: {} }]), noAgent, null, 'gigi-mini-pc.test', 8470);
  const r2 = await lan.discover();
  assert.equal(r2.find((x) => x.integrationId === 'i-x').openable, true);
});

test('API: tutti leggono, solo gli admin modificano; URL validati; icona in sandbox', async () => {
  const d2 = mkdtempSync(path.join(tmpdir(), 'gigi-launcher-api-'));
  const db2 = openDb(d2);
  const events = new Events(db2);
  const integrations = new Integrations(db2, new Vault(randomBytes(32)), buildBlockList(['127.0.0.0/8']), events);
  let token = 'codice';
  const app = await buildApp({
    db: db2,
    agent: { json: async () => [], stream: async () => { throw new Error('non usato'); } },
    integrations,
    events,
    sessions: new Sessions(db2, 3600_000, 86400_000),
    limiter: new LoginLimiter(db2, 5),
    audit: new Audit(db2),
    secureCookies: false,
    setupToken: () => token,
    consumeSetupToken: () => (token = null),
    launcher: new Launcher(db2, buildBlockList(['127.0.0.0/8']), integrations, { json: async () => [] }, null, '127.0.0.1', 8470),
  });
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/launcher' })).statusCode, 401);
    const s = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { username: 'gigi', password: 'una-frase-lunga-sicura', setupToken: 'codice' } });
    const admin = { cookie: s.headers['set-cookie'].toString().split(';')[0], 'x-csrf-token': s.json().user.csrf };
    for (const url of ['javascript:alert(1)', 'ftp://x/', 'http://utente:pw@127.0.0.1/']) {
      const bad = await app.inject({ method: 'POST', url: '/api/v1/launcher', headers: admin, payload: { name: 'x', url } });
      assert.equal(bad.statusCode, 400, url);
    }
    const c = await app.inject({ method: 'POST', url: '/api/v1/launcher', headers: admin, payload: { name: 'Mia app', url: `http://127.0.0.1:${port}/`, group: 'Server' } });
    assert.equal(c.statusCode, 200, c.body);
    assert.equal(c.json().icon, true);
    await app.inject({ method: 'POST', url: '/api/v1/users', headers: admin, payload: { username: 'ospite', password: 'altra-frase-lunga-sicura', role: 'viewer' } });
    const l = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'ospite', password: 'altra-frase-lunga-sicura' } });
    const viewer = { cookie: l.headers['set-cookie'].toString().split(';')[0], 'x-csrf-token': l.json().user.csrf };
    const list = await app.inject({ method: 'GET', url: '/api/v1/launcher', headers: viewer });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json()[0].group, 'Server');
    const icon = await app.inject({ method: 'GET', url: list.json()[0].icon, headers: viewer });
    assert.equal(icon.statusCode, 200);
    assert.equal(icon.headers['content-type'], 'image/png');
    assert.match(icon.headers['content-security-policy'], /sandbox/);
    assert.match(icon.headers['cache-control'], /max-age=86400/);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/launcher', headers: viewer, payload: { name: 'x', url: 'http://127.0.0.1/' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/launcher/${c.json().id}`, headers: viewer })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/launcher/discover', headers: viewer })).statusCode, 403);
    // Le altre risposte API restano no-store con la CSP generale
    const st = await app.inject({ method: 'GET', url: '/api/v1/launcher', headers: viewer });
    assert.equal(st.headers['cache-control'], 'no-store');
    assert.match(st.headers['content-security-policy'], /default-src 'self'/);
  } finally {
    await app.close();
    db2.close();
    rmSync(d2, { recursive: true, force: true });
  }
});
