// D-038: «Elimina dalla libreria» ed «Elimina ovunque» con Jellyfin e qBittorrent simulati e file manager vero.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, linkSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Files, parseRoots } from '../apps/files/dist/fsops.js';
import { MediaBridge } from '../apps/api/dist/media.js';

const base = mkdtempSync(path.join(tmpdir(), 'gigi-libdel-'));
const dl = path.join(base, 'downloads');
const media = path.join(base, 'media');
const film = path.join(media, 'Film');
after(() => rmSync(base, { recursive: true, force: true }));
before(() => {
  mkdirSync(film, { recursive: true });
  mkdirSync(dl, { recursive: true });
});

const res = (body, status = 200) => ({ status, headers: new Headers(), body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)), latency: 1 });

/** Un film scaricato da un torrent e importato in libreria con un hardlink. */
function movie(name, hash, { linked = true } = {}) {
  const dir = path.join(film, name);
  mkdirSync(dir, { recursive: true });
  const src = path.join(dl, `${name} [release].mkv`);
  writeFileSync(src, 'video');
  if (linked) linkSync(src, path.join(dir, `${name}.mkv`));
  else writeFileSync(path.join(dir, `${name}.mkv`), 'altra copia');
  return { dir, src, lib: path.join(dir, `${name}.mkv`), hash, jfId: hash.slice(0, 32), name };
}

function setup({ titles = [], torrents = [], jellyfinSlow = false, sticky = false } = {}) {
  const calls = { notified: [], refresh: 0, qbDelete: [], removed: [], events: [] };
  const files = new Files(parseRoots(`Download=${dl},Media=${media}`));
  const filesClient = {
    json: async (_m, p, _t, b) => {
      if (p === '/v1/roots') return files.roots;
      if (p === '/v1/stat') return files.statPaths(b.paths);
      if (p === '/v1/find-links') return files.findLinks(b.dirs, b.targets);
      if (p === '/v1/media-plan') return files.mediaPlan(b.files, b.stops);
      if (p === '/v1/media-delete') return files.mediaDelete(b.files, b.stops, b.mode, b.expect);
      throw new Error(`files: ${p}`);
    },
  };
  // Jellyfin vede /srv/media come /media; un titolo esiste finché c'è il suo file (o, se lento, finché non scansiona)
  const toJf = (p) => p.replace(media, '/media');
  // Jellyfin lento: il titolo resta visibile per le prime 10 verifiche
  let checks = 0;
  // sticky: come il vero Jellyfin, la scheda resta finché una scansione non trova il file mancante
  const forgotten = new Set();
  const present = (t) => (sticky ? !forgotten.has(t.jfId) : existsSync(t.lib) || (jellyfinSlow && checks++ < 10));
  const jfHttp = async (p, init = {}) => {
    const u = new URL(p, 'http://jf');
    if (u.pathname === '/Library/VirtualFolders') return res([{ Locations: ['/media/Film'] }]);
    if (u.pathname === '/Library/Media/Updated') {
      calls.notified.push(...JSON.parse(init.body).Updates.map((x) => x.Path));
      return res('', 204);
    }
    if (u.pathname === '/Library/Refresh') {
      calls.refresh++;
      for (const t of titles) if (!existsSync(t.lib)) forgotten.add(t.jfId);
      return res('', 204);
    }
    if (u.pathname === '/Items' && !u.searchParams.get('Ids')) {
      return res({ Items: titles.filter((t) => present(t)).map((t) => ({ Id: t.jfId, Name: t.name, Type: 'Movie', Path: toJf(t.lib), LocationType: 'FileSystem' })) });
    }
    if (u.pathname === '/Items') {
      const ids = (u.searchParams.get('Ids') ?? '').split(',');
      return res({ Items: titles.filter((t) => ids.includes(t.jfId) && present(t)).map((t) => ({ Id: t.jfId, Name: t.name, Type: 'Movie', Path: toJf(t.lib), MediaSources: [{ Path: toJf(t.lib) }] })) });
    }
    return res({}, 404);
  };
  const qbHttp = async (p) => {
    const u = new URL(p, 'http://qb');
    const live = torrents.filter((t) => !calls.qbDelete.flat().includes(t.hash));
    if (u.pathname === '/api/v2/torrents/info') {
      const want = u.searchParams.get('hashes')?.split('|');
      return res(live.filter((t) => !want || want.includes(t.hash)).map((t) => ({ hash: t.hash, name: t.name, save_path: '/data' })));
    }
    if (u.pathname === '/api/v2/torrents/files') {
      const t = live.find((x) => x.hash === u.searchParams.get('hash'));
      return res([{ name: path.basename(t.src), size: 5 }]);
    }
    return res({}, 404);
  };
  const ctx = (id) => ({ id, baseUrl: `http://${id}`, auth: 'apikey', secret: { apiKey: 'k' }, config: {}, http: id === 'jf' ? jfHttp : qbHttp });
  const integrations = {
    list: () => [
      { id: 'jf', type: 'jellyfin', enabled: true, config: { container: 'jellyfin' } },
      { id: 'qb', type: 'qbittorrent', enabled: true, config: { container: 'qbittorrent' } },
    ],
    contextFor: (id) => ({ row: { base_url: `http://${id}`, auth_type: 'apikey' }, ctx: ctx(id) }),
    action: async (_id, name, body) => {
      assert.equal(name, 'delete');
      assert.equal(body.deleteFiles, true);
      calls.qbDelete.push(body.hashes);
      for (const t of torrents.filter((x) => body.hashes.includes(x.hash))) rmSync(t.src, { force: true });
      return { ok: true };
    },
  };
  const agent = {
    json: async (_m, p) => ({
      mounts: p.includes('jellyfin') ? [{ type: 'bind', source: media, destination: '/media' }] : [{ type: 'bind', source: dl, destination: '/data' }],
    }),
  };
  const mediaClient = {
    json: async (m, p, _t, b) => {
      if (p.startsWith('/v1/items?')) return titles.map((t) => ({ id: t.hash.slice(0, 20), torrentHash: t.hash, fileName: t.name, status: 'indexed', plan: { dest: t.lib }, jellyfin: { id: t.jfId } }));
      if (m === 'POST' && p.endsWith('/removed')) return calls.removed.push(p.split('/')[3]);
      throw new Error(`media: ${p}`);
    },
  };
  const events = { add: (...a) => calls.events.push(a) };
  const bridge = new MediaBridge(mediaClient, agent, integrations, events, filesClient);
  bridge.wait = async () => {};
  return { bridge, calls };
}

test('elimina dalla libreria: anteprima con il torrent collegato, poi cestino e torrent rimosso', async () => {
  const m = movie('Film Uno (2001)', 'a'.repeat(40));
  const other = movie('Film Due (2002)', 'b'.repeat(40));
  const { bridge, calls } = setup({ titles: [m, other], torrents: [m, other] });
  const plan = await bridge.libraryPlan(m.jfId);
  assert.deepEqual(plan.videos.map((v) => v.path), [m.lib]);
  assert.deepEqual(plan.torrents, [{ hash: m.hash, name: m.name }], 'solo il torrent con lo stesso inode');
  assert.deepEqual(plan.dirs, [m.dir]);
  const r = await bridge.libraryDelete(m.jfId, { mode: 'trash', torrents: [m.hash], expect: plan.videos }, 'admin');
  assert.equal(r.jellyfin, 'removed');
  assert.equal(r.torrentsDeleted, 1);
  assert.ok(!existsSync(m.dir) && !existsSync(m.src), 'libreria nel cestino, download eliminato da qBittorrent');
  assert.ok(existsSync(other.lib) && existsSync(other.src), 'l’altro film non si tocca');
  assert.ok(calls.notified.includes('/media/Film/Film Uno (2001)'), 'Jellyfin avvisato con il suo percorso');
  assert.equal(calls.refresh, 1, 'avviso e scansione insieme');
  assert.deepEqual(calls.removed, [m.hash.slice(0, 20)]);
  assert.ok(calls.events.some((e) => /Spostato nel cestino da admin: Film Uno/.test(e[2])));
});

test('Jellyfin lento: stato «in aggiornamento» e controllo in background', async () => {
  const m = movie('Film Tre (2003)', 'c'.repeat(40));
  const { bridge, calls } = setup({ titles: [m], torrents: [m], jellyfinSlow: true });
  const plan = await bridge.libraryPlan(m.jfId);
  const r = await bridge.libraryDelete(m.jfId, { mode: 'delete', torrents: [], expect: plan.videos }, 'admin');
  assert.equal(r.jellyfin, 'pending');
  assert.equal(calls.refresh, 1);
  await new Promise((r) => setImmediate(r));
  for (let i = 0; i < 20 && !calls.events.some((e) => /Sparito da Jellyfin: Film Tre/.test(e[2])); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(calls.events.some((e) => /Sparito da Jellyfin: Film Tre/.test(e[2])), 'evento quando Jellyfin lo toglie');
  assert.deepEqual(calls.qbDelete, [], 'torrent non scelto: resta in seeding');
  assert.ok(existsSync(m.src) && !existsSync(m.lib));
  assert.equal(r.freed, 0, 'il file condiviso con il torrent non libera spazio');
});

test('elimina ovunque: torrent mai importato → nessuna copia, Jellyfin non cambia', async () => {
  const m = movie('Film Quattro (2004)', 'd'.repeat(40), { linked: false });
  const { bridge, calls } = setup({ titles: [], torrents: [m] });
  const plan = await bridge.purgePlan([m.hash]);
  assert.deepEqual(plan.torrents[0].library, []);
  const r = await bridge.purgeEverywhere([m.hash], 'admin');
  assert.equal(r.jellyfin, 'unchanged');
  assert.deepEqual(r.libraryRemoved, []);
  assert.ok(existsSync(m.lib), 'una copia indipendente (non hardlink) non si tocca');
  assert.deepEqual(calls.qbDelete, [[m.hash]]);
});

test('elimina ovunque: la copia in libreria va via anche se il motore media non la conosce', async () => {
  const m = movie('Film Cinque (2005)', 'e'.repeat(40));
  const { bridge, calls } = setup({ titles: [], torrents: [m] });
  const plan = await bridge.purgePlan([m.hash]);
  assert.deepEqual(plan.torrents[0].library.map((l) => l.path), [m.lib]);
  const r = await bridge.purgeEverywhere([m.hash], 'admin');
  assert.ok(r.libraryRemoved.includes(m.lib));
  assert.ok(!existsSync(m.dir) && !existsSync(m.src));
  assert.ok(calls.notified.includes('/media/Film/Film Cinque (2005)'));
  assert.equal(calls.refresh, 1, 'senza id di Jellyfin si chiede la scansione');
});

test('controllo libreria: titoli senza torrent e schede di Jellyfin senza file', async () => {
  const linked = movie('Film Sei (2006)', '1'.repeat(40));
  const alone = movie('Film Sette (2007)', '2'.repeat(40));
  const ghost = movie('Film Otto (2008)', '3'.repeat(40));
  rmSync(alone.src); // torrent eliminato con i file scaricati: la copia in libreria resta da sola
  rmSync(ghost.lib); // file tolto a mano: Jellyfin ha ancora la scheda
  const { bridge, calls } = setup({ titles: [linked, alone, ghost], torrents: [linked], sticky: true });
  const c = await bridge.libraryCheck();
  assert.equal(c.total, 3);
  assert.deepEqual(c.unlinked.map((u) => u.title), ['Film Sette (2007)']);
  assert.deepEqual(c.ghosts.map((g) => g.title), ['Film Otto (2008)']);
  const r = await bridge.libraryFixGhosts();
  assert.deepEqual(r, { ghosts: 1, jellyfin: 'removed' });
  assert.equal(calls.refresh, 1);
  assert.deepEqual((await bridge.libraryCheck()).ghosts, []);
  assert.ok(existsSync(alone.lib) && existsSync(linked.lib), 'il controllo non elimina niente');
});
