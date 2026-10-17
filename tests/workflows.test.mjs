// D-041: flussi — espressioni, validazione, esecuzione, attese, conferme, webhook, polling, pianificazione, modelli.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { openDb } from '../apps/api/dist/db.js';
import { Vault } from '../apps/api/dist/vault.js';
import { Workflows } from '../apps/api/dist/workflows/engine.js';
import { render } from '../apps/api/dist/workflows/expr.js';
import { pickTorrents, compare } from '../apps/api/dist/workflows/nodes.js';
import { TEMPLATES } from '../apps/api/dist/workflows/routes.js';

let dir, db;
before(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'gigi-wf-'));
  db = openDb(dir);
});
after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const T0 = Date.parse('2026-11-01T10:00:00');
/** Servizi simulati: orologio controllabile, notifiche, eventi, qBittorrent e Jellyfin finti */
function make({ results = [], library = [] } = {}) {
  const calls = { notify: [], events: [], actions: [], approvals: [] };
  let now = T0;
  const deps = {
    integration: (type) => ({ qbittorrent: { id: 'qb', name: 'qB' }, jellyfin: { id: 'jf', name: 'JF' } })[type] ?? null,
    integrationAction: async (id, name, body) => {
      calls.actions.push([name, body]);
      if (name === 'searchStart') return { id: 7 };
      if (name === 'searchResults') return { status: 'Stopped', results };
      if (name === 'add') return { ok: true, hashes: ['h1'] };
      return { ok: true };
    },
    integrationResource: async (_id, name, params) => (name === 'search' ? library.filter((l) => l.name.toLowerCase().includes(params.get('q').toLowerCase())) : []),
    notify: async (c, title, body) => calls.notify.push({ c, title, body }),
    channelIds: () => ['ch1'],
    event: (level, title) => {
      calls.events.push(title);
      wf.onEvent({ level, source: 'automazioni', title });
    },
    fetchOut: async () => ({ status: 200, text: '[]', type: 'application/json' }),
    docker: async () => {},
    rescanLibrary: async () => {},
    sleep: async () => {},
    now: () => now,
    log: () => {},
  };
  const wf = new Workflows(db, new Vault(randomBytes(32)), deps);
  wf.approvalSender = async (a) => calls.approvals.push(a);
  return { wf, deps, calls, setNow: (t) => (now = t), get now() { return now; } };
}
const n = (id, type, name, config = {}, x = 0) => ({ id, type, name, config, position: { x, y: 0 } });
const e = (source, port, target) => ({ id: `${source}-${port}-${target}`, source, port, target });
const settle = async (wf, runId) => {
  for (let i = 0; i < 200; i++) {
    const r = wf.run(runId);
    if (r.status !== 'running') return r;
    await new Promise((res) => setImmediate(res));
  }
  return wf.run(runId);
};

test('espressioni: valore intero, testo, limite contro la ricorsione infinita', async () => {
  const scope = { json: { title: 'Matrix', year: 1999, list: [1, 2] }, trigger: { body: { a: 'x' } }, node: {}, now: 0 };
  assert.equal(await render('{{ json.year }}', scope), 1999);
  assert.deepEqual(await render('{{ json.list }}', scope), [1, 2]);
  assert.equal(await render('{{ json.title }} ({{ json.year }}) {{ trigger.body.a }}', scope), 'Matrix (1999) x');
  assert.equal(await render('{{ json.manca }}', scope), null);
  await assert.rejects(render('{{ ($f := function($n){ $f($n + 1) }; $f(0)) }}', scope), /profonda|lenta/);
  await assert.rejects(render('{{ json. }}', scope), /Espressione/);
});

test('condizioni e scelta dei torrent', () => {
  assert.ok(compare('Confermato', 'eq', 'confermato', 0));
  assert.ok(compare(['a', 'b'], 'contains', 'b', 0));
  assert.ok(compare('2026-01-01', 'before', null, T0));
  assert.ok(!compare('', 'exists', null, 0));
  const t = (name, seeders, gb) => ({ name, url: `magnet:?xt=urn:btih:${name}`, size: gb * 1024 ** 3, seeders, leechers: 0, plugin: 'p', engine: 'e', info: null });
  const r = pickTorrents([t('Film 2160p ITA', 50, 20), t('Film 1080p ITA', 10, 4), t('Film 1080p ENG', 99, 4), t('Film CAM ITA', 99, 1), t('Film 720p ITA', 0, 2)], {
    include: '\\bita\\b',
    exclude: '\\bcam\\b',
    minSeeds: 1,
    prefer: ['1080p', '2160p'],
  });
  assert.deepEqual(r.map((x) => x.name), ['Film 1080p ITA', 'Film 2160p ITA'], 'lingua, esclusioni, seed, ordine di qualità');
});

test('validazione: cicli, ingressi nei blocchi di ricezione, uscite inesistenti, nomi doppi', () => {
  const { wf } = make();
  const base = [n('t', 'trigger.manual', 'Avvio'), n('a', 'logic.set', 'A'), n('b', 'logic.set', 'B')];
  assert.throws(() => wf.create('x', { nodes: base, edges: [e('t', 'out', 'a'), e('a', 'out', 'b'), e('b', 'out', 'a')] }, 'admin'), /ciclo/);
  assert.throws(() => wf.create('x', { nodes: base, edges: [e('a', 'out', 't')] }, 'admin'), /ricezione/);
  assert.throws(() => wf.create('x', { nodes: base, edges: [e('t', 'nope', 'a')] }, 'admin'), /Uscita/);
  assert.throws(() => wf.create('x', { nodes: [...base, n('c', 'logic.set', 'a')], edges: [] }, 'admin'), /Due blocchi/);
  assert.throws(() => wf.create('x', { nodes: [n('a', 'logic.set', 'A')], edges: [] }, 'admin'), /almeno un blocco di ricezione/);
  assert.throws(() => wf.create('x', { nodes: [n('t', 'trigger.manual', 'T'), n('w', 'logic.wait', 'W', { mode: 'until', until: '{{ json. }}' })], edges: [] }, 'admin'), /Espressione non valida/);
  for (const t of TEMPLATES) assert.ok(wf.create(t.name, structuredClone(t.graph), 'admin').id, `modello ${t.id} valido`);
});

test('esecuzione: filtro, campi, notifica; storico per blocco', async () => {
  const { wf, calls } = make();
  const f = wf.create(
    'Prova',
    {
      nodes: [
        n('t', 'trigger.manual', 'Avvio', { sample: '{"status":"confermato","title":"Matrix"}' }),
        n('f', 'logic.filter', 'Confermato?', { conditions: [{ left: '{{ json.status }}', op: 'eq', right: 'confermato' }] }),
        n('s', 'logic.set', 'Dati', { fields: [{ name: 'titolo', value: '{{ json.title }} ({{ node.Avvio.status }})' }] }),
        n('no', 'action.notify', 'No', { title: 'no' }),
        n('ok', 'action.notify', 'Sì', { title: '{{ json.titolo }}' }),
      ],
      edges: [e('t', 'out', 'f'), e('f', 'true', 's'), e('f', 'false', 'no'), e('s', 'out', 'ok')],
    },
    'admin',
  );
  const r = await settle(wf, wf.manual(f.id));
  assert.equal(r.status, 'success', r.error);
  assert.deepEqual(r.steps.map((s) => [s.name, s.status, s.port]), [['Avvio', 'ok', 'out'], ['Confermato?', 'ok', 'true'], ['Dati', 'ok', 'out'], ['Sì', 'ok', 'out']]);
  assert.deepEqual(calls.notify.map((x) => x.title), ['Matrix (confermato)']);
  const bad = await settle(wf, wf.manual(f.id, undefined, { status: 'bozza' }));
  assert.equal(bad.steps.at(-1).name, 'No');
});

test('errore in un blocco: esecuzione in errore ed evento, nessun blocco successivo', async () => {
  const { wf, calls } = make();
  const f = wf.create('Rotto', { nodes: [n('t', 'trigger.manual', 'Avvio'), n('w', 'logic.wait', 'Attendi', { mode: 'until', until: 'non una data' }), n('x', 'action.notify', 'Dopo')], edges: [e('t', 'out', 'w'), e('w', 'out', 'x')] }, 'admin');
  const r = await settle(wf, wf.manual(f.id));
  assert.equal(r.status, 'error');
  assert.match(r.error, /Attendi: Data non riconosciuta/);
  assert.equal(calls.notify.length, 0);
  assert.ok(calls.events.some((t) => /non riuscito/.test(t)));
});

test('attesa fino a una data con anticipo: in attesa, poi riprende al momento giusto', async () => {
  const ctx = make();
  const { wf, calls } = ctx;
  const f = wf.create(
    'Attesa',
    { nodes: [n('t', 'trigger.manual', 'Avvio'), n('w', 'logic.wait', 'Prima', { mode: 'until', until: '{{ json.date }}', offsetHours: 48 }), n('x', 'action.notify', 'Ora', { title: 'via' })], edges: [e('t', 'out', 'w'), e('w', 'out', 'x')] },
    'admin',
  );
  const id = wf.manual(f.id, undefined, { date: '2026-11-10' });
  assert.equal((await settle(wf, id)).status, 'waiting');
  ctx.setNow(Date.parse('2026-11-07T23:59:00'));
  await wf.tick();
  assert.equal(wf.run(id).status, 'waiting', 'non prima di 48 ore dalla data');
  ctx.setNow(Date.parse('2026-11-08T00:00:01'));
  await wf.tick();
  const r = await settle(wf, id);
  assert.equal(r.status, 'success');
  assert.equal(calls.notify.length, 1);
  // Data già passata: prosegue subito
  assert.equal((await settle(wf, wf.manual(f.id, undefined, { date: '2020-01-01' }))).status, 'success');
});

test('conferma: un pulsante per opzione, risposta una sola volta, scadenza', async () => {
  const ctx = make();
  const { wf, calls } = ctx;
  const f = wf.create(
    'Conferma',
    {
      nodes: [
        n('t', 'trigger.manual', 'Avvio'),
        n('a', 'logic.approval', 'Quale?', { message: 'Scegli per {{ json.title }}', options: '{{ json.list }}', optionLabel: 'name & " · " & $string(seeds)', timeoutHours: 1 }),
        n('y', 'action.notify', 'Scelto', { title: '{{ json.approval.value.name }} da {{ json.approval.by }}' }),
        n('to', 'action.notify', 'Scaduto', { title: 'scaduto' }),
      ],
      edges: [e('t', 'out', 'a'), e('a', 'approved', 'y'), e('a', 'timeout', 'to')],
    },
    'admin',
  );
  const id = wf.manual(f.id, undefined, { title: 'Matrix', list: [{ name: 'A', seeds: 5 }, { name: 'B', seeds: 9 }] });
  assert.equal((await settle(wf, id)).status, 'waiting');
  assert.deepEqual(calls.approvals[0].options.map((o) => o.label), ['A · 5', 'B · 9']);
  assert.equal(calls.approvals[0].message, 'Scegli per Matrix');
  const [p] = wf.pendingApprovals();
  assert.equal(p.workflow, 'Conferma');
  await wf.decide(p.id, 1, 'gigi');
  await assert.rejects(wf.decide(p.id, 0, 'gigi'), /già gestita/);
  assert.equal((await settle(wf, id)).status, 'success');
  assert.deepEqual(calls.notify.map((x) => x.title), ['B da gigi']);
  // Scadenza
  const id2 = wf.manual(f.id, undefined, { title: 'X', list: [] });
  await settle(wf, id2);
  ctx.setNow(ctx.now + 2 * 3600_000);
  await wf.tick();
  assert.equal((await settle(wf, id2)).status, 'success');
  assert.equal(calls.notify.at(-1).title, 'scaduto');
});

test('webhook: token obbligatorio, campione salvato anche da spento, avvio da acceso', async () => {
  const { wf } = make();
  const f = wf.create('Hook', { nodes: [n('h', 'trigger.webhook', 'Arriva'), n('s', 'logic.set', 'Dati', { fields: [{ name: 't', value: '{{ trigger.body.title }}' }], keep: false })], edges: [e('h', 'out', 's')] }, 'admin');
  assert.throws(() => wf.update(f.id, { enabled: true }), /token/);
  const token = wf.newWebhookToken(f.id, 'h');
  assert.match(token, /^gwh_/);
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM workflow_secrets').all()).includes(token), 'nel database solo l’hash');
  await assert.rejects(wf.webhook(f.id, 'h', 'sbagliato', {}), (e) => e.statusCode === 401);
  await assert.rejects(wf.webhook(f.id, 'h', null, {}), (e) => e.statusCode === 401);
  const off = await wf.webhook(f.id, 'h', token, { body: { title: 'Dune' } });
  assert.equal(off.accepted, false);
  assert.deepEqual(wf.sample(f.id, 'h'), { body: { title: 'Dune' } });
  wf.update(f.id, { enabled: true });
  const on = await wf.webhook(f.id, 'h', token, { body: { title: 'Dune' } });
  const r = await settle(wf, on.runId);
  assert.equal(r.status, 'success');
  assert.match(r.steps.at(-1).output, /"t":"Dune"/);
  // Un token nuovo invalida il precedente
  const t2 = wf.newWebhookToken(f.id, 'h');
  await assert.rejects(wf.webhook(f.id, 'h', token, {}), (e) => e.statusCode === 401);
  assert.equal((await wf.webhook(f.id, 'h', t2, { body: {} })).accepted, true);
});

test('eventi: avvio sugli eventi di GIGI OS, mai sugli eventi scritti dai flussi; limite di esecuzioni', async () => {
  const { wf } = make();
  const f = wf.create(
    'Eventi',
    { nodes: [n('ev', 'trigger.event', 'Evento', { sources: [], minLevel: 'info' }), n('w', 'action.event', 'Scrivi', { title: 'eco {{ json.title }}' })], edges: [e('ev', 'out', 'w')] },
    'admin',
  );
  wf.update(f.id, { enabled: true });
  wf.onEvent({ level: 'info', source: 'media', title: 'Disponibile in Jellyfin: Dune' });
  await new Promise((r) => setTimeout(r, 20));
  const runs = wf.runs(f.id);
  assert.equal(runs.length, 1, 'l’evento scritto dal flusso non lo fa ripartire');
  for (let i = 0; i < 70; i++) wf.onEvent({ level: 'info', source: 'docker', title: `x${i}` });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(wf.runs(f.id, 200).length, 60, 'massimo 60 esecuzioni in 10 minuti');
  wf.update(f.id, { enabled: false });
});

test('polling: il primo controllo ricorda senza partire, poi parte solo per i nuovi', async () => {
  const ctx = make();
  const { wf, deps } = ctx;
  let list = [{ id: 1, t: 'a' }];
  deps.fetchOut = async () => ({ status: 200, text: JSON.stringify({ data: list }), type: 'application/json' });
  const f = wf.create('Poll', { nodes: [n('p', 'trigger.http', 'API', { url: 'https://esempio.it/x', items: 'data', id: 'id', minutes: 5 }), n('s', 'logic.set', 'S')], edges: [e('p', 'out', 's')] }, 'admin');
  wf.update(f.id, { enabled: true });
  await wf.tick();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(wf.runs(f.id).length, 0);
  list = [{ id: 2, t: 'b' }, { id: 1, t: 'a' }];
  await wf.tick();
  assert.equal(wf.runs(f.id).length, 0, 'prima dell’intervallo non controlla');
  ctx.setNow(ctx.now + 5 * 60_000);
  await wf.tick();
  await new Promise((r) => setTimeout(r, 20));
  const runs = wf.runs(f.id);
  assert.equal(runs.length, 1);
  assert.match(wf.run(runs[0].id).steps[0].output, /"t":"b"/);
  wf.update(f.id, { enabled: false });
});

test('pianificazione: prossima scadenza giornaliera e settimanale in ora locale', () => {
  const from = new Date(2026, 10, 2, 9, 0).getTime(); // lunedì 2 novembre, 9:00
  assert.equal(Workflows.nextAt({ mode: 'daily', time: '08:00' }, from), new Date(2026, 10, 3, 8, 0).getTime());
  assert.equal(Workflows.nextAt({ mode: 'daily', time: '10:30' }, from), new Date(2026, 10, 2, 10, 30).getTime());
  assert.equal(Workflows.nextAt({ mode: 'weekly', time: '08:00', days: ['5'] }, from), new Date(2026, 10, 6, 8, 0).getTime());
  assert.equal(Workflows.nextAt({ mode: 'interval', minutes: 15 }, from), from + 15 * 60_000);
});

test('comando Telegram: avvia i flussi con quel comando, con gli argomenti', async () => {
  const { wf } = make();
  const f = wf.create('Tg', { nodes: [n('c', 'trigger.telegram', 'Cmd', { command: '/film' }), n('s', 'logic.set', 'S', { fields: [{ name: 'q', value: '{{ trigger.args }}' }] })], edges: [e('c', 'out', 's')] }, 'admin');
  assert.deepEqual(wf.telegramCommand('/film', '/film Matrix 1999', { username: 'gigi', role: 'operator' }), [], 'flusso spento');
  wf.update(f.id, { enabled: true });
  assert.deepEqual(wf.telegramCommand('/film', '/film Matrix 1999', { username: 'gigi', role: 'operator' }), ['Tg']);
  await new Promise((r) => setTimeout(r, 20));
  assert.match(wf.run(wf.runs(f.id)[0].id).steps.at(-1).output, /"q":"Matrix 1999"/);
  wf.update(f.id, { enabled: false });
});

test('modello Borollo dall’inizio alla fine: attesa, ricerca in italiano, scelta, download, notifica', async () => {
  const t = (name, seeders, gb) => ({ name, url: `magnet:?xt=urn:btih:${seeders}`, size: gb * 1024 ** 3, seeders, leechers: 0, plugin: 'corsaro', engine: 'x', info: null });
  const ctx = make({ results: [t('Dune 2021 1080p ITA ENG', 40, 3), t('Dune 2021 2160p ITA', 20, 15), t('Dune 2021 1080p ENG', 300, 3)], library: [{ id: 'z', name: 'Altro film', type: 'Movie', year: 2000 }] });
  const { wf, calls } = ctx;
  const tpl = TEMPLATES.find((x) => x.id === 'borollo');
  const f = wf.create('Borollo', structuredClone(tpl.graph), 'admin');
  const token = wf.newWebhookToken(f.id, 'hook');
  wf.update(f.id, { enabled: true });
  const r = await wf.webhook(f.id, 'hook', token, { body: { status: 'confermato', title: 'Dune', year: 2021, date: '2026-11-20' } });
  assert.equal((await settle(wf, r.runId)).status, 'waiting', 'in attesa fino a 3 giorni prima');
  ctx.setNow(Date.parse('2026-11-17T00:00:01'));
  await wf.tick();
  await settle(wf, r.runId);
  assert.ok(calls.actions.some(([name, b]) => name === 'searchStart' && b.pattern === 'Dune 2021 ITA' && b.category === 'movies'));
  assert.equal(calls.approvals.length, 1);
  assert.deepEqual(calls.approvals[0].options.map((o) => o.label), ['1080p · 3 GB · 40 seed', '2160p · 15 GB · 20 seed'], 'solo versioni italiane');
  await wf.decide(wf.pendingApprovals()[0].id, 0, 'gigi');
  const done = await settle(wf, r.runId);
  assert.equal(done.status, 'success', done.error);
  assert.deepEqual(calls.actions.find(([name]) => name === 'add')[1], { urls: ['magnet:?xt=urn:btih:40'], plugin: 'corsaro', category: 'Film', stopped: false });
  assert.match(calls.notify.at(-1).title, /Dune in download/);
  // Film già in libreria: nessuna ricerca, solo l'avviso
  const ctx2 = make({ library: [{ id: 'd', name: 'Dune', type: 'Movie', year: 2021 }] });
  const f2 = ctx2.wf.create('Borollo 2', structuredClone(tpl.graph), 'admin');
  const tk = ctx2.wf.newWebhookToken(f2.id, 'hook');
  ctx2.wf.update(f2.id, { enabled: true });
  const r2 = await ctx2.wf.webhook(f2.id, 'hook', tk, { body: { status: 'confermato', title: 'Dune', year: 2021, date: '2026-11-20' } });
  assert.equal((await settle(ctx2.wf, r2.runId)).status, 'success');
  assert.match(ctx2.calls.notify[0].title, /già in libreria/);
  assert.ok(!ctx2.calls.actions.some(([name]) => name === 'searchStart'));
  ctx2.wf.update(f2.id, { enabled: false });
  wf.update(f.id, { enabled: false });
});
