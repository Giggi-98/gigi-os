// Test end-to-end del motore media su filesystem temporaneo con qBittorrent, Jellyfin e ffprobe simulati.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, statSync, rmSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.GIGI_MEDIA_STABLE_MS = '0';
const root = mkdtempSync(path.join(tmpdir(), 'gigi-media-'));
const fakeProbe = path.join(root, 'ffprobe');
writeFileSync(
  fakeProbe,
  `#!/bin/sh\ncase "$*" in *Dune*) D=9960;; *) D=1440;; esac\necho '{"format":{"duration":"'$D'","format_name":"matroska"},"streams":[{"codec_type":"video","codec_name":"hevc","width":1920,"height":1080},{"codec_type":"audio","codec_name":"aac","tags":{"language":"jpn"}},{"codec_type":"subtitle","codec_name":"ass","tags":{"language":"ita"}}]}'\n`,
);
chmodSync(fakeProbe, 0o755);
process.env.GIGI_FFPROBE = fakeProbe;

const { Engine } = await import('../apps/media/dist/engine.js');

const dl = path.join(root, 'srv/downloads/complete');
const libs = {
  movies: path.join(root, 'srv/media/Film'),
  series: path.join(root, 'srv/media/SerieTV'),
  animeMovies: path.join(root, 'srv/media/Anime/Film'),
  animeSeries: path.join(root, 'srv/media/Anime/Serie'),
};
const BIG = 60 * 1024 * 1024;
function mkfile(p, size = BIG) {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, Buffer.alloc(0));
  // file sparse: dimensione reale senza occupare disco
  const fd = require_fs().openSync(p, 'r+');
  require_fs().ftruncateSync(fd, size);
  require_fs().closeSync(fd);
}
let fsMod;
function require_fs() {
  return fsMod;
}
fsMod = await import('node:fs');

// Serie già presente in "Jellyfin"
mkdirSync(path.join(libs.animeSeries, 'Tatsuki Fujimoto 17-26', 'Season 01'), { recursive: true });
for (const d of Object.values(libs)) mkdirSync(d, { recursive: true });

const torrents = [
  { hash: 'a1', name: 'Tatsuki batch', category: 'Anime', save_path: '/data/downloads/complete/Anime', files: [{ name: 'TF/[Erai-raws] Tatsuki Fujimoto 17_26 - 09 [1080p][MultiSub][0FFEE1CA].mkv' }, { name: 'TF/sample.mkv' }] },
  { hash: 'b2', name: 'Ninja', category: '', save_path: '/data/downloads/complete', files: [{ name: '[EMBER] Ninja Kamui - 01.mkv' }] },
  { hash: 'c3', name: 'OnePiece', category: 'Anime', save_path: '/data/downloads/complete/Anime', files: [{ name: '[SubsPlease] One Piece - 1100 (1080p) [11223344].mkv' }] },
  { hash: 'd4', name: 'Incompleto', category: 'Film', save_path: '/data/downloads/complete/Film', progress: 0.5, files: [{ name: 'Dune.Part.Two.2024.2160p.mkv' }] },
  { hash: 'e5', name: 'Evil', category: 'Film', save_path: '/data/downloads/complete', files: [{ name: '../../../etc/evil.mkv' }] },
  { hash: 'g7', name: 'GiaImportato', category: 'Anime', save_path: '/data/downloads/complete/Anime', files: [{ name: 'Chainsaw Man – The Movie Reze Arc (2025) [WEB].mkv' }] },
  { hash: 'f6', name: 'Dune', category: 'Film', save_path: '/data/downloads/complete/Film', files: [{ name: 'Dune.Part.Two.2024.2160p.UHD.BluRay.x265-GRP.mkv' }] },
];
for (const t of torrents) for (const f of t.files) if (!f.name.startsWith('..')) mkfile(path.join(dl, t.save_path.replace('/data/downloads/complete', ''), f.name), f.name.includes('sample') ? 1024 : BIG);
// import manuale precedente con un altro nome (caso reale Chainsaw Man): stesso inode, file sciolto
fsMod.linkSync(path.join(dl, 'Anime', 'Chainsaw Man – The Movie Reze Arc (2025) [WEB].mkv'), path.join(libs.animeMovies, 'Chainsaw Man – The Movie Reze Arc (2025) [WEB].mkv'));
// sottotitolo esterno accanto a Dune
writeFileSync(path.join(dl, 'Film', 'Dune.Part.Two.2024.2160p.UHD.BluRay.x265-GRP.ita.srt'), '1\n00:00:01,000 --> 00:00:02,000\nCiao\n');

const notified = [];
const jfIndexed = new Map();
function server(handler) {
  const s = http.createServer(async (req, res) => {
    let b = '';
    for await (const c of req) b += c;
    handler(req, res, b ? JSON.parse(b) : null);
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
}
const qbtSrv = await server((req, res) => {
  if (req.headers.authorization !== 'Bearer qbt_ok') return res.writeHead(403).end();
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/v2/torrents/info')
    return res.end(JSON.stringify(torrents.map((t) => ({ hash: t.hash, name: t.name, state: 'uploading', progress: t.progress ?? 1, amount_left: (t.progress ?? 1) < 1 ? 1 : 0, category: t.category, save_path: t.save_path, content_path: '', completion_on: 1 }))));
  if (u.pathname === '/api/v2/torrents/files') {
    const t = torrents.find((x) => x.hash === u.searchParams.get('hash'));
    return res.end(JSON.stringify(t.files.map((f) => ({ name: f.name, size: f.name.includes('sample') ? 1024 : BIG, progress: 1, priority: 1 }))));
  }
  res.writeHead(404).end();
});
const jfSrv = await server((req, res, body) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/Items/RemoteSearch/Series') {
    const n = body.SearchInfo.Name;
    if (/ninja/i.test(n)) return res.end(JSON.stringify([{ Name: 'Ninja Kamui', ProductionYear: 2024, ProviderIds: { Tmdb: '202284' }, SearchProviderName: 'TheMovieDb' }]));
    if (/one piece/i.test(n)) return res.end(JSON.stringify([{ Name: 'One Piece', ProductionYear: 1999, ProviderIds: { Tmdb: '37854' }, SearchProviderName: 'TheMovieDb' }]));
    return res.end(JSON.stringify([{ Name: 'Tatsuki Fujimoto 17-26', ProductionYear: 2025, ProviderIds: { Tmdb: '299778' }, SearchProviderName: 'TheMovieDb' }]));
  }
  if (u.pathname === '/Items/RemoteSearch/Movie') return res.end(JSON.stringify([{ Name: 'Dune: Part Two', ProductionYear: 2024, ProviderIds: { Tmdb: '693134' }, SearchProviderName: 'TheMovieDb' }]));
  if (u.pathname === '/Items' && u.searchParams.get('IncludeItemTypes') === 'Series') {
    const term = u.searchParams.get('searchTerm') ?? '';
    if (/tatsuki/i.test(term)) return res.end(JSON.stringify({ Items: [{ Id: 's1', Name: 'Tatsuki Fujimoto 17-26', Type: 'Series', Path: '/media/anime/Serie/Tatsuki Fujimoto 17-26', ProductionYear: 2025 }] }));
    return res.end(JSON.stringify({ Items: [] }));
  }
  if (u.pathname === '/Items' && u.searchParams.get('IncludeItemTypes') === 'Movie') return res.end(JSON.stringify({ Items: [] }));
  if (u.pathname === '/Items') {
    // come Jellyfin reale: senza CollapseBoxSetItems=false i film in una collezione diventano il boxset
    if (u.searchParams.get('CollapseBoxSetItems') !== 'false') return res.end(JSON.stringify({ Items: [{ Id: 'bx', Name: 'Collezione', Type: 'BoxSet', Path: '/config/data/collections/X [boxset]' }] }));
    return res.end(JSON.stringify({ Items: [...jfIndexed.values()] }));
  }
  if (u.pathname === '/Library/Media/Updated') {
    notified.push(...body.Updates.map((x) => x.Path));
    return res.writeHead(204).end();
  }
  if (u.pathname === '/Library/Refresh') return res.writeHead(204).end();
  res.writeHead(404).end();
});

const creds = {
  qbt: { baseUrl: `http://127.0.0.1:${qbtSrv.address().port}`, auth: 'apikey', secret: { apiKey: 'qbt_ok' } },
  jf: { baseUrl: `http://127.0.0.1:${jfSrv.address().port}`, apiKey: 'jf' },
  qbtPathMap: [{ from: '/data', to: path.join(root, 'srv') }],
  jfPathMap: [
    { host: libs.movies, jf: '/media/film' },
    { host: libs.series, jf: '/media/serie' },
    { host: path.join(root, 'srv/media/Anime'), jf: '/media/anime' },
  ],
};

let engine;
before(() => {
  engine = new Engine(path.join(root, 'data'), libs, () => {});
});
after(() => {
  qbtSrv.close();
  jfSrv.close();
  engine.db.close();
  rmSync(root, { recursive: true, force: true });
});

const byName = (frag) => engine.list().find((i) => i.fileName.includes(frag));

test('rilevamento: solo torrent completi, niente sample né path traversal', async () => {
  const r = await engine.scan(creds);
  assert.equal(r.detected, 5, JSON.stringify(r));
  const names = engine.list().map((i) => i.fileName);
  assert.ok(!names.some((n) => n.includes('sample')));
  assert.ok(!names.some((n) => n.includes('evil')));
  assert.ok(!names.some((n) => n.includes('Dune.Part.Two.2024.2160p.mkv')), 'torrent incompleto ignorato');
});

test('nuovo episodio di una serie esistente: pronto, nella cartella esistente', () => {
  const it = byName('Tatsuki');
  assert.equal(it.status, 'ready', JSON.stringify(it.reasons));
  assert.ok(it.confidence >= 85);
  assert.equal(it.plan.dest, path.join(libs.animeSeries, 'Tatsuki Fujimoto 17-26', 'Season 01', 'Tatsuki Fujimoto 17-26 - S01E09.mkv'));
});

test('serie nuova senza categoria: anime riconosciuto ma in revisione', () => {
  const it = byName('Ninja');
  assert.equal(it.anime, true);
  assert.equal(it.status, 'review');
  assert.equal(it.plan.dest, path.join(libs.animeSeries, 'Ninja Kamui', 'Season 01', 'Ninja Kamui - S01E01.mkv'));
});

test('duplicato con altro nome (stesso inode già in libreria): nessuna nuova copia proposta', async () => {
  const it = byName('Chainsaw');
  assert.equal(it.status, 'imported', JSON.stringify(it.reasons));
  assert.ok(it.plan.dest.endsWith('Chainsaw Man – The Movie Reze Arc (2025) [WEB].mkv'));
  assert.ok(it.reasons.some((r) => /altro nome/.test(r.text)));
  assert.equal(statSync(it.srcPath).nlink, 2, 'nessun hardlink aggiuntivo');
});

test('numerazione assoluta: sempre in revisione', () => {
  const it = byName('One Piece');
  assert.equal(it.status, 'review');
  assert.ok(it.reasons.some((r) => /assoluta/.test(r.text)));
});

test('film con categoria e anno: pronto, cartella "Titolo (Anno)" e sottotitolo esterno', () => {
  const it = byName('Dune');
  assert.equal(it.status, 'ready', JSON.stringify(it.reasons));
  assert.equal(it.plan.dest, path.join(libs.movies, 'Dune - Part Two (2024)', 'Dune - Part Two (2024).mkv'));
  assert.equal(it.plan.subtitles.length, 1);
  assert.ok(it.plan.subtitles[0].dest.endsWith('Dune - Part Two (2024).ita.srt'));
});

test('importazione: hardlink (stesso inode), sorgente intatta, Jellyfin notificato', async () => {
  const it = byName('Tatsuki');
  const before = statSync(it.srcPath);
  await engine.importItem(it.id, creds, 'test');
  const dst = statSync(it.plan.dest);
  const after = statSync(it.srcPath);
  assert.equal(dst.ino, before.ino);
  assert.equal(after.nlink, 2);
  assert.equal(after.size, before.size);
  assert.ok(notified.includes('/media/anime/Serie/Tatsuki Fujimoto 17-26/Season 01/Tatsuki Fujimoto 17-26 - S01E09.mkv'));
  assert.equal(engine.detail(it.id).status, 'imported');
  await assert.rejects(engine.importItem(it.id, creds, 'test'), (e) => e.status === 409, 'secondo import rifiutato');
  assert.equal(statSync(it.srcPath).nlink, 2, 'nessun duplicato creato');
});

test('importazione film con sottotitolo esterno', async () => {
  const it = byName('Dune');
  await engine.importItem(it.id, creds, 'test');
  assert.ok(existsSync(it.plan.dest));
  assert.equal(readFileSync(it.plan.subtitles[0].dest, 'utf8').includes('Ciao'), true);
});

test('conflitto: file diverso già presente in destinazione → nessuna sovrascrittura', async () => {
  const it = byName('Ninja');
  mkfile(it.plan.dest, 1234);
  const r = await engine.reanalyze(it.id, creds, 'test');
  assert.equal(r.status, 'conflict');
  assert.equal(statSync(it.plan.dest).size, 1234, 'file esistente intatto');
});

test('correzione manuale: confidenza 100 e nuova destinazione', async () => {
  const it = byName('One Piece');
  const r = await engine.setOverride(it.id, { season: 22, episodes: [1100], title: 'One Piece' }, creds, 'admin');
  assert.equal(r.confidence, 100);
  assert.equal(r.status, 'ready');
  assert.ok(r.plan.dest.endsWith(path.join('Season 22', 'One Piece - S22E1100.mkv')));
});

test('verifica: indicizzato quando Jellyfin espone il percorso', async () => {
  const it = byName('Tatsuki');
  jfIndexed.set('x', { Id: 'ep9', Name: 'Episodio 9', Type: 'Episode', Path: '/media/anime/Serie/Tatsuki Fujimoto 17-26/Season 01/Tatsuki Fujimoto 17-26 - S01E09.mkv' });
  const r = await engine.scan(creds);
  assert.ok(r.indexed.includes('Episodio 9'));
  assert.equal(engine.detail(it.id).status, 'indexed');
});

test('import automatico disattivato di default; attivo solo sopra soglia', async () => {
  assert.equal(engine.settings().autoImport, false);
  engine.setSettings({ autoImport: true });
  const r = await engine.scan(creds);
  assert.ok(r.imported.some((d) => d.includes('S22E1100')), JSON.stringify(r));
  assert.equal(byName('Ninja').status, 'conflict', 'gli elementi non pronti restano dove sono');
});
