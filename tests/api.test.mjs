// Test di integrazione dell'API con agent fittizio e DB temporaneo (nessun servizio reale toccato).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { buildApp } from '../apps/api/dist/app.js';
import { openDb } from '../apps/api/dist/db.js';
import { Events } from '../apps/api/dist/events.js';
import { Integrations } from '../apps/api/dist/integrations.js';
import { Audit, LoginLimiter, Sessions } from '../apps/api/dist/security.js';
import { buildBlockList } from '../apps/api/dist/ssrf.js';
import { Vault } from '../apps/api/dist/vault.js';

const calls = [];
const fakeAgent = {
  async json(method, p) {
    calls.push(`${method} ${p}`);
    if (p.startsWith('/v1/containers/protetto')) return { name: 'gigi-api', controllable: false };
    if (/^\/v1\/containers\/[^/]+$/.test(p)) return { name: 'demo', controllable: true, env: [{ key: 'A', value: 'b' }], cmd: [], entrypoint: [], labels: [] };
    if (/\/(start|stop|restart)$/.test(p)) return { ok: true };
    if (p === '/v1/containers') return [];
    if (p === '/v1/system') return { disks: [] };
    return {};
  },
  async stream() {
    throw new Error('non usato');
  },
};

let app, dir, db;
const SETUP = 'codice-test';
let setupToken = SETUP;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'gigi-test-'));
  db = openDb(dir);
  const events = new Events(db);
  app = await buildApp({
    db,
    agent: fakeAgent,
    integrations: new Integrations(db, new Vault(randomBytes(32)), buildBlockList(['127.0.0.0/8']), events),
    events,
    sessions: new Sessions(db, 3600_000, 86400_000),
    limiter: new LoginLimiter(db, 5),
    audit: new Audit(db),
    secureCookies: false,
    setupToken: () => setupToken,
    consumeSetupToken: () => (setupToken = null),
  });
});

after(async () => {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const cookieOf = (res) => res.headers['set-cookie']?.toString().split(';')[0];

let adminCookie, adminCsrf;

test('setup: richiede il codice monouso', async () => {
  const st = await app.inject({ method: 'GET', url: '/api/v1/auth/state' });
  assert.equal(st.json().setupRequired, true);
  const bad = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { username: 'gigi', password: 'una-frase-lunga-sicura', setupToken: 'sbagliato' } });
  assert.equal(bad.statusCode, 403);
  const weak = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { username: 'gigi', password: 'corta', setupToken: SETUP } });
  assert.equal(weak.statusCode, 400);
  const ok = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { username: 'gigi', password: 'una-frase-lunga-sicura', setupToken: SETUP } });
  assert.equal(ok.statusCode, 200);
  adminCookie = cookieOf(ok);
  adminCsrf = ok.json().user.csrf;
  assert.match(ok.headers['set-cookie'].toString(), /HttpOnly/);
  assert.match(ok.headers['set-cookie'].toString(), /SameSite=Strict/);
  const again = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { username: 'altro', password: 'una-frase-lunga-sicura', setupToken: SETUP } });
  assert.equal(again.statusCode, 409);
});

test('setup crea integrazioni senza credenziali (Apollo, Armony, Navidrome)', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/v1/integrations', headers: { cookie: adminCookie } });
  assert.deepEqual(r.json().map((i) => i.type).sort(), ['apollo', 'armony', 'navidrome']);
});

test('API protette senza sessione → 401', async () => {
  for (const url of ['/api/v1/system', '/api/v1/docker/containers', '/api/v1/integrations', '/api/v1/users', '/api/v1/overview']) {
    const r = await app.inject({ method: 'GET', url });
    assert.equal(r.statusCode, 401, url);
  }
});

test('CSRF: mutazioni senza token o con Origin estranea rifiutate', async () => {
  const noToken = await app.inject({ method: 'POST', url: '/api/v1/users', headers: { cookie: adminCookie }, payload: { username: 'x', password: 'y', role: 'viewer' } });
  assert.equal(noToken.statusCode, 403);
  const foreign = await app.inject({
    method: 'POST',
    url: '/api/v1/users',
    headers: { cookie: adminCookie, 'x-csrf-token': adminCsrf, origin: 'http://evil.example' },
    payload: { username: 'x', password: 'y', role: 'viewer' },
  });
  assert.equal(foreign.statusCode, 403);
});

let viewerCookie, viewerCsrf;

test('RBAC: un viewer legge ma non amministra', async () => {
  const h = { cookie: adminCookie, 'x-csrf-token': adminCsrf };
  const c = await app.inject({ method: 'POST', url: '/api/v1/users', headers: h, payload: { username: 'ospite', password: 'altra-frase-lunga-sicura', role: 'viewer' } });
  assert.equal(c.statusCode, 200);
  const l = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'ospite', password: 'altra-frase-lunga-sicura' } });
  assert.equal(l.statusCode, 200);
  viewerCookie = cookieOf(l);
  viewerCsrf = l.json().user.csrf;
  const vh = { cookie: viewerCookie, 'x-csrf-token': viewerCsrf };
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/system', headers: vh })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/users', headers: vh })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/audit', headers: vh })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/docker/containers/demo/logs', headers: vh })).statusCode, 403);
  const act = await app.inject({ method: 'POST', url: '/api/v1/docker/containers/demo/actions', headers: vh, payload: { action: 'restart', confirm: 'demo' } });
  assert.equal(act.statusCode, 403);
  assert.ok(!calls.some((c) => c.endsWith('/restart')), "l'agent non deve ricevere l'azione");
  const insp = await app.inject({ method: 'GET', url: '/api/v1/docker/containers/demo', headers: vh });
  assert.equal(insp.json().env, null, 'env nascoste ai viewer');
});

test('azioni Docker: conferma obbligatoria, container protetti, audit', async () => {
  const h = { cookie: adminCookie, 'x-csrf-token': adminCsrf };
  const noConfirm = await app.inject({ method: 'POST', url: '/api/v1/docker/containers/demo/actions', headers: h, payload: { action: 'stop' } });
  assert.equal(noConfirm.statusCode, 400);
  const prot = await app.inject({ method: 'POST', url: '/api/v1/docker/containers/protetto/actions', headers: h, payload: { action: 'stop', confirm: 'gigi-api' } });
  assert.equal(prot.statusCode, 403);
  const ok = await app.inject({ method: 'POST', url: '/api/v1/docker/containers/demo/actions', headers: h, payload: { action: 'restart', confirm: 'demo' } });
  assert.equal(ok.statusCode, 200);
  assert.ok(calls.includes('POST /v1/containers/demo/restart'));
  const bad = await app.inject({ method: 'GET', url: '/api/v1/docker/containers/..%2F..%2Fetc', headers: h });
  assert.equal(bad.statusCode, 400);
  const audit = (await app.inject({ method: 'GET', url: '/api/v1/audit', headers: h })).json();
  assert.ok(audit.some((a) => a.action === 'docker.restart' && a.result === 'ok' && a.target === 'demo'));
  assert.ok(audit.some((a) => a.action === 'docker.stop' && a.result === 'denied'));
});

test('integrazioni: i segreti non escono mai dalle API', async () => {
  const h = { cookie: adminCookie, 'x-csrf-token': adminCsrf };
  const r = await app.inject({
    method: 'POST',
    url: '/api/v1/integrations',
    headers: h,
    payload: { type: 'jellyfin', name: 'JF', baseUrl: 'http://127.0.0.1:9', auth: 'apikey', secret: { apiKey: 'SUPERSEGRETO123' } },
  });
  assert.equal(r.statusCode, 200);
  assert.ok(!r.body.includes('SUPERSEGRETO123'));
  assert.deepEqual(r.json().secretFields, ['apiKey']);
  assert.equal(r.json().status, 'offline');
  const list = await app.inject({ method: 'GET', url: '/api/v1/integrations', headers: h });
  assert.ok(!list.body.includes('SUPERSEGRETO123'));
  const row = db.prepare("SELECT secret_enc FROM integrations WHERE type = 'jellyfin'").get();
  assert.ok(!row.secret_enc.includes('SUPERSEGRETO123'), 'cifrato a riposo');
  const ssrf = await app.inject({
    method: 'POST',
    url: '/api/v1/integrations/test',
    headers: h,
    payload: { type: 'http', name: 'x', baseUrl: 'http://169.254.169.254', auth: 'none' },
  });
  assert.equal(ssrf.json().status, 'error');
  assert.match(ssrf.json().message, /non consentita/);
});

test('ultimo admin non rimovibile né declassabile', async () => {
  const h = { cookie: adminCookie, 'x-csrf-token': adminCsrf };
  const users = (await app.inject({ method: 'GET', url: '/api/v1/users', headers: h })).json();
  const me = users.find((u) => u.username === 'gigi');
  const r = await app.inject({ method: 'PATCH', url: `/api/v1/users/${me.id}`, headers: h, payload: { role: 'viewer' } });
  assert.equal(r.statusCode, 409);
});

test('integrazioni: risorse sensibili e azioni solo per admin', async () => {
  const h = { cookie: adminCookie, 'x-csrf-token': adminCsrf };
  const l = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'ospite', password: 'altra-frase-lunga-sicura' } });
  const vc = cookieOf(l);
  const vcsrf = l.json().user.csrf;
  const arm = (await app.inject({ method: 'GET', url: '/api/v1/integrations', headers: h })).json().find((i) => i.type === 'armony');
  const log = await app.inject({ method: 'GET', url: `/api/v1/integrations/${arm.id}/resources/log`, headers: { cookie: vc } });
  assert.equal(log.statusCode, 403);
  const act = await app.inject({ method: 'POST', url: `/api/v1/integrations/${arm.id}/actions/command`, headers: { cookie: vc, 'x-csrf-token': vcsrf }, payload: { to: 'x', cmd: 'pause' } });
  assert.equal(act.statusCode, 403);
  const adminAct = await app.inject({ method: 'POST', url: `/api/v1/integrations/${arm.id}/actions/command`, headers: h, payload: { to: 'x', cmd: 'pause' } });
  assert.equal(adminAct.statusCode, 409, 'senza chiave: rifiutato in modo controllato');
  const audit = (await app.inject({ method: 'GET', url: '/api/v1/audit', headers: h })).json();
  assert.ok(audit.some((a) => a.action === 'integration.action.command' && a.result === 'error'));
});


test('login: blocco dopo troppi tentativi falliti', async () => {
  let last;
  for (let i = 0; i < 6; i++) {
    last = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'gigi', password: 'sbagliata-sbagliata' } });
  }
  assert.equal(last.statusCode, 429);
  const blockedEvenIfRight = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'gigi', password: 'una-frase-lunga-sicura' } });
  assert.equal(blockedEvenIfRight.statusCode, 429);
});

test('logout invalida la sessione lato server', async () => {
  const vh = { cookie: viewerCookie, 'x-csrf-token': viewerCsrf };
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: vh })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/system', headers: { cookie: viewerCookie } })).statusCode, 401);
});

test('header di sicurezza presenti', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/v1/health' });
  assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
});
