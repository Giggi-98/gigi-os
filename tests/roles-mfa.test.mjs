// Ruolo operatore (D-028) e verifica in due passaggi TOTP (D-029): vettori RFC, flusso completo, permessi, migrazione.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { base32Decode, base32Encode, hotp, Mfa, verifyTotp } from '../apps/api/dist/mfa.js';
import { operatorMay } from '../apps/api/dist/routes.js';
import { buildApp } from '../apps/api/dist/app.js';
import { migrate, openDb } from '../apps/api/dist/db.js';
import { Events } from '../apps/api/dist/events.js';
import { Integrations } from '../apps/api/dist/integrations.js';
import { Audit, LoginLimiter, Sessions } from '../apps/api/dist/security.js';
import { buildBlockList } from '../apps/api/dist/ssrf.js';
import { Vault } from '../apps/api/dist/vault.js';

const RFC_KEY = Buffer.from('12345678901234567890');

test('HOTP/TOTP: vettori di test RFC 6238 (SHA-1, 8 cifre)', () => {
  for (const [t, code] of [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
  ]) {
    assert.equal(hotp(RFC_KEY, Math.floor(t / 30), 8), code, `T=${t}`);
  }
  assert.equal(hotp(RFC_KEY, 1, 6), '287082');
});

test('base32: andata e ritorno', () => {
  for (let i = 0; i < 20; i++) {
    const b = randomBytes(1 + i);
    assert.deepEqual(base32Decode(base32Encode(b)), b);
  }
  assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
});

test('verifyTotp: ±30 s accettati, codici vecchi e riusati rifiutati', () => {
  const secret = base32Encode(RFC_KEY);
  const now = 1_700_000_000_000;
  const step = Math.floor(now / 30_000);
  const at = (s) => hotp(RFC_KEY, s);
  assert.equal(verifyTotp(secret, at(step), now), step);
  assert.equal(verifyTotp(secret, at(step - 1), now), step - 1);
  assert.equal(verifyTotp(secret, at(step + 1), now), step + 1);
  assert.equal(verifyTotp(secret, at(step - 2), now), null);
  assert.equal(verifyTotp(secret, at(step), now, step), null, 'stesso intervallo già usato');
  assert.equal(verifyTotp(secret, '12345', now), null);
  assert.equal(verifyTotp(secret, 'abcdef', now), null);
});

test('operatorMay: solo le azioni in elenco, eliminazione torrent senza file', () => {
  assert.equal(operatorMay('qbittorrent', 'control', {}), true);
  assert.equal(operatorMay('qbittorrent', 'add', {}), true);
  assert.equal(operatorMay('qbittorrent', 'delete', { deleteFiles: false }), true);
  assert.equal(operatorMay('qbittorrent', 'delete', { deleteFiles: true }), false);
  assert.equal(operatorMay('qbittorrent', 'delete', {}), false, 'deleteFiles mancante: rifiutato per prudenza');
  assert.equal(operatorMay('qbittorrent', 'seedingPrefs', {}), false);
  assert.equal(operatorMay('armony', 'command', {}), true);
  assert.equal(operatorMay('homeassistant', 'command', {}), false);
});

test('migrazione 004: ricostruisce users senza perdere sessioni e layout; la cascata resta attiva', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gigi-mig-'));
  const old = path.join(dir, 'old');
  const all = path.resolve('apps/api/dist/migrations');
  cpSync(all, old, { recursive: true, filter: (f) => !/00[4-9]_|0[1-9]\d_/.test(path.basename(f)) });
  try {
    const db = openDb(dir, 'a.sqlite');
    // openDb applica tutto: per simulare il database reale ricreiamo da zero con le sole 001–003
    db.close();
    rmSync(path.join(dir, 'a.sqlite'));
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const raw = new DatabaseSync(path.join(dir, 'b.sqlite'));
    raw.exec('PRAGMA foreign_keys = ON');
    migrate(raw, old);
    const now = Date.now();
    raw.prepare("INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES ('u1', 'gigi', 'x', 'admin', ?, ?)").run(now, now);
    raw.prepare("INSERT INTO sessions (token_hash, user_id, csrf, created_at, last_seen, expires_at) VALUES ('t1', 'u1', 'c', ?, ?, ?)").run(now, now, now + 1e6);
    raw.prepare("INSERT INTO layouts (user_id, layout, updated_at) VALUES ('u1', '{}', ?)").run(now);
    migrate(raw, all);
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1);
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM layouts').get().n, 1);
    assert.equal(raw.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    raw.prepare("UPDATE users SET role = 'operator' WHERE id = 'u1'").run();
    assert.throws(() => raw.prepare("UPDATE users SET role = 'root'").run(), /CHECK/);
    raw.prepare("DELETE FROM users WHERE id = 'u1'").run();
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0, 'ON DELETE CASCADE ancora attivo');
    raw.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ───────────── Flusso completo con l'API ─────────────
let app, dir, db, clock;
let setupToken = 'codice-test';
const calls = [];
const fakeAgent = {
  async json(method, p) {
    calls.push(`${method} ${p}`);
    if (/^\/v1\/containers\/demo$/.test(p)) return { name: 'demo', controllable: true };
    if (/\/(start|stop|restart)$/.test(p)) return { ok: true };
    if (p === '/v1/containers') return [];
    if (p === '/v1/system') return { disks: [] };
    return {};
  },
  async stream() {
    const { Readable } = await import('node:stream');
    return Readable.from([]);
  },
};

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'gigi-mfa-'));
  db = openDb(dir);
  clock = 1_800_000_000_000;
  const vault = new Vault(randomBytes(32));
  const events = new Events(db);
  app = await buildApp({
    db,
    agent: fakeAgent,
    integrations: new Integrations(db, vault, buildBlockList(['127.0.0.0/8']), events),
    events,
    sessions: new Sessions(db, 3600_000, 86400_000),
    limiter: new LoginLimiter(db, 8),
    audit: new Audit(db),
    secureCookies: false,
    setupToken: () => setupToken,
    consumeSetupToken: () => (setupToken = null),
    mfa: new Mfa(db, vault, () => clock),
  });
});

after(async () => {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const cookieOf = (res) => res.headers['set-cookie']?.toString().split(';')[0];
const codeAt = (secret, t = clock) => hotp(base32Decode(secret), Math.floor(t / 30_000));
const tick = () => (clock += 30_000);
const req = (method, url, h, payload) => app.inject({ method, url, headers: h, payload });

const S = {};

async function enroll(h, password) {
  const b = await req('POST', '/api/v1/auth/mfa/begin', h, { password });
  assert.equal(b.statusCode, 200, b.body);
  assert.match(b.json().uri, /^otpauth:\/\/totp\/GIGI%20OS%3A/);
  const c = await req('POST', '/api/v1/auth/mfa/confirm', h, { code: codeAt(b.json().secret) });
  assert.equal(c.statusCode, 200, c.body);
  return { secret: b.json().secret, recovery: c.json().recoveryCodes };
}

async function loginWithMfa(username, password, secret) {
  const l = await req('POST', '/api/v1/auth/login', {}, { username, password });
  assert.equal(l.statusCode, 200);
  assert.equal(l.json().mfaRequired, true);
  assert.equal(l.headers['set-cookie'], undefined, 'nessuna sessione prima del codice');
  tick();
  const m = await req('POST', '/api/v1/auth/login/mfa', {}, { ticket: l.json().ticket, code: codeAt(secret) });
  assert.equal(m.statusCode, 200, m.body);
  return { cookie: cookieOf(m), 'x-csrf-token': m.json().user.csrf };
}

test('admin appena creato: può solo configurare la 2FA', async () => {
  const s = await req('POST', '/api/v1/auth/setup', {}, { username: 'gigi', password: 'una-frase-lunga-sicura', setupToken: 'codice-test' });
  assert.equal(s.statusCode, 200);
  assert.deepEqual(s.json().user.mfa, { enabled: false, required: true, setupRequired: true });
  S.admin = { cookie: cookieOf(s), 'x-csrf-token': s.json().user.csrf };
  const blocked = await req('GET', '/api/v1/system', S.admin);
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.json().code, 'mfa_setup_required');
  assert.equal((await req('GET', '/api/v1/users', S.admin)).statusCode, 403);
  assert.equal((await req('GET', '/api/v1/auth/state', S.admin)).json().user.mfa.setupRequired, true);
  assert.equal((await req('GET', '/api/v1/auth/mfa', S.admin)).statusCode, 200);
});

test('configurazione: password richiesta, codice errato rifiutato, poi accesso completo', async () => {
  assert.equal((await req('POST', '/api/v1/auth/mfa/begin', S.admin, { password: 'sbagliata' })).statusCode, 403);
  const b = await req('POST', '/api/v1/auth/mfa/begin', S.admin, { password: 'una-frase-lunga-sicura' });
  assert.equal((await req('POST', '/api/v1/auth/mfa/confirm', S.admin, { code: '000000' })).statusCode, 400);
  const c = await req('POST', '/api/v1/auth/mfa/confirm', S.admin, { code: codeAt(b.json().secret) });
  assert.equal(c.statusCode, 200);
  assert.equal(c.json().recoveryCodes.length, 10);
  assert.match(c.json().recoveryCodes[0], /^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
  S.adminSecret = b.json().secret;
  S.adminRecovery = c.json().recoveryCodes;
  assert.equal((await req('GET', '/api/v1/system', S.admin)).statusCode, 200);
  assert.equal((await req('GET', '/api/v1/auth/state', S.admin)).json().user.mfa.enabled, true);
  // Secret mai salvato in chiaro
  const row = db.prepare('SELECT secret_enc, recovery FROM user_mfa').get();
  assert.ok(!row.secret_enc.includes(S.adminSecret));
  assert.ok(!row.recovery.includes(S.adminRecovery[0].replace('-', '')));
});

test('login in due passaggi: codice errato, codice riusato, biglietto con tentativi limitati', async () => {
  const l = await req('POST', '/api/v1/auth/login', {}, { username: 'gigi', password: 'una-frase-lunga-sicura' });
  assert.equal(l.json().mfaRequired, true);
  const ticket = l.json().ticket;
  assert.equal((await req('POST', '/api/v1/auth/login/mfa', {}, { ticket, code: '000000' })).statusCode, 401);
  // Il codice del passo di configurazione è già stato usato: rifiutato anche se ancora nella finestra
  assert.equal((await req('POST', '/api/v1/auth/login/mfa', {}, { ticket, code: codeAt(S.adminSecret) })).statusCode, 401);
  tick();
  const ok = await req('POST', '/api/v1/auth/login/mfa', {}, { ticket, code: codeAt(S.adminSecret) });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().user.mfa.enabled, true);
  assert.equal((await req('POST', '/api/v1/auth/login/mfa', {}, { ticket, code: codeAt(S.adminSecret) })).statusCode, 401, 'biglietto consumato');
  const bogus = await req('POST', '/api/v1/auth/login/mfa', {}, { ticket: 'x'.repeat(43), code: '123456' });
  assert.equal(bogus.json().code, 'ticket_expired');
  S.admin = { cookie: cookieOf(ok), 'x-csrf-token': ok.json().user.csrf };
});

test('biglietto: scade dopo 5 minuti', async () => {
  const l = await req('POST', '/api/v1/auth/login', {}, { username: 'gigi', password: 'una-frase-lunga-sicura' });
  clock += 6 * 60_000;
  const r = await req('POST', '/api/v1/auth/login/mfa', {}, { ticket: l.json().ticket, code: codeAt(S.adminSecret) });
  assert.equal(r.statusCode, 401);
  assert.equal(r.json().code, 'ticket_expired');
});

test('codice di recupero: valido una sola volta', async () => {
  const code = S.adminRecovery[0].toLowerCase();
  const l1 = await req('POST', '/api/v1/auth/login', {}, { username: 'gigi', password: 'una-frase-lunga-sicura' });
  const r1 = await req('POST', '/api/v1/auth/login/mfa', {}, { ticket: l1.json().ticket, code });
  assert.equal(r1.statusCode, 200);
  assert.equal(r1.json().recoveryLeft, 9);
  const l2 = await req('POST', '/api/v1/auth/login', {}, { username: 'gigi', password: 'una-frase-lunga-sicura' });
  assert.equal((await req('POST', '/api/v1/auth/login/mfa', {}, { ticket: l2.json().ticket, code })).statusCode, 401);
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'auth.login' AND details LIKE '%recovery%'").get().n >= 1);
});

test('operatore: deve configurare la 2FA, poi avvia e riavvia ma non ferma', async () => {
  const c = await req('POST', '/api/v1/users', S.admin, { username: 'amico', password: 'frase-lunga-operatore', role: 'operator' });
  assert.equal(c.statusCode, 200, c.body);
  S.operatorId = c.json().id;
  const l = await req('POST', '/api/v1/auth/login', {}, { username: 'amico', password: 'frase-lunga-operatore' });
  S.op = { cookie: cookieOf(l), 'x-csrf-token': l.json().user.csrf };
  assert.equal(l.json().user.mfa.setupRequired, true);
  assert.equal((await req('POST', '/api/v1/docker/containers/demo/actions', S.op, { action: 'restart', confirm: 'demo' })).statusCode, 403);
  tick();
  S.opSecret = (await enroll(S.op, 'frase-lunga-operatore')).secret;
  assert.equal((await req('POST', '/api/v1/docker/containers/demo/actions', S.op, { action: 'restart', confirm: 'demo' })).statusCode, 200);
  assert.equal((await req('POST', '/api/v1/docker/containers/demo/actions', S.op, { action: 'start' })).statusCode, 200);
  const stop = await req('POST', '/api/v1/docker/containers/demo/actions', S.op, { action: 'stop', confirm: 'demo' });
  assert.equal(stop.statusCode, 403);
  assert.ok(!calls.includes('POST /v1/containers/demo/stop'), 'lo stop non arriva all’agent');
  assert.notEqual((await req('GET', '/api/v1/docker/containers/demo/logs?tail=10', S.op)).statusCode, 403);
});

test('operatore: le aree amministrative restano chiuse', async () => {
  const denied = [
    ['GET', '/api/v1/users'],
    ['POST', '/api/v1/users', { username: 'x1y', password: 'una-frase-lunga-sicura', role: 'admin' }],
    ['GET', '/api/v1/audit'],
    ['POST', '/api/v1/integrations', {}],
    ['POST', '/api/v1/docker/cleanup', {}],
    ['POST', '/api/v1/docker/build-cache/prune', {}],
    ['GET', '/api/v1/stacks/roots'],
    ['POST', '/api/v1/stacks/deploy', {}],
    ['DELETE', `/api/v1/users/${S.operatorId}/mfa`],
  ];
  for (const [m, url, body] of denied) {
    const r = await req(m, url, S.op, body);
    assert.equal(r.statusCode, 403, `${m} ${url}`);
  }
  const env = await req('GET', '/api/v1/docker/containers/demo', S.op);
  assert.equal(env.statusCode, 200);
});

test('sola lettura: nessuna azione sui container, 2FA facoltativa', async () => {
  await req('POST', '/api/v1/users', S.admin, { username: 'ospite', password: 'sola-lettura-lunga-1', role: 'viewer' });
  const l = await req('POST', '/api/v1/auth/login', {}, { username: 'ospite', password: 'sola-lettura-lunga-1' });
  const v = { cookie: cookieOf(l), 'x-csrf-token': l.json().user.csrf };
  assert.deepEqual(l.json().user.mfa, { enabled: false, required: false, setupRequired: false });
  assert.equal((await req('GET', '/api/v1/system', v)).statusCode, 200);
  assert.equal((await req('POST', '/api/v1/docker/containers/demo/actions', v, { action: 'start' })).statusCode, 403);
  assert.equal((await req('GET', '/api/v1/docker/containers/demo/logs', v)).statusCode, 403);
});

test('admin azzera la 2FA di un operatore: sessioni chiuse, nuova configurazione obbligatoria', async () => {
  const users = (await req('GET', '/api/v1/users', S.admin)).json();
  assert.equal(users.find((u) => u.username === 'amico').mfa, true);
  assert.equal((await req('DELETE', `/api/v1/users/${S.operatorId}/mfa`, S.admin)).statusCode, 200);
  assert.equal((await req('GET', '/api/v1/system', S.op)).statusCode, 401, 'sessione dell’operatore chiusa');
  const l = await req('POST', '/api/v1/auth/login', {}, { username: 'amico', password: 'frase-lunga-operatore' });
  assert.equal(l.json().mfaRequired, undefined);
  assert.equal(l.json().user.mfa.setupRequired, true);
});

test('disattivazione: servono password e codice; per un admin torna obbligatoria la configurazione', async () => {
  tick();
  assert.equal((await req('POST', '/api/v1/auth/mfa/disable', S.admin, { password: 'una-frase-lunga-sicura', code: '000000' })).statusCode, 403);
  const r = await req('POST', '/api/v1/auth/mfa/disable', S.admin, { password: 'una-frase-lunga-sicura', code: codeAt(S.adminSecret) });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().setupRequired, true);
  assert.equal((await req('GET', '/api/v1/system', S.admin)).json().code, 'mfa_setup_required');
});

test('l’ultimo admin non può declassarsi a operatore', async () => {
  tick();
  await enroll(S.admin, 'una-frase-lunga-sicura');
  const me = (await req('GET', '/api/v1/auth/state', S.admin)).json().user;
  const r = await req('PATCH', `/api/v1/users/${me.id}`, S.admin, { role: 'operator' });
  assert.equal(r.statusCode, 409);
});
