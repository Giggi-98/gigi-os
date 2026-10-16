// Dispositivi attendibili per la 2FA (D-036): ricordati solo se richiesto, per il periodo scelto dall'admin,
// legati all'utente, revocati da cambio password, disattivazione 2FA, azzeramento e scelta dell'utente.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { base32Decode, deviceLabel, hotp, Mfa } from '../apps/api/dist/mfa.js';
import { buildApp } from '../apps/api/dist/app.js';
import { openDb } from '../apps/api/dist/db.js';
import { Events } from '../apps/api/dist/events.js';
import { Integrations } from '../apps/api/dist/integrations.js';
import { Audit, LoginLimiter, Sessions } from '../apps/api/dist/security.js';
import { buildBlockList } from '../apps/api/dist/ssrf.js';
import { Vault } from '../apps/api/dist/vault.js';

const DAY = 86400_000;
let app, dir, db, clock, secret;
let token = 'codice';
let PW = 'una-frase-lunga-sicura';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'gigi-trust-'));
  db = openDb(dir);
  clock = 1_800_000_000_000;
  const vault = new Vault(randomBytes(32));
  const events = new Events(db);
  app = await buildApp({
    db,
    agent: { json: async () => ({ disks: [] }), stream: async () => null },
    integrations: new Integrations(db, vault, buildBlockList(['127.0.0.0/8']), events),
    events,
    sessions: new Sessions(db, 3600_000, 86400_000),
    limiter: new LoginLimiter(db, 50),
    audit: new Audit(db),
    secureCookies: false,
    setupToken: () => token,
    consumeSetupToken: () => (token = null),
    mfa: new Mfa(db, vault, () => clock),
  });
});
after(async () => {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const cookies = (res) => Object.fromEntries([res.headers['set-cookie']].flat().filter(Boolean).map((c) => c.split(';')[0].split('=')));
const code = () => hotp(base32Decode(secret), Math.floor((clock += 30_000) / 30_000));
// Ogni richiesta da un IP diverso: il limite di 10 login al minuto per IP qui non è oggetto del test
let ipN = 1;
const req = (method, url, headers = {}, payload) => app.inject({ method, url, headers: { 'user-agent': UA, ...headers }, payload, remoteAddress: `10.9.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}` });

async function login(trust, remember) {
  const l = await req('POST', '/api/v1/auth/login', trust ? { cookie: `gigi_trust=${trust}` } : {}, { username: 'gigi', password: PW });
  if (!l.json().mfaRequired) return { direct: true, res: l };
  const m = await req('POST', '/api/v1/auth/login/mfa', {}, { ticket: l.json().ticket, code: code(), remember });
  assert.equal(m.statusCode, 200, m.body);
  return { direct: false, res: m, trustDays: l.json().trustDays };
}
const session = (res) => ({ cookie: `gigi_session=${cookies(res).gigi_session}`, 'x-csrf-token': res.json().user.csrf });

test('preparazione: admin con 2FA', async () => {
  const s = await req('POST', '/api/v1/auth/setup', {}, { username: 'gigi', password: PW, setupToken: 'codice' });
  const h = session(s);
  const b = await req('POST', '/api/v1/auth/mfa/begin', h, { password: PW });
  secret = b.json().secret;
  assert.equal((await req('POST', '/api/v1/auth/mfa/confirm', h, { code: code() })).statusCode, 200);
});

let trust;
test('senza «ricorda» nessun cookie; con «ricorda» il dispositivo salta la 2FA', async () => {
  const a = await login(null, false);
  assert.equal(a.trustDays, 30, 'periodo predefinito');
  assert.equal(cookies(a.res).gigi_trust, undefined);
  const b = await login(null, true);
  trust = cookies(b.res).gigi_trust;
  assert.ok(trust && trust.length > 40);
  assert.match([b.res.headers['set-cookie']].flat().join(), /gigi_trust=[^;]+; Max-Age=2592000; Path=\/api\/v1\/auth; HttpOnly; SameSite=Strict/);
  const c = await login(trust);
  assert.equal(c.direct, true, 'password sola: niente codice');
  assert.equal(c.res.json().user.mfa.enabled, true);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'auth.login' AND details LIKE '%trusted%'").get());
  assert.ok(db.prepare("SELECT token_hash FROM trusted_devices").get().token_hash !== trust, 'nel database solo l’hash');
});

test('il token non vale per un altro utente né dopo la scadenza', async () => {
  const h = session((await login(trust)).res);
  await req('POST', '/api/v1/users', h, { username: 'amico', password: 'frase-lunga-operatore', role: 'viewer' });
  const other = db.prepare("SELECT id FROM users WHERE username = 'amico'").get().id;
  const mfa = new Mfa(db, new Vault(randomBytes(32)), () => clock);
  assert.equal(mfa.checkDevice(other, trust), false);
  clock += 31 * DAY;
  assert.equal((await login(trust, false)).direct, false, 'scaduto: torna la 2FA');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trusted_devices').get().n, 0, 'il dispositivo scaduto viene rimosso');
});

test('l’admin sceglie il periodo; un periodo più corto vale subito, 0 disattiva', async () => {
  const b = await login(null, true);
  trust = cookies(b.res).gigi_trust;
  const h = session(b.res);
  assert.equal((await req('PUT', '/api/v1/security/mfa-policy', h, { trustDays: 5 })).statusCode, 400, 'solo i periodi previsti');
  assert.equal((await req('PUT', '/api/v1/security/mfa-policy', h, { trustDays: 7 })).statusCode, 200);
  clock += 8 * DAY;
  assert.equal((await login(trust)).direct, false, 'registrato con 30 giorni, ora ne valgono 7');
  const c = await login(null, true);
  trust = cookies(c.res).gigi_trust;
  assert.equal((await req('PUT', '/api/v1/security/mfa-policy', session(c.res), { trustDays: 0 })).statusCode, 200);
  assert.equal((await login(trust)).direct, false);
  const d = await login(null, true);
  assert.equal(cookies(d.res).gigi_trust, undefined, 'disattivati: nessun cookie');
  await req('PUT', '/api/v1/security/mfa-policy', session(d.res), { trustDays: 30 });
});

test('elenco e revoca dall’utente; cambio password e disattivazione 2FA li cancellano', async () => {
  const a = await login(null, true);
  trust = cookies(a.res).gigi_trust;
  const h = { ...session(a.res), cookie: `${session(a.res).cookie}; gigi_trust=${trust}` };
  const list = (await req('GET', '/api/v1/auth/devices', h)).json();
  assert.equal(list.trustDays, 30);
  assert.equal(list.devices.length, 1);
  assert.equal(list.devices[0].label, 'Chrome · Windows');
  assert.equal(list.devices[0].current, true);
  assert.equal((await req('DELETE', `/api/v1/auth/devices/${list.devices[0].id}`, h)).statusCode, 200);
  assert.equal((await login(trust)).direct, false);

  let s = await login(null, true);
  trust = cookies(s.res).gigi_trust;
  assert.equal((await req('POST', '/api/v1/auth/password', session(s.res), { current: PW, next: 'nuova-frase-lunga-sicura' })).statusCode, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trusted_devices').get().n, 0, 'cambio password');
  PW = 'nuova-frase-lunga-sicura';

  s = await login(null, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trusted_devices').get().n, 1);
  assert.equal((await req('POST', '/api/v1/auth/mfa/disable', session(s.res), { password: PW, code: code() })).statusCode, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trusted_devices').get().n, 0, 'disattivazione 2FA');
});

test('nome del dispositivo dallo user agent', () => {
  assert.equal(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'), 'Safari · iOS');
  assert.equal(deviceLabel('Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36'), 'Chrome · Android');
  assert.equal(deviceLabel('curl/8.0'), 'Browser');
});
