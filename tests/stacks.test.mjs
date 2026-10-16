// Operazioni distruttive Docker e stack compose: autorizzazioni, conferme e audit lato API (agent fittizio),
// più le parti pure dell'agent (percorsi confinati, serializzazione del .env). Nessun container reale toccato.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
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
let preflight = { ok: true, needsConfirm: false, dir: '/opt/stacks/demo', update: false, findings: [], envKeys: [] };
const fakeAgent = {
  async json(method, p, _t, body) {
    calls.push({ method, p, body });
    if (p === '/v1/stacks/preflight') return preflight;
    if (p === '/v1/stacks/deploy') return { job: { id: '00000000-0000-0000-0000-000000000000', status: 'running', output: '' } };
    if (method === 'DELETE' && p.includes('in-uso')) throw Object.assign(new Error('Immagine usata da jellyfin'), { status: 409 });
    return { ok: true };
  },
  async stream() {
    throw new Error('non usato');
  },
};

let app, dir, db, root;
let setupToken = 'codice';
const cookieOf = (res) => res.headers['set-cookie']?.toString().split(';')[0];
let admin, viewer;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'gigi-stacks-'));
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
  const s = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { username: 'gigi', password: 'una-frase-lunga-sicura', setupToken: 'codice' } });
  admin = { cookie: cookieOf(s), 'x-csrf-token': s.json().user.csrf };
  await app.inject({ method: 'POST', url: '/api/v1/users', headers: admin, payload: { username: 'ospite', password: 'altra-frase-lunga-sicura', role: 'viewer' } });
  const l = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'ospite', password: 'altra-frase-lunga-sicura' } });
  viewer = { cookie: cookieOf(l), 'x-csrf-token': l.json().user.csrf };

  root = path.join(dir, 'stacks');
  mkdirSync(root);
  process.env.GIGI_STACK_ROOTS = `Stack=${root}`;
});

after(async () => {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const audit = (action) => db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC').all(action);
const post = (url, payload, headers = admin) => app.inject({ method: 'POST', url, headers, payload });
const STACK = { root: 'Stack', path: 'demo', project: 'demo', compose: 'services:\n  a:\n    image: x\n' };

test('pulizia: solo admin, conferma ELIMINA, esito per elemento e audit', async () => {
  assert.equal((await post('/api/v1/docker/cleanup', { kind: 'image', ids: ['sha256:a'], confirm: 'ELIMINA' }, viewer)).statusCode, 403);
  assert.equal((await post('/api/v1/docker/cleanup', { kind: 'image', ids: ['sha256:a'], confirm: 'elimina' })).statusCode, 400);
  assert.equal((await post('/api/v1/docker/cleanup', { kind: 'disco', ids: ['x'], confirm: 'ELIMINA' })).statusCode, 400);
  assert.equal((await post('/api/v1/docker/cleanup', { kind: 'volume', ids: ['../x'], confirm: 'ELIMINA' })).statusCode, 400);
  const r = await post('/api/v1/docker/cleanup', { kind: 'image', ids: ['sha256:ok', 'sha256:in-uso', 'sha256:ok'], confirm: 'ELIMINA' });
  assert.equal(r.statusCode, 200);
  assert.deepEqual([r.json().ok, r.json().failed], [1, 1], 'duplicati ignorati, errore riportato senza fermare gli altri');
  assert.match(r.json().results.find((x) => !x.ok).error, /jellyfin/);
  assert.equal(audit('docker.remove.image').length, 2);
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.p === '/v1/images/sha256%3Aok'));
});

test('cache di build: conferma SVUOTA', async () => {
  assert.equal((await post('/api/v1/docker/build-cache/prune', { confirm: 'ELIMINA' })).statusCode, 400);
  assert.equal((await post('/api/v1/docker/build-cache/prune', { confirm: 'SVUOTA' })).statusCode, 200);
  assert.equal(audit('docker.prune.build-cache').length, 1);
});

test('deploy: viewer rifiutato, errori bloccanti → 409 senza deploy', async () => {
  assert.equal((await post('/api/v1/stacks/deploy', STACK, viewer)).statusCode, 403);
  assert.equal((await post('/api/v1/stacks/deploy', { ...STACK, project: 'Maiuscolo' })).statusCode, 400);
  preflight = { ...preflight, ok: false, findings: [{ level: 'error', message: 'Porta 8470/tcp già in uso' }] };
  const n = calls.length;
  const r = await post('/api/v1/stacks/deploy', STACK);
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().findings.length, 1);
  assert.ok(!calls.slice(n).some((c) => c.p === '/v1/stacks/deploy'));
  assert.equal(audit('stack.create')[0].result, 'denied');
});

test('deploy: con avvisi serve il nome dello stack; audit senza contenuto del compose né segreti', async () => {
  preflight = { ...preflight, ok: true, needsConfirm: true, findings: [{ level: 'danger', service: 'a', message: 'privileged' }] };
  const body = { ...STACK, env: { PASSWORD: 'segretissimo' } };
  assert.equal((await post('/api/v1/stacks/deploy', body)).statusCode, 400);
  const r = await post('/api/v1/stacks/deploy', { ...body, confirm: 'demo' });
  assert.equal(r.statusCode, 200);
  const sent = calls.filter((c) => c.p === '/v1/stacks/deploy').at(-1).body;
  assert.equal(sent.user, 'gigi');
  assert.equal(sent.pull, 'missing');
  const a = audit('stack.create')[0];
  assert.equal(a.result, 'ok');
  assert.doesNotMatch(a.details, /segretissimo|services:/);
  assert.match(a.details, /danger: a: privileged/);
});

test('azioni stack: conferma col nome, volumi solo con ELIMINA', async () => {
  assert.equal((await post('/api/v1/stacks/demo/actions', { action: 'up' })).statusCode, 200, 'avvio senza conferma');
  assert.equal((await post('/api/v1/stacks/demo/actions', { action: 'down' })).statusCode, 400);
  assert.equal((await post('/api/v1/stacks/demo/actions', { action: 'down', confirm: 'demo', removeVolumes: true })).statusCode, 400);
  assert.equal((await post('/api/v1/stacks/demo/actions', { action: 'down', confirm: 'demo', removeVolumes: true, volumesConfirm: 'ELIMINA' })).statusCode, 200);
  assert.deepEqual(calls.at(-1).body, { removeVolumes: true });
  assert.equal((await post('/api/v1/stacks/demo/actions', { action: 'exec', confirm: 'demo' })).statusCode, 400);
  assert.equal((await post('/api/v1/stacks/demo/actions', { action: 'stop', confirm: 'demo' }, viewer)).statusCode, 403);
  assert.equal((await post('/api/v1/stacks/..%2Fx/actions', { action: 'up' })).statusCode, 400);
});

test('agent: percorsi confinati nella radice, niente symlink', async () => {
  const { resolveDir } = await import('../apps/agent/dist/stacks.js');
  const ok = await resolveDir('Stack', 'app/uno');
  assert.equal(ok.dir, path.join(root, 'app/uno'));
  for (const bad of ['../fuori', 'a/../../b', '.nascosta', 'a/b/c/d', '', 'con spazio'])
    await assert.rejects(resolveDir('Stack', bad), { status: 400 }, bad);
  await assert.rejects(resolveDir('Altro', 'x'), { status: 400 });
  symlinkSync('/etc', path.join(root, 'link'));
  await assert.rejects(resolveDir('Stack', 'link/x'), /collegamento simbolico/);
});

test('agent: .env letterale, round-trip anche con apici e $', async () => {
  const { parseEnv, serializeEnv } = await import('../apps/agent/dist/stacks.js');
  const env = { A: 'semplice', B: "con'apice e $DOLLARO", C: 'spazi # non commento', D: '' };
  const text = serializeEnv(env);
  assert.match(text, /^A='semplice'$/m);
  assert.deepEqual(parseEnv(text), env);
  assert.throws(() => serializeEnv({ X: 'a\nB=iniettato' }), /a capo/);
  assert.throws(() => serializeEnv({ '1X': 'a' }), /non valido/);
});
