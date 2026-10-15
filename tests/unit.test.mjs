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
