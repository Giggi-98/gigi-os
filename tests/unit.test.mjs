import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Vault } from '../apps/api/dist/vault.js';
import { buildBlockList, safeFetch, validateUrl, TargetError } from '../apps/api/dist/ssrf.js';
import { hashPassword, verifyPassword, passwordProblems } from '../apps/api/dist/security.js';
import { redactEnv, redactLine, redactArgs, REDACTED } from '../apps/agent/dist/redact.js';

test('vault: cifra/decifra e lega il segreto all\'id (AAD)', () => {
  const v = new Vault(randomBytes(32));
  const enc = v.encrypt('{"apiKey":"abc"}', 'id-1');
  assert.ok(enc.startsWith('v1:'));
  assert.ok(!enc.includes('abc'));
  assert.equal(v.decrypt(enc, 'id-1'), '{"apiKey":"abc"}');
  assert.throws(() => v.decrypt(enc, 'id-2'));
  assert.throws(() => new Vault(randomBytes(32)).decrypt(enc, 'id-1'));
});

test('vault: rifiuta chiavi di lunghezza errata', () => {
  assert.throws(() => new Vault(randomBytes(16)));
});

test('ssrf: solo http/https e niente credenziali nell\'URL', () => {
  assert.throws(() => validateUrl('file:///etc/passwd'), TargetError);
  assert.throws(() => validateUrl('gopher://127.0.0.1'), TargetError);
  assert.throws(() => validateUrl('http://user:pw@127.0.0.1'), TargetError);
  assert.equal(validateUrl('http://127.0.0.1:8096').port, '8096');
});

test('ssrf: blocca destinazioni fuori dalle CIDR consentite', async () => {
  const bl = buildBlockList(['127.0.0.0/8', '192.168.222.0/24']);
  assert.ok(bl.check('192.168.222.200', 'ipv4'));
  assert.ok(!bl.check('169.254.169.254', 'ipv4'));
  await assert.rejects(safeFetch(bl, 'http://169.254.169.254/latest/meta-data'), (e) => e.code === 'forbidden_target');
  await assert.rejects(safeFetch(bl, 'http://10.0.0.1/'), (e) => e.code === 'forbidden_target');
  await assert.rejects(safeFetch(bl, 'http://[::ffff:a9fe:a9fe]/'), (e) => e.code === 'forbidden_target');
});

test('password: hash scrypt verificabile, salt diversi, policy', async () => {
  const h1 = await hashPassword('correct horse battery');
  const h2 = await hashPassword('correct horse battery');
  assert.notEqual(h1, h2);
  assert.ok(await verifyPassword('correct horse battery', h1));
  assert.ok(!(await verifyPassword('wrong password!!', h1)));
  assert.match(passwordProblems('short', 'gigi'), /12 caratteri/);
  assert.match(passwordProblems('gigi-supersegreta', 'gigi'), /nome utente/);
  assert.equal(passwordProblems('una-frase-lunga-sicura', 'gigi'), null);
});

test('redazione: env sensibili e valori opachi oscurati, innocui visibili', () => {
  const env = Object.fromEntries(
    redactEnv(['TZ=Europe/Rome', 'DB_PASSWORD=hunter2', 'JELLYFIN_API_KEY=x', 'RANDOM=aB3dE5fG7hJ9kL1mN3pQ5rS7tU', 'URL=http://u:segreto@host/x', 'PATH=/usr/bin:/bin']).map((e) => [e.key, e.value]),
  );
  assert.equal(env.TZ, 'Europe/Rome');
  assert.equal(env.DB_PASSWORD, REDACTED);
  assert.equal(env.JELLYFIN_API_KEY, REDACTED);
  assert.equal(env.RANDOM, REDACTED);
  assert.equal(env.URL, `http://u:${REDACTED}@host/x`);
  assert.equal(env.PATH, '/usr/bin:/bin');
});

test('redazione: righe di log e argomenti', () => {
  assert.ok(!redactLine('GET /Items?api_key=deadbeef123 200').includes('deadbeef123'));
  assert.ok(!redactLine('Authorization: Bearer abc.def.ghi').includes('abc.def.ghi'));
  assert.ok(!redactLine('password=hunter2 user=gigi').includes('hunter2'));
  assert.ok(redactLine('user=gigi').includes('gigi'));
  const jf = redactLine('SessionManager: Logging out access token 30f5f528374346ac929530db49de5ab6');
  assert.ok(!jf.includes('30f5f528374346ac929530db49de5ab6'), jf);
  assert.ok(redactLine('Creating new access token for user 348eb8d0').includes('348eb8d0'));
  assert.deepEqual(redactArgs(['--password', 'x', '--port', '80', '--token=abc']), ['--password', REDACTED, '--port', '80', `--token=${REDACTED}`]);
});

test('qbittorrent: autenticazione con API key Bearer (≥ 5.2)', async () => {
  const http = await import('node:http');
  const { qbittorrent } = await import('../apps/api/dist/connectors/qbittorrent.js');
  const srv = http.createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer qbt_giusta') return res.writeHead(403).end('Forbidden');
    if (req.url === '/api/v2/app/version') return res.end('v5.2.4');
    if (req.url.startsWith('/api/v2/torrents/info'))
      return res.end(JSON.stringify([{ hash: 'h', name: 'x', state: 'uploading', progress: 1, size: 1, dlspeed: 0, upspeed: 0, eta: 0, category: 'Anime', save_path: '/d', content_path: '/d/x', added_on: 1, completion_on: 2, ratio: 1, num_seeds: 0, num_leechs: 0, amount_left: 0 }]));
    res.writeHead(404).end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const bl = buildBlockList(['127.0.0.0/8']);
  const ctx = (key) => ({ id: 't', baseUrl: base, auth: 'apikey', secret: { apiKey: key }, config: {}, http: (p, i) => safeFetch(bl, base + p, i) });
  try {
    const ok = await qbittorrent.test(ctx('qbt_giusta'));
    assert.equal(ok.status, 'online');
    assert.equal(ok.version, 'v5.2.4');
    const list = await qbittorrent.resources.torrents(ctx('qbt_giusta'), new URLSearchParams());
    assert.equal(list[0].complete, true);
    await assert.rejects(qbittorrent.test(ctx('qbt_sbagliata')), (e) => e.status === 'unauthorized');
  } finally {
    srv.close();
  }
});

test('armony: chiave API Bearer, stato dal vivo, comandi limitati', async () => {
  const http = await import('node:http');
  const { armony } = await import('../apps/api/dist/connectors/others.js');
  const sent = [];
  const srv = http.createServer(async (req, res) => {
    let b = '';
    for await (const c of req) b += c;
    if (req.url === '/api/info') return res.end(JSON.stringify({ armony: true, api: 1, version: '0.68.0', name: 'Casa' }));
    if (req.headers.authorization !== 'Bearer arm_ok') return res.writeHead(401).end('{}');
    if (req.url === '/api/me') return res.end(JSON.stringify({ user: 'gg', admin: true, version: '0.68.0', perm: { stats: true, upload: false } }));
    if (req.url === '/api/live/stato')
      return res.end(JSON.stringify({ now: 1, devices: [{ device: 'tv', name: 'TV' }], states: [{ device: 'tv', name: 'TV', playing: true, position: 10, duration: 200, volume: 40, shuffle: false, repeat: 'off', at: 1, radio: null, track: { id: 'x', title: 'Brano', artist: 'Artista', album: 'Album', serverUrl: 'http://segreto' } }] }));
    if (req.url === '/api/live/cmd') {
      sent.push(JSON.parse(b));
      return res.end(JSON.stringify({ ok: true, id: 'c1' }));
    }
    res.writeHead(404).end('{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const bl = buildBlockList(['127.0.0.0/8']);
  const ctx = (key, auth = 'apikey') => ({ id: 'a', baseUrl: base, auth, secret: { apiKey: key }, config: {}, http: (p, i) => safeFetch(bl, base + p, i) });
  try {
    const ok = await armony.test(ctx('arm_ok'));
    assert.equal(ok.status, 'online');
    assert.match(ok.message, /gg \(amministratore\)/);
    assert.equal((await armony.test(ctx('arm_no'))).status, 'unauthorized');
    assert.equal((await armony.test(ctx('', 'none'))).status, 'online');
    const live = await armony.resources.live(ctx('arm_ok'), new URLSearchParams());
    assert.equal(live.devices[0].state.track.title, 'Brano');
    assert.ok(!JSON.stringify(live).includes('segreto'), 'campi interni non esposti');
    await armony.actions.command(ctx('arm_ok'), { to: 'tv', cmd: 'volume', value: 250 });
    assert.deepEqual(sent[0], { to: 'tv', cmd: 'volume', value: 100, from: 'GIGI OS' });
    await assert.rejects(armony.actions.command(ctx('arm_ok'), { to: 'tv', cmd: 'transfer' }), /non consentito/);
    await assert.rejects(armony.resources.live(ctx('', 'none'), new URLSearchParams()), /chiave API/);
  } finally {
    srv.close();
  }
});
