// Storico delle metriche (D-027): aggregazione, buchi, container, dischi, previsione, retention e API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { aggregateMinutes, forecastDisk, Metrics } from '../apps/api/dist/metrics.js';
import { buildApp } from '../apps/api/dist/app.js';
import { openDb } from '../apps/api/dist/db.js';
import { Events } from '../apps/api/dist/events.js';
import { Integrations } from '../apps/api/dist/integrations.js';
import { Audit, LoginLimiter, Sessions } from '../apps/api/dist/security.js';
import { buildBlockList } from '../apps/api/dist/ssrf.js';
import { Vault } from '../apps/api/dist/vault.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0); // minuto esatto

const sample = (t, cpu, extra = {}) => ({ t, cpu, mem: 50, rx: 1000, tx: 500, load1: 0.5, temp: 40, ...extra });

let dir, db;
before(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'gigi-metrics-'));
  db = openDb(dir);
});
after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const reset = () => db.exec('DELETE FROM metrics_host; DELETE FROM metrics_container; DELETE FROM metrics_disk;');

test('aggregateMinutes: media e picco per minuto, solo minuti completi', () => {
  const s = [0, 5, 10, 55].map((sec, i) => sample(T0 + sec * 1000, [10, 20, 30, 40][i]));
  s.push(sample(T0 + MIN + 5000, 90)); // minuto successivo, ancora aperto
  const rows = aggregateMinutes(s, T0 + MIN + 10_000);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].t, T0);
  assert.equal(rows[0].cpu, 25);
  assert.equal(rows[0].cpu_max, 40);
  assert.equal(rows[0].n, 4);
});

test('aggregateMinutes: temperatura assente → null', () => {
  const rows = aggregateMinutes([sample(T0, 10, { temp: null }), sample(T0 + 5000, 20, { temp: null })], T0 + MIN);
  assert.equal(rows[0].temp, null);
});

test('collectHost: riprende dall’ultimo minuto salvato senza duplicati; i buchi restano null', async () => {
  reset();
  let now = T0 + 3 * MIN + 1000;
  let history = [];
  const agent = { json: async (_m, p) => history.filter((s) => s.t >= Number(new URLSearchParams(p.split('?')[1]).get('since'))) };
  const m = new Metrics(db, agent, 30, () => now);
  history = [0, 1, 2].flatMap((k) => [0, 30].map((sec) => sample(T0 + k * MIN + sec * 1000, 10 * (k + 1))));
  assert.equal(await m.collectHost(), 3);
  assert.equal(await m.collectHost(), 0, 'seconda raccolta: nessun duplicato');
  // API ferma per 10 minuti, l'agent ha perso i campioni (riavvio): resta un buco
  now = T0 + 15 * MIN + 1000;
  history = [sample(T0 + 14 * MIN, 70)];
  assert.equal(await m.collectHost(), 1);
  const h = m.host('1h');
  assert.equal(h.bucketMs, MIN);
  const idx = (t) => h.times.indexOf(t);
  assert.equal(h.cpu[idx(T0)], 10);
  assert.equal(h.cpu[idx(T0 + 2 * MIN)], 30);
  assert.equal(h.cpu[idx(T0 + 5 * MIN)], null);
  assert.equal(h.cpu[idx(T0 + 14 * MIN)], 70);
  assert.equal(h.since, T0);
});

test('host: i bucket lunghi fanno media e conservano il picco', async () => {
  reset();
  const now = T0 + 10 * MIN;
  const ins = db.prepare('INSERT INTO metrics_host (t, cpu, cpu_max, mem, rx, tx, load1, temp, n) VALUES (?, ?, ?, 50, 0, 0, 0, NULL, 12)');
  for (let k = 0; k < 5; k++) ins.run(T0 + k * MIN, 10 + k * 10, 95 - k);
  const m = new Metrics(db, { json: async () => [] }, 30, () => now);
  const h = m.host('24h');
  assert.equal(h.bucketMs, 5 * MIN);
  const v = h.cpu.filter((x) => x !== null);
  assert.deepEqual(v, [30]);
  assert.deepEqual(h.cpuMax.filter((x) => x !== null), [95]);
  assert.ok(h.times.length >= 288 && h.times.length <= 290);
});

test('collectContainers: solo container in esecuzione con statistiche fresche, senza ricontare lo stesso campione', async () => {
  reset();
  let now = T0 + 1000;
  let list = [];
  const m = new Metrics(db, { json: async () => list }, 30, () => now);
  list = [
    { name: 'jellyfin', state: 'running', stats: { cpu: 20, memUsed: 400e6, t: T0 } },
    { name: 'fermo', state: 'exited', stats: null },
    { name: 'vecchio', state: 'running', stats: { cpu: 5, memUsed: 1, t: T0 - 10 * MIN } },
  ];
  assert.equal(await m.collectContainers(), 1);
  assert.equal(await m.collectContainers(), 0, 'stesso campione: ignorato');
  now = T0 + MIN;
  list = [
    { name: 'jellyfin', state: 'running', stats: { cpu: 40, memUsed: 600e6, t: T0 + MIN - 1000 } },
    { name: 'armony-app', state: 'running', stats: { cpu: 1, memUsed: 900e6, t: T0 + MIN - 1000 } },
  ];
  assert.equal(await m.collectContainers(), 2);
  const cpu = m.containers('1h', 'cpu', 5);
  assert.deepEqual(cpu.ranking.map((r) => r.name), ['jellyfin', 'armony-app']);
  assert.equal(cpu.ranking[0].cpuAvg, 30);
  assert.equal(cpu.ranking[0].memMax, 600e6);
  assert.equal(cpu.bucketMs, 5 * MIN);
  const mem = m.containers('1h', 'mem', 1);
  assert.deepEqual(mem.series.map((s) => s.name), ['armony-app']);
  assert.ok(mem.series[0].values.includes(900e6));
});

test('collectDisks e disks: un punto per ora, ultimo valore', async () => {
  reset();
  let now = T0 + 10 * MIN;
  let used = 100;
  const m = new Metrics(db, { json: async () => ({ disks: [{ label: 'Sistema', total: 1000, free: 1000 - used, used, ok: true }, { label: 'rotto', total: 0, free: 0, used: 0, ok: false }] }) }, 30, () => now);
  await m.collectDisks();
  used = 120;
  now = T0 + 50 * MIN;
  await m.collectDisks();
  const d = m.disks();
  assert.equal(d.length, 1);
  assert.equal(d[0].points.length, 1);
  assert.equal(d[0].points[0].used, 120);
  assert.equal(d[0].forecast.status, 'insufficient');
});

const series = (days, perDay, { total = 1000e9, start = 500e9, noise = 0 } = {}) =>
  Array.from({ length: days * 24 }, (_, i) => {
    const used = start + (perDay * i) / 24 + (i % 2 ? noise : -noise);
    return { t: T0 + i * HOUR, used, free: total - used, total };
  });

test('forecastDisk: pochi dati → insufficiente', () => {
  assert.equal(forecastDisk([]).status, 'insufficient');
  assert.equal(forecastDisk(series(2, 10e9)).status, 'insufficient');
});

test('forecastDisk: crescita costante → giorni stimati coerenti', () => {
  const f = forecastDisk(series(10, 10e9, { noise: 1e9 }));
  assert.equal(f.status, 'growing');
  const last = 500e9 + (10e9 * (10 * 24 - 1)) / 24;
  const expected = (1000e9 - last) / 10e9;
  assert.ok(Math.abs(f.days - expected) <= 1, `${f.days} ≈ ${expected}`);
  assert.ok(f.daysMin <= f.days && (f.daysMax === null || f.daysMax >= f.days));
});

test('forecastDisk: crescita trascurabile → stabile; calo → in diminuzione', () => {
  assert.equal(forecastDisk(series(7, 0.05e9)).status, 'stable');
  assert.equal(forecastDisk(series(7, -5e9)).status, 'shrinking');
});

test('purge: elimina oltre la retention, conserva il resto', () => {
  reset();
  const now = T0 + 40 * DAY;
  db.prepare('INSERT INTO metrics_host (t, cpu, cpu_max, mem, rx, tx, load1, temp, n) VALUES (?, 1, 1, 1, 0, 0, 0, NULL, 1)').run(T0);
  db.prepare('INSERT INTO metrics_host (t, cpu, cpu_max, mem, rx, tx, load1, temp, n) VALUES (?, 1, 1, 1, 0, 0, 0, NULL, 1)').run(now - DAY);
  db.prepare("INSERT INTO metrics_container (t, name, cpu_sum, mem_sum, mem_max, n) VALUES (?, 'x', 1, 1, 1, 1)").run(T0);
  db.prepare("INSERT INTO metrics_disk (t, label, used, free, total) VALUES (?, 'x', 1, 1, 2)").run(T0);
  new Metrics(db, { json: async () => [] }, 30, () => now).purge();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM metrics_host').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM metrics_container').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM metrics_disk').get().n, 0);
});

test('API metriche: sessione richiesta, input validato, accessibile al viewer', async () => {
  reset();
  const dir2 = mkdtempSync(path.join(tmpdir(), 'gigi-metrics-api-'));
  const db2 = openDb(dir2);
  const events = new Events(db2);
  let token = 'codice';
  const app = await buildApp({
    db: db2,
    agent: { json: async () => ({}), stream: async () => { throw new Error('non usato'); } },
    integrations: new Integrations(db2, new Vault(randomBytes(32)), buildBlockList(['127.0.0.0/8']), events),
    events,
    sessions: new Sessions(db2, HOUR, DAY),
    limiter: new LoginLimiter(db2, 5),
    audit: new Audit(db2),
    secureCookies: false,
    setupToken: () => token,
    consumeSetupToken: () => (token = null),
    metrics: new Metrics(db2, { json: async () => [] }),
  });
  try {
    for (const url of ['/api/v1/metrics/host', '/api/v1/metrics/containers', '/api/v1/metrics/disks']) {
      assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401, url);
    }
    const setup = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { username: 'gigi', password: 'una-frase-lunga-sicura', setupToken: 'codice' } });
    const admin = { cookie: setup.headers['set-cookie'].toString().split(';')[0], 'x-csrf-token': setup.json().user.csrf };
    await app.inject({ method: 'POST', url: '/api/v1/users', headers: admin, payload: { username: 'ospite', password: 'altra-frase-lunga-sicura', role: 'viewer' } });
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'ospite', password: 'altra-frase-lunga-sicura' } });
    const viewer = { cookie: login.headers['set-cookie'].toString().split(';')[0] };
    const h = await app.inject({ method: 'GET', url: '/api/v1/metrics/host?range=7d', headers: viewer });
    assert.equal(h.statusCode, 200);
    assert.equal(h.json().bucketMs, 30 * MIN);
    assert.ok(h.json().cpu.every((v) => v === null));
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/metrics/host?range=1y', headers: viewer })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/metrics/containers?top=999', headers: viewer })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/metrics/containers?metric=mem&top=3', headers: viewer })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/metrics/disks', headers: viewer })).statusCode, 200);
  } finally {
    await app.close();
    db2.close();
    rmSync(dir2, { recursive: true, force: true });
  }
});
