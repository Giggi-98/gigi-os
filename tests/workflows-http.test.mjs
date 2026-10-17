// D-041: route dei flussi via HTTP — solo admin, webhook senza sessione né CSRF ma con token obbligatorio.
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
import { Workflows } from '../apps/api/dist/workflows/engine.js';

let app, dir, db, wf;
let setupToken = 'codice';
const agent = { json: async () => ({}), stream: async () => { throw new Error('no'); } };

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'gigi-wfh-'));
  db = openDb(dir);
  const events = new Events(db);
  const vault = new Vault(randomBytes(32));
  wf = new Workflows(db, vault, {
    integration: () => null,
    integrationAction: async () => ({}),
    integrationResource: async () => [],
    notify: async () => {},
    channelIds: () => [],
    event: () => {},
    fetchOut: async () => ({ status: 200, text: '{}', type: null }),
    docker: async () => {},
    rescanLibrary: async () => {},
    sleep: async () => {},
    now: () => Date.now(),
    log: () => {},
  });
  app = await buildApp({
    db,
    agent,
    integrations: new Integrations(db, vault, buildBlockList(['127.0.0.0/8']), events),
    events,
    sessions: new Sessions(db, 3600_000, 86400_000),
    limiter: new LoginLimiter(db, 5),
    audit: new Audit(db),
    secureCookies: false,
    setupToken: () => setupToken,
    consumeSetupToken: () => (setupToken = null),
    workflows: wf,
  });
});
after(async () => {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('flussi via HTTP: creazione da admin, token, webhook senza sessione', async () => {
  const s = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { username: 'gigi', password: 'una-frase-lunga-sicura', setupToken: 'codice' } });
  const cookie = s.headers['set-cookie'].toString().split(';')[0];
  const csrf = s.json().user.csrf;
  const h = { cookie, 'x-csrf-token': csrf };

  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/workflows' })).statusCode, 401, 'serve la sessione');
  const noCsrf = await app.inject({ method: 'POST', url: '/api/v1/workflows', headers: { cookie }, payload: { template: 'empty' } });
  assert.equal(noCsrf.statusCode, 403, 'le route dei flussi restano protette dal CSRF');

  const graph = {
    nodes: [
      { id: 'hook', type: 'trigger.webhook', name: 'Arriva', config: {}, position: { x: 0, y: 0 } },
      { id: 'set', type: 'logic.set', name: 'Dati', config: { fields: [{ name: 'title', value: '{{ trigger.body.title }}' }] }, position: { x: 200, y: 0 } },
    ],
    edges: [{ id: 'e1', source: 'hook', port: 'out', target: 'set' }],
  };
  const c = await app.inject({ method: 'POST', url: '/api/v1/workflows', headers: h, payload: { name: 'Prova', graph } });
  assert.equal(c.statusCode, 200, c.body);
  const id = c.json().id;
  const bad = await app.inject({ method: 'PUT', url: `/api/v1/workflows/${id}`, headers: h, payload: { enabled: true } });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /token/);
  const tok = await app.inject({ method: 'POST', url: `/api/v1/workflows/${id}/nodes/hook/token`, headers: h });
  const token = tok.json().token;
  assert.equal((await app.inject({ method: 'PUT', url: `/api/v1/workflows/${id}`, headers: h, payload: { enabled: true } })).statusCode, 200);

  const url = `/api/v1/hooks/${id}/hook`;
  assert.equal((await app.inject({ method: 'POST', url, payload: { title: 'Dune' } })).statusCode, 401, 'senza token');
  assert.equal((await app.inject({ method: 'POST', url, headers: { authorization: 'Bearer sbagliato' }, payload: {} })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: `${url}?token=${token}`, payload: {} })).statusCode, 401, 'il token nell’URL non vale');
  assert.equal((await app.inject({ method: 'POST', url: `/api/v1/hooks/${id}/altro`, headers: { authorization: `Bearer ${token}` }, payload: {} })).statusCode, 401);
  const ok = await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: { title: 'Dune' } });
  assert.equal(ok.statusCode, 202, ok.body);
  assert.equal(ok.json().started, true);
  await new Promise((r) => setTimeout(r, 30));
  const runs = await app.inject({ method: 'GET', url: `/api/v1/workflows/${id}/runs`, headers: h });
  const [run] = runs.json();
  assert.equal(run.status, 'success');
  const detail = await app.inject({ method: 'GET', url: `/api/v1/workflow-runs/${run.id}`, headers: h });
  assert.match(detail.json().steps.at(-1).output, /"title":"Dune"/);
  // Il campione per costruire le espressioni
  const sample = await app.inject({ method: 'GET', url: `/api/v1/workflows/${id}/nodes/hook/sample`, headers: h });
  assert.equal(sample.json().sample.body.title, 'Dune');
  assert.equal(sample.json().sample.headers.authorization, undefined, 'il token non finisce nel campione');
  // Catalogo e audit
  const cat = await app.inject({ method: 'GET', url: '/api/v1/workflows/catalog', headers: h });
  assert.ok(cat.json().nodes.length >= 20);
  assert.ok(cat.json().templates.some((t) => t.id === 'borollo'));
  const audit = db.prepare("SELECT action FROM audit_log WHERE action LIKE 'workflow.%'").all().map((r) => r.action);
  assert.deepEqual([...new Set(audit)].sort(), ['workflow.create', 'workflow.token', 'workflow.update']);
});
