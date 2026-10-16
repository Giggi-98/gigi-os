// Rete: parser (UFW, ping), permessi e validazione degli input. Nessuna richiesta verso Internet.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { buildApp } from '../apps/api/dist/app.js';
import { openDb } from '../apps/api/dist/db.js';
import { Events } from '../apps/api/dist/events.js';
import { Integrations } from '../apps/api/dist/integrations.js';
import { Network, parsePing, parseUfwStatus } from '../apps/api/dist/network.js';
import { Audit, LoginLimiter, Sessions } from '../apps/api/dist/security.js';
import { buildBlockList } from '../apps/api/dist/ssrf.js';
import { Vault } from '../apps/api/dist/vault.js';

// Output reale di `ufw status verbose` sul mini PC (2026-10-16), ridotto
const UFW = `Status: active
Logging: on (low)
Default: deny (incoming), allow (outgoing), deny (routed)
New profiles: skip

To                         Action      From
--                         ------      ----
22/tcp                     ALLOW IN    Anywhere
3307/tcp                   ALLOW IN    Anywhere
5060/udp                   ALLOW IN    Anywhere
8123/tcp                   ALLOW IN    192.168.222.0/24           # Home Assistant LAN
8470/tcp                   ALLOW IN    192.168.222.0/24           # GIGI OS LAN
22/tcp (v6)                ALLOW IN    Anywhere (v6)
`;

test('parser UFW: stato, predefiniti, regole con commento e v6', () => {
  const r = parseUfwStatus(UFW);
  assert.equal(r.status, 'active');
  assert.equal(r.defaults, 'deny (incoming), allow (outgoing), deny (routed)');
  assert.equal(r.rules.length, 6);
  assert.deepEqual(r.rules[3], { to: '8123/tcp', port: 8123, proto: 'tcp', action: 'ALLOW IN', from: '192.168.222.0/24', v6: false, comment: 'Home Assistant LAN' });
  assert.equal(r.rules[5].v6, true);
  assert.equal(r.rules[5].from, 'Anywhere');
  assert.equal(parseUfwStatus('Status: inactive\n').rules.length, 0);
});

test('parser ping (iputils)', () => {
  const out = `PING 1.1.1.1 (1.1.1.1) 56(84) bytes of data.
64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=11.2 ms
64 bytes from 1.1.1.1: icmp_seq=2 ttl=57 time=10.8 ms

--- 1.1.1.1 ping statistics ---
3 packets transmitted, 2 received, 33.3333% packet loss, time 602ms
rtt min/avg/max/mdev = 10.800/11.000/11.200/0.200 ms`;
  assert.deepEqual(parsePing(out), { sent: 3, received: 2, min: 10.8, avg: 11, max: 11.2, jitter: 0.2, replies: [11.2, 10.8] });
});

let app, dir, db, admin, viewer;
const cookieOf = (res) => res.headers['set-cookie']?.toString().split(';')[0];
const fakeAgent = {
  async json(_m, p) {
    if (p === '/v1/containers') return [{ name: 'apollo', networkMode: 'bridge', ports: [{ ip: '0.0.0.0', private: 4173, public: 4173, type: 'tcp' }] }];
    if (p === '/v1/networks') return [];
    if (p.startsWith('/v1/firewall/blocked')) return { total: 0 };
    return {};
  },
};

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'gigi-net-'));
  db = openDb(dir);
  const events = new Events(db);
  let token = 'codice';
  app = await buildApp({
    db,
    agent: fakeAgent,
    integrations: new Integrations(db, new Vault(randomBytes(32)), buildBlockList(['127.0.0.0/8']), events),
    events,
    sessions: new Sessions(db, 3600_000, 86400_000),
    limiter: new LoginLimiter(db, 5),
    audit: new Audit(db),
    secureCookies: false,
    setupToken: () => token,
    consumeSetupToken: () => (token = null),
    network: new Network(db, dir, fakeAgent, events),
  });
  const s = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { username: 'gigi', password: 'una-frase-lunga-sicura', setupToken: 'codice' } });
  admin = { cookie: cookieOf(s), 'x-csrf-token': s.json().user.csrf };
  await app.inject({ method: 'POST', url: '/api/v1/users', headers: admin, payload: { username: 'ospite', password: 'altra-frase-lunga-sicura', role: 'viewer' } });
  const l = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'ospite', password: 'altra-frase-lunga-sicura' } });
  viewer = { cookie: cookieOf(l), 'x-csrf-token': l.json().user.csrf };
});

after(async () => {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('permessi: il viewer vede le schede ma non test, firewall, dispositivi', async () => {
  const ov = await app.inject({ method: 'GET', url: '/api/v1/network/overview', headers: viewer });
  assert.equal(ov.statusCode, 200);
  assert.ok(ov.json().interfaces.some((i) => i.name === 'lo'));
  for (const url of ['/api/v1/network/listening', '/api/v1/network/firewall', '/api/v1/network/devices', '/api/v1/network/public-ip', '/api/v1/network/connections'])
    assert.equal((await app.inject({ method: 'GET', url, headers: viewer })).statusCode, 403, url);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/network/test', headers: viewer, payload: { type: 'tcp', host: '127.0.0.1', port: 1 } })).statusCode, 403);
});

test('test di rete: input validati (niente opzioni iniettate né schemi non http)', async () => {
  const bad = [
    { type: 'ping', host: '-oProxyCommand=x' },
    { type: 'ping', host: 'a b' },
    { type: 'tracepath', host: '1.1.1.1;id' },
    { type: 'http', url: 'file:///etc/passwd' },
    { type: 'tcp', host: '127.0.0.1', port: 70000 },
    { type: 'dns', name: 'x', server: 'non-ip' },
    { type: 'shell', host: 'x' },
  ];
  for (const payload of bad) assert.equal((await app.inject({ method: 'POST', url: '/api/v1/network/test', headers: admin, payload })).statusCode, 400, JSON.stringify(payload));
  const r = await app.inject({ method: 'POST', url: '/api/v1/network/test', headers: admin, payload: { type: 'tcp', host: '127.0.0.1', port: 1 } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().ok, false);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'network.test.tcp'").get());
});

test('firewall: Docker su 0.0.0.0 segnalato; con istantanea, regola aperta senza servizio = forse obsoleta', async () => {
  let f = (await app.inject({ method: 'GET', url: '/api/v1/network/firewall', headers: admin })).json();
  assert.equal(f.snapshot, null);
  mkdirSync(path.join(dir, 'host'));
  writeFileSync(path.join(dir, 'host', 'ufw-status.txt'), UFW);
  f = (await app.inject({ method: 'GET', url: '/api/v1/network/firewall', headers: admin })).json();
  assert.equal(f.snapshot.rules.length, 6);
  assert.ok(f.findings.some((x) => /3307\/tcp aperta a chiunque, ma nessun servizio/.test(x.message)), JSON.stringify(f.findings));
});

test('Wake-on-LAN e dispositivi: MAC validato', async () => {
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/network/wol', headers: admin, payload: { mac: 'zz:11:22:33:44:55' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/v1/network/devices/..%2F', headers: admin })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/v1/network/monitor', headers: admin, payload: { publicIp: 'sì' } })).statusCode, 400);
});
