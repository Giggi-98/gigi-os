// Rilevamento aggiornamenti (D-032): riferimenti, versioni, registry finti, sistema operativo, eventi una volta sola.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compareVersions, latestGigi, listTags, newerTag, parseRef, Updates } from '../apps/api/dist/updates.js';
import { kernelCompare, parseNotifier } from '../apps/agent/dist/updates.js';
import { openDb } from '../apps/api/dist/db.js';
import { Events } from '../apps/api/dist/events.js';

test('parseRef: Docker Hub, immagini ufficiali, GHCR, lscr.io, registry locale, digest', () => {
  assert.deepEqual(parseRef('jellyfin/jellyfin:latest'), { registry: 'docker.io', repo: 'jellyfin/jellyfin', tag: 'latest' });
  assert.deepEqual(parseRef('caddy:2.8.4'), { registry: 'docker.io', repo: 'library/caddy', tag: '2.8.4' });
  assert.deepEqual(parseRef('nginx'), { registry: 'docker.io', repo: 'library/nginx', tag: 'latest' });
  assert.deepEqual(parseRef('lscr.io/linuxserver/qbittorrent:latest'), { registry: 'ghcr.io', repo: 'linuxserver/qbittorrent', tag: 'latest' });
  assert.deepEqual(parseRef('ghcr.io/home-assistant/home-assistant:stable'), { registry: 'ghcr.io', repo: 'home-assistant/home-assistant', tag: 'stable' });
  assert.deepEqual(parseRef('localhost:5000/app:1.2'), { registry: 'localhost:5000', repo: 'app', tag: '1.2' });
  assert.equal(parseRef('redis@sha256:abc').tag, null);
});

test('newerTag: stessa forma, niente pre-release, tag mobili ignorati', () => {
  assert.equal(newerTag('0.64.2', ['0.64.2', '0.65.0', '0.66.0-rc1', 'latest', '0.65.1']), '0.65.1');
  assert.equal(newerTag('2.8.4', ['2.8.4', '2.10.0', '2.10.0-alpine', '3.0.0-beta.1']), '2.10.0', '2.10 > 2.8 numericamente, non come testo');
  assert.equal(newerTag('2.8.4-alpine', ['2.10.0-alpine', '2.10.0']), '2.10.0-alpine');
  assert.equal(newerTag('v1.2', ['v1.3', '1.4', 'v1.3.0']), 'v1.3');
  assert.equal(newerTag('latest', ['1.0', '2.0']), null);
  assert.equal(newerTag('2', ['3']), null, 'tag troppo generico');
  assert.equal(newerTag('1.0.0', ['0.9.0', '1.0.0']), null);
  assert.ok(compareVersions('v0.3.0', '0.2.0') > 0);
});

const res = (body, { status = 200, link = null, url } = {}) => ({ ok: status < 400, status, url, headers: new Headers(link ? { link } : {}), text: async () => JSON.stringify(body) });
function fakeFetch(routes, calls = []) {
  return async (u) => {
    const s = u.toString();
    calls.push(s);
    for (const [re, fn] of routes) if (re.test(s)) return fn(s);
    return res({}, { status: 404, url: s });
  };
}

test('listTags: Docker Hub, GHCR con token e pagine, destinazioni non consentite', async () => {
  const calls = [];
  const f = fakeFetch(
    [
      [/hub\.docker\.com\/v2\/repositories\/library\/caddy\/tags/, (u) => res({ results: [{ name: '2.10.0' }, { name: '2.8.4' }] }, { url: u })],
      [/ghcr\.io\/token/, (u) => res({ token: 'T' }, { url: u })],
      [/ghcr\.io\/v2\/a\/b\/tags\/list\?n=1000$/, (u) => res({ tags: ['1.0'] }, { url: u, link: '</v2/a/b/tags/list?n=1000&last=1.0>; rel="next"' })],
      [/ghcr\.io\/v2\/a\/b\/tags\/list\?n=1000&last/, (u) => res({ tags: ['1.1'] }, { url: u })],
    ],
    calls,
  );
  assert.deepEqual(await listTags(f, 'docker.io', 'library/caddy'), ['2.10.0', '2.8.4']);
  assert.deepEqual(await listTags(f, 'ghcr.io', 'a/b'), ['1.0', '1.1']);
  await assert.rejects(listTags(f, 'registry.example.com', 'x/y'), /non supportato/);
  const evil = fakeFetch([[/hub\.docker\.com/, () => res({ results: [] }, { url: 'http://192.168.1.1/' })]]);
  await assert.rejects(listTags(evil, 'docker.io', 'library/x'), /non consentita/);
});

test('sistema operativo: testo di update-notifier e confronto dei kernel', () => {
  const t = 'Expanded Security Maintenance for Applications is not enabled.\n\n5 updates can be applied immediately.\n2 of these updates are standard security updates.\n\n27 additional security updates can be applied with ESM Apps.\n';
  assert.deepEqual(parseNotifier(t), { upgradable: 5, security: 2, esm: 27 });
  assert.equal(parseNotifier('0 updates can be applied immediately.\n').upgradable, 0);
  assert.ok(kernelCompare('7.0.0-40-generic', '7.0.0-38-generic') > 0);
  assert.ok(kernelCompare('7.0.0-38-generic', '7.0.0-38-generic') === 0);
  assert.ok(kernelCompare('6.14.0-9-generic', '7.0.0-1-generic') < 0);
});

let dir, db;
before(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'gigi-upd-'));
  db = openDb(dir);
});
after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// Istante fisso: nella realtà le date di apt sono quelle dei file e non cambiano tra un controllo e l'altro
const NOW = Date.now();
function make({ imagesFail = false } = {}) {
  const now = NOW;
  const agent = {
    json: async (_m, p) => {
      if (p === '/v1/updates/images') {
        if (imagesFail) throw new Error('agent non raggiungibile');
        return [
          { ref: 'jellyfin/jellyfin:latest', containers: ['jellyfin'], project: 'jellyfin', workingDir: '/opt/docker/jellyfin', status: 'disponibile', error: null },
          { ref: 'deluan/navidrome:0.64.2', containers: ['armony-navidrome'], project: 'armony', workingDir: '/home/gigi/armony', status: 'aggiornato', error: null },
          { ref: 'armony-armony', containers: ['armony-app'], project: 'armony', workingDir: '/home/gigi/armony', status: 'locale', error: null },
          { ref: 'nginx:latest', containers: ['prova'], project: 'prova', workingDir: '/opt/stacks/prova', status: 'aggiornato', error: null },
        ];
      }
      return {
        supported: true,
        packages: { upgradable: 5, security: 2, esm: 27, at: now },
        apt: { lastUpdate: now, lastSuccess: now - 3 * 86400_000, lastUnattended: now },
        unattendedEnabled: true,
        kernel: { running: '7.0.0-38-generic', newest: '7.0.0-40-generic', rebootNeeded: true },
      };
    },
  };
  const integrations = {
    list: () => [
      { id: 'jf', type: 'jellyfin', enabled: true },
      { id: 'ha', type: 'homeassistant', enabled: true },
    ],
    resource: async (id, name) =>
      id === 'jf' ? { version: '10.11.0', updateAvailable: true } : name === 'updates' ? [{ entity: 'update.home_assistant_core_update', title: 'Home Assistant Core', installed: '2026.10.1', latest: '2026.10.2' }] : null,
  };
  const fetch = fakeFetch([
    [/hub\.docker\.com\/v2\/repositories\/deluan\/navidrome\/tags/, (u) => res({ results: [{ name: '0.64.2' }, { name: '0.65.0' }, { name: '0.66.0-rc1' }] }, { url: u })],
    [/api\.github\.com\/repos\/me\/gigi-os\/releases\/latest/, (u) => res({ tag_name: 'v0.3.0' }, { url: u })],
  ]);
  return new Updates(db, agent, integrations, new Events(db), { version: '0.2.0', releaseRepo: 'me/gigi-os', stackRoots: ['/opt/stacks'], fetch });
}
test('ultima versione di GIGI OS: release, altrimenti il tag più alto', async () => {
  const rel = fakeFetch([[/releases\/latest/, (u) => res({ tag_name: 'v0.4.0', html_url: 'https://github.com/me/g/releases/tag/v0.4.0' }, { url: u })]]);
  assert.deepEqual(await latestGigi(rel, 'me/g'), { latest: '0.4.0', url: 'https://github.com/me/g/releases/tag/v0.4.0' });
  const tags = fakeFetch([[/\/tags\?/, (u) => res([{ name: 'v0.10.0-rc1' }, { name: 'v0.9.0' }, { name: 'v0.10.0' }, { name: 'prova' }], { url: u })]]);
  assert.deepEqual(await latestGigi(tags, 'me/g'), { latest: '0.10.0', url: 'https://github.com/me/g/releases/tag/v0.10.0' });
  const none = fakeFetch([[/\/tags\?/, (u) => res([], { url: u })]]);
  assert.deepEqual(await latestGigi(none, 'me/g'), { latest: null, url: null });
  const down = fakeFetch([[/releases\/latest/, (u) => res({}, { status: 503, url: u })]]);
  await assert.rejects(latestGigi(down, 'me/g'), /HTTP 503/);
});

const updEvents = () => db.prepare("SELECT level, title FROM events WHERE source = 'aggiornamenti' ORDER BY id").all();

test('controllo completo: container, versioni, sistema, app, GIGI OS', async () => {
  const r = await make().check();
  const by = Object.fromEntries(r.images.map((i) => [i.containers[0], i]));
  assert.equal(by.jellyfin.status, 'disponibile');
  assert.equal(by['armony-navidrome'].newerVersion, '0.65.0', 'versione nuova, senza rc');
  assert.equal(by['armony-app'].status, 'locale');
  assert.equal(by['armony-app'].newerVersion, null);
  assert.equal(by.prova.managedByGigi, true, 'stack in /opt/stacks: gestibile da GIGI OS');
  assert.equal(by.jellyfin.managedByGigi, false);
  assert.equal(r.host.aptStale, true);
  assert.equal(r.host.kernel.rebootNeeded, true);
  assert.deepEqual(r.apps.map((a) => [a.name, a.status]), [['Jellyfin', 'disponibile'], ['Home Assistant · Home Assistant Core', 'disponibile']]);
  assert.equal(r.gigi.latest, '0.3.0');
  const titles = updEvents().map((e) => e.title);
  for (const re of [/Nuova immagine per jellyfin/, /armony-navidrome: 0\.64\.2 → 0\.65\.0/, /5 pacchetti \(2 di sicurezza\)/, /Riavvio necessario per il kernel 7\.0\.0-40/, /non si aggiornano/, /Jellyfin: aggiornamento disponibile/, /2026\.10\.1 → 2026\.10\.2/, /GIGI OS 0\.3\.0 disponibile/])
    assert.ok(titles.some((t) => re.test(t)), `${re}`);
  assert.equal(updEvents().find((e) => /sicurezza/.test(e.title)).level, 'warning');
  assert.match(make().summary(), /1 immagini nuove, 1 versioni nuove, 5 pacchetti di sistema \(2 di sicurezza\), riavvio necessario, 2 app, GIGI OS 0\.3\.0/);
});

test('nessuna segnalazione ripetuta, nemmeno dopo un controllo fallito a metà', async () => {
  const n = updEvents().length;
  await make().check();
  assert.equal(updEvents().length, n, 'stesso stato: nessun nuovo evento');
  const partial = await make({ imagesFail: true }).check();
  assert.equal(partial.images, null);
  assert.match(partial.imagesError, /non raggiungibile/);
  await make().check();
  assert.equal(updEvents().length, n, `dopo il recupero i container non vengono segnalati di nuovo: ${JSON.stringify(updEvents().slice(n))}`);
});

test('controlli concorrenti: uno solo alla volta', async () => {
  const u = make();
  const [a, b] = await Promise.all([u.check(), u.check()]);
  assert.equal(a, b);
});
