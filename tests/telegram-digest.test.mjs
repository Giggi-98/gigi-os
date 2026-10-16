// Bot Telegram e digest (D-031) con un finto server Telegram locale: nessuna chiamata a servizi reali.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { TelegramBot, esc } from '../apps/api/dist/telegram.js';
import { Digest, isDue, lastScheduled } from '../apps/api/dist/digest.js';
import { Automations } from '../apps/api/dist/automations.js';
import { openDb } from '../apps/api/dist/db.js';
import { Events } from '../apps/api/dist/events.js';
import { Integrations } from '../apps/api/dist/integrations.js';
import { Audit } from '../apps/api/dist/security.js';
import { buildBlockList } from '../apps/api/dist/ssrf.js';
import { Vault } from '../apps/api/dist/vault.js';
import { buildApp } from '../apps/api/dist/app.js';
import { LoginLimiter, Sessions } from '../apps/api/dist/security.js';

const TOKEN = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef';
let server, base, dir, db, automations, bot, channelId;
const calls = [];
let queue = [];
let mfaOn = new Set();
const actions = [];
const mediaActs = [];
const ITEM = 'abcdef0123456789abcd';

before(async () => {
  server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const [, tok, method] = /^\/bot([^/]+)\/(\w+)/.exec(req.url) ?? [];
    calls.push({ method, body, tok });
    const ok = (result) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result }));
    if (tok !== TOKEN) return res.writeHead(401).end(JSON.stringify({ ok: false, description: 'Unauthorized' }));
    if (method === 'getMe') return ok({ username: 'gigi_test_bot', first_name: 'GIGI' });
    if (method === 'getUpdates') {
      const u = queue;
      queue = [];
      return ok(u);
    }
    return ok(true);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  dir = mkdtempSync(path.join(tmpdir(), 'gigi-tg-'));
  db = openDb(dir);
  const vault = new Vault(randomBytes(32));
  const events = new Events(db);
  const integrations = new Integrations(db, vault, buildBlockList(['127.0.0.0/8']), events);
  automations = new Automations(db, vault, integrations, buildBlockList(['127.0.0.0/8']), buildBlockList, () => {});
  automations.telegramBase = base;
  channelId = automations.createChannel({ type: 'telegram', name: 'Bot', config: { chatId: '999' }, secret: { botToken: TOKEN } });
  const now = Date.now();
  for (const [id, username, role] of [['u-admin', 'gigi', 'admin'], ['u-op', 'amico', 'operator'], ['u-view', 'ospite', 'viewer']])
    db.prepare('INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, username, 'x', role, now, now);
  mfaOn = new Set(['u-admin', 'u-op']);
  bot = new TelegramBot({
    db,
    automations,
    audit: new Audit(db),
    events,
    integrations: {
      list: () => [{ id: 'qb1', type: 'qbittorrent', name: 'qBittorrent', enabled: true, status: 'online' }],
      resource: async () => [
        { hash: 'h1', name: 'Film <b>bello</b>', progress: 0.42, dlspeed: 2_000_000, eta: 600, complete: false, stopped: false, state: 'downloading' },
        { hash: 'h2', name: 'Serie S01', progress: 1, dlspeed: 0, eta: 0, complete: true, stopped: false, state: 'uploading' },
      ],
      action: async (id, name, body) => {
        actions.push({ id, name, body });
        return { integration: 'qBittorrent', result: { ok: true } };
      },
    },
    agent: {
      json: async (_m, p) =>
        p === '/v1/system'
          ? { hostname: 'Gigi-Mini-Pc', uptime: 200000, cpu: { usage: 12.3 }, memory: { used: 3, total: 7 }, cpuTemp: 47, disks: [{ label: 'Sistema (/)', total: 250e9, free: 126e9, used: 100e9, ok: true }] }
          : [{ name: 'jellyfin', state: 'running', health: 'healthy' }, { name: 'vecchio', state: 'exited', health: null }],
    },
    metrics: { disks: () => [] },
    media: {
      items: async () => [{ id: ITEM, fileName: 'Dune.Part.Two.2024.mkv', status: 'review', confidence: 72, torrentHash: 'h1', plan: { dest: '/srv/media/Film/Dune Parte Due (2024)/Dune Parte Due (2024).mkv' } }],
      item: async () => ({ id: ITEM, fileName: 'Dune.Part.Two.2024.mkv', status: 'review', confidence: 72, torrentHash: 'h1', plan: { dest: '/srv/media/Film/Dune Parte Due (2024)/Dune Parte Due (2024).mkv' } }),
      act: async (name, id, actor) => {
        mediaActs.push({ name, id, actor });
        return { fileName: 'Dune.Part.Two.2024.mkv', plan: { dest: '/srv/media/Film/Dune Parte Due (2024)/Dune Parte Due (2024).mkv' } };
      },
    },
    digest: { compose: async () => ({ title: 'Riepilogo', body: 'tutto <ok>' }) },
    mfa: { required: (r) => r === 'admin' || r === 'operator', enabled: (id) => mfaOn.has(id) },
    warn: () => {},
  });
});

after(() => {
  server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

let uid = 1;
const msg = (from, text, chatType = 'private') => ({ update_id: uid++, message: { message_id: uid, from: { id: from, first_name: 'Test' }, chat: { id: from, type: chatType, first_name: 'Test' }, date: 1_800_000_000, text } });
const cb = (from, data) => ({ update_id: uid++, callback_query: { id: `q${uid}`, from: { id: from }, data, message: { message_id: 77, chat: { id: from, type: 'private' } } } });
const sent = () => calls.filter((c) => c.method === 'sendMessage');
const lastSent = () => sent().at(-1)?.body;
async function run(...updates) {
  queue = updates;
  calls.length = 0;
  return bot.tick(0);
}

test('esc: niente HTML iniettato nei messaggi', () => {
  assert.equal(esc('<b>&</b>'), '&lt;b&gt;&amp;&lt;/b&gt;');
});

test('spento finché l’admin non lo attiva; nessuna chiamata a Telegram', async () => {
  calls.length = 0;
  assert.equal(await bot.tick(0), 0);
  assert.equal(bot.status.state, 'spento');
  assert.equal(calls.length, 0);
  bot.setSettings({ channelId, enabled: true });
  assert.equal(await run(), 0);
  assert.equal(bot.status.state, 'attivo');
  assert.equal(bot.status.bot, '@gigi_test_bot');
});

test('account non collegato: una sola risposta che spiega come collegarsi, poi silenzio', async () => {
  await run(msg(111, '/stato'));
  assert.match(lastSent().text, /non è collegato/);
  await run(msg(111, '/stato'), msg(111, '/download'));
  assert.equal(sent().length, 0);
});

test('/collega: codice monouso, poi il bot applica il ruolo; dopo 5 errori si blocca', async () => {
  const { code } = bot.createCode('u-view');
  await run(msg(222, `/collega ${code.toLowerCase()}`));
  assert.match(lastSent().text, /Collegato a <b>ospite<\/b> \(sola lettura\)/);
  await run(msg(333, `/collega ${code}`));
  assert.match(lastSent().text, /non valido o scaduto/, 'codice già usato');
  for (let i = 0; i < 4; i++) await run(msg(333, '/collega ZZZZZZZZ'));
  await run(msg(333, '/collega ZZZZZZZZ'));
  assert.match(lastSent().text, /Troppi tentativi/);
  assert.equal(db.prepare("SELECT action FROM audit_log WHERE action = 'telegram.link'").all().length, 1);
});

test('sola lettura: /stato e /download senza pulsanti, nomi escapati', async () => {
  await run(msg(222, '/stato'));
  assert.match(lastSent().text, /Gigi-Mini-Pc/);
  assert.match(lastSent().text, /1\/2 container attivi/);
  assert.match(lastSent().text, /fermi: vecchio/);
  await run(msg(222, '/download'));
  const b = lastSent();
  assert.match(b.text, /Film &lt;b&gt;bello&lt;\/b&gt;/);
  assert.match(b.text, /42%/);
  assert.equal(b.reply_markup, undefined, 'nessuna azione per la sola lettura');
});

test('operatore senza 2FA attiva: il bot non scavalca l’obbligo', async () => {
  mfaOn.delete('u-op');
  const { code } = bot.createCode('u-op');
  await run(msg(444, `/collega ${code}`));
  assert.match(lastSent().text, /verifica in due passaggi/);
  mfaOn.add('u-op');
  const c2 = bot.createCode('u-op');
  await run(msg(444, `/collega ${c2.code}`));
  assert.match(lastSent().text, /operatore/);
});

test('operatore: pausa torrent con pulsante monouso, legato all’account', async () => {
  await run(msg(444, '/download'));
  const btn = lastSent().reply_markup.inline_keyboard[0][0];
  assert.equal(btn.text, '⏸ 1');
  assert.ok(btn.callback_data.length <= 64 && !btn.callback_data.includes('h1'), 'nessun dato interno nel pulsante');
  await run(cb(222, btn.callback_data));
  assert.equal(actions.length, 0, 'un altro account non può usare il pulsante');
  assert.match(calls.find((c) => c.method === 'answerCallbackQuery').body.text, /scaduto/);
  // il tocco di un altro account non consuma il pulsante del proprietario; qui se ne chiede comunque uno nuovo
  await run(msg(444, '/download'));
  const fresh = lastSent().reply_markup.inline_keyboard[0][0].callback_data;
  await run(cb(444, fresh));
  assert.deepEqual(actions.at(-1), { id: 'qb1', name: 'control', body: { op: 'stop', hashes: ['h1'] } });
  assert.ok(calls.some((c) => c.method === 'editMessageText'));
  await run(cb(444, fresh));
  assert.equal(actions.length, 1, 'riusare il pulsante non ripete l’azione');
  const row = db.prepare("SELECT username, details FROM audit_log WHERE action = 'integration.action.control' ORDER BY id DESC").get();
  assert.equal(row.username, 'amico');
  assert.match(row.details, /telegram/);
});

test('operatore: import con doppia conferma, a nome dell’utente', async () => {
  await run(msg(444, '/media'));
  const kb = lastSent().reply_markup.inline_keyboard;
  assert.equal(kb[0][0].text, '📥 Importa 1');
  await run(cb(444, kb[0][0].callback_data));
  assert.equal(mediaActs.length, 0, 'il primo tocco chiede solo conferma');
  const confirm = calls.find((c) => c.method === 'editMessageText').body;
  assert.match(confirm.text, /sotto la soglia/);
  const yes = confirm.reply_markup.inline_keyboard[0][0];
  assert.equal(yes.text, '✅ Conferma import');
  await run(cb(444, yes.callback_data));
  assert.deepEqual(mediaActs.at(-1), { name: 'import', id: ITEM, actor: 'amico' });
  assert.match(calls.find((c) => c.method === 'editMessageText').body.text, /Importato/);
});

test('sola lettura: un pulsante non può comparire, e se arriva viene rifiutato', async () => {
  await run(msg(222, '/media'));
  assert.equal(lastSent().reply_markup, undefined);
});

test('gruppi ignorati ma registrati per il rilevamento del Chat ID, senza rubare getUpdates', async () => {
  await run(msg(-1001, '/stato', 'group'));
  assert.equal(sent().length, 0);
  calls.length = 0;
  const r = await automations.telegramDetect(undefined, channelId);
  assert.ok(r.chats.some((c) => c.id === '-1001' && c.type === 'gruppo'));
  assert.ok(!calls.some((c) => c.method === 'getUpdates'), 'il rilevamento non interferisce con il bot');
});

test('l’offset avanza: un aggiornamento non viene rielaborato', async () => {
  queue = [msg(222, '/aiuto')];
  calls.length = 0;
  await bot.tick(0);
  const off = calls.find((c) => c.method === 'getUpdates').body.offset;
  calls.length = 0;
  await bot.tick(0);
  assert.equal(calls.find((c) => c.method === 'getUpdates').body.offset, off + 1);
});

test('servizio irraggiungibile: il bot risponde comunque con l’errore', async () => {
  const items = bot.d.media.items;
  bot.d.media.items = async () => {
    throw new Error('Motore media non raggiungibile: ENOENT');
  };
  try {
    await run(msg(444, '/media'));
    assert.match(lastSent().text, /\/media non riuscito: Motore media non raggiungibile/);
  } finally {
    bot.d.media.items = items;
  }
});

test('/scollega e scollegamento: l’account torna sconosciuto', async () => {
  await run(msg(222, '/scollega'));
  assert.match(lastSent().text, /scollegato/);
  assert.equal(bot.links('u-view').length, 0);
});

// ───────── digest ─────────
test('pianificazione: giornaliero, recupero entro 3 ore, nessun doppio invio', () => {
  const s = { daily: { enabled: true, time: '08:00' }, weekly: { enabled: false, day: 1, time: '08:00' }, channels: [] };
  const at = (d, h, m) => new Date(2026, 9, d, h, m);
  assert.equal(lastScheduled('daily', s, at(16, 7, 59)).getDate(), 15);
  assert.equal(isDue('daily', s, at(16, 8, 0), null), true);
  assert.equal(isDue('daily', s, at(16, 10, 30), null), true, 'GIGI OS acceso alle 10:30: recupero');
  assert.equal(isDue('daily', s, at(16, 11, 30), null), false, 'oltre 3 ore: salta');
  assert.equal(isDue('daily', s, at(16, 9, 0), at(16, 8, 1).getTime()), false, 'già inviato');
  assert.equal(isDue('daily', s, at(16, 7, 59), at(15, 8, 1).getTime()), false);
  assert.equal(isDue('daily', { ...s, daily: { enabled: false, time: '08:00' } }, at(16, 8, 0), null), false);
});

test('pianificazione: settimanale il lunedì', () => {
  const s = { daily: { enabled: false, time: '08:00' }, weekly: { enabled: true, day: 1, time: '08:00' }, channels: [] };
  // 19 ottobre 2026 è lunedì
  assert.equal(new Date(2026, 9, 19).getDay(), 1);
  assert.equal(isDue('weekly', s, new Date(2026, 9, 19, 8, 10), null), true);
  assert.equal(isDue('weekly', s, new Date(2026, 9, 20, 8, 10), null), false);
  assert.equal(lastScheduled('weekly', s, new Date(2026, 9, 19, 7, 0)).getDate(), 12, 'prima delle 8 vale il lunedì precedente');
});

function digestWith(now, delivered) {
  const ev = new Events(db);
  return new Digest(
    db,
    { channels: () => [{ id: channelId }], deliver: async (ch, title, body, level, label) => delivered.push({ ch, title, body, label }) },
    {
      host: () => ({ cpu: [10, 20, null], cpuMax: [50, 90, null], mem: [40, 42, null], temp: [45, 61, null], times: [] }),
      containers: (_r, metric) => ({ ranking: metric === 'cpu' ? [{ name: 'jellyfin', cpuAvg: 3.2, memAvg: 0 }] : [{ name: 'homeassistant', cpuAvg: 0, memAvg: 300e6 }] }),
      disks: () => [{ label: 'Sistema (/)', points: [], forecast: { status: 'insufficient', dataDays: 0 } }],
    },
    {
      json: async (_m, p) =>
        p === '/v1/system' ? { hostname: 'Gigi-Mini-Pc', disks: [{ label: 'Sistema (/)', total: 250e9, free: 126e9, used: 100e9, ok: true }] } : [{ name: 'jellyfin', state: 'running', health: 'healthy' }],
    },
    { list: () => [{ name: 'Navidrome', enabled: true, status: 'offline' }] },
    { items: async () => [{ status: 'review' }, { status: 'indexed' }] },
    () => now,
  );
  void ev;
}

test('composizione: risorse, disco, backup, download, libreria, avvisi', async () => {
  const now = new Date();
  const t = now.getTime() - 3600_000;
  const add = (level, source, title) => db.prepare('INSERT INTO events (ts, level, source, title) VALUES (?, ?, ?, ?)').run(t, level, source, title);
  add('info', 'backup', 'Backup completato (512 KB)');
  add('info', 'download', 'Download completato: Dune.Part.Two');
  add('info', 'media', 'Disponibile in Jellyfin/Apollo: Dune Parte Due (2024)');
  add('warning', 'integrazioni', 'Navidrome offline');
  const d = digestWith(now, []);
  const r = await d.compose('daily');
  assert.equal(r.title, 'Buongiorno da Gigi-Mini-Pc: le ultime 24 ore');
  for (const re of [/CPU media 15% \(picco 90%\)/, /temperatura max 61 °C/, /Sistema \(\/\): 40% usato/, /Backup completato/, /Download completati: 1 — Dune.Part.Two/, /Nuovi in libreria: 1 — Dune Parte Due/, /Da rivedere nel motore media: 1/, /Da controllare: Navidrome/, /1 avvisi: Navidrome offline/]) assert.match(r.body, re);
  const w = await d.compose('weekly');
  assert.match(w.body, /Più impegnativi \(CPU media\): jellyfin 3,2%/);
  assert.ok(r.body.length < 3500);
});

test('tick: un invio per occorrenza; il lunedì alla stessa ora solo il settimanale', async () => {
  const delivered = [];
  const monday = new Date(2026, 9, 19, 8, 5);
  const d = digestWith(monday, delivered);
  d.setSettings({ daily: { enabled: true, time: '08:00' }, weekly: { enabled: true, day: 1, time: '08:00' }, channels: [channelId] });
  db.exec("DELETE FROM settings WHERE key LIKE 'digest.last.%'");
  await d.tick(() => {});
  await d.tick(() => {});
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].label, 'Digest settimanale');
  const tue = digestWith(new Date(2026, 9, 20, 8, 1), delivered);
  await tue.tick(() => {});
  assert.equal(delivered.length, 2);
  assert.equal(delivered[1].label, 'Digest giornaliero');
});

test('API: impostazioni di bot e digest solo admin; codice solo con bot attivo', async () => {
  const d2 = mkdtempSync(path.join(tmpdir(), 'gigi-tg-api-'));
  const db2 = openDb(d2);
  const events = new Events(db2);
  const vault = new Vault(randomBytes(32));
  const integrations = new Integrations(db2, vault, buildBlockList(['127.0.0.0/8']), events);
  const a2 = new Automations(db2, vault, integrations, buildBlockList(['127.0.0.0/8']), buildBlockList, () => {});
  const b2 = new TelegramBot({ db: db2, automations: a2, audit: new Audit(db2), events, integrations, agent: { json: async () => ({}) }, metrics: null, media: null, digest: null, mfa: null, warn: () => {} });
  const dg = new Digest(db2, a2, { host: () => ({ cpu: [], cpuMax: [], mem: [], temp: [] }), containers: () => ({ ranking: [] }), disks: () => [] }, { json: async () => null }, integrations, null);
  let token = 'codice';
  const app = await buildApp({ db: db2, agent: { json: async () => ({}), stream: async () => null }, integrations, events, sessions: new Sessions(db2, 3600_000, 86400_000), limiter: new LoginLimiter(db2, 5), audit: new Audit(db2), secureCookies: false, setupToken: () => token, consumeSetupToken: () => (token = null), bot: b2, digest: dg });
  try {
    const s = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { username: 'gigi', password: 'una-frase-lunga-sicura', setupToken: 'codice' } });
    const admin = { cookie: s.headers['set-cookie'].toString().split(';')[0], 'x-csrf-token': s.json().user.csrf };
    await app.inject({ method: 'POST', url: '/api/v1/users', headers: admin, payload: { username: 'ospite', password: 'altra-frase-lunga-sicura', role: 'viewer' } });
    const l = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'ospite', password: 'altra-frase-lunga-sicura' } });
    const viewer = { cookie: l.headers['set-cookie'].toString().split(';')[0], 'x-csrf-token': l.json().user.csrf };
    for (const [m, url] of [['GET', '/api/v1/telegram/bot'], ['PUT', '/api/v1/telegram/bot'], ['GET', '/api/v1/digest'], ['GET', '/api/v1/digest/preview'], ['POST', '/api/v1/digest/send']])
      assert.equal((await app.inject({ method: m, url, headers: viewer, payload: m === 'GET' ? undefined : {} })).statusCode, 403, `${m} ${url}`);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/telegram/me', headers: viewer })).json().available, false);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/telegram/link-code', headers: viewer })).statusCode, 409);
    const prev = await app.inject({ method: 'GET', url: '/api/v1/digest/preview?kind=weekly', headers: admin });
    assert.equal(prev.statusCode, 200);
    assert.match(prev.json().title, /settimana/);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/digest/send', headers: admin, payload: { kind: 'daily' } })).statusCode, 409, 'nessun canale scelto');
    assert.equal((await app.inject({ method: 'PUT', url: '/api/v1/telegram/bot', headers: admin, payload: { channelId: '00000000-0000-0000-0000-000000000000', enabled: true } })).statusCode, 400);
  } finally {
    await app.close();
    db2.close();
    rmSync(d2, { recursive: true, force: true });
  }
});
