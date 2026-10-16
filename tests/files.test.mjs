import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync, rmSync, linkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Files, parseRoots } from '../apps/files/dist/fsops.js';

const base = mkdtempSync(path.join(tmpdir(), 'gigi-files-'));
const dl = path.join(base, 'downloads');
const media = path.join(base, 'media');
const outside = path.join(base, 'segreto');
let f;

before(() => {
  mkdirSync(path.join(dl, 'Anime'), { recursive: true });
  mkdirSync(path.join(media, 'Film'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'password.txt'), 'top secret');
  writeFileSync(path.join(dl, 'Anime', 'ep01.mkv'), 'video');
  writeFileSync(path.join(dl, 'note.txt'), 'ciao mondo');
  linkSync(path.join(dl, 'Anime', 'ep01.mkv'), path.join(media, 'Film', 'ep01.mkv'));
  symlinkSync(outside, path.join(dl, 'scappatoia'));
  f = new Files(parseRoots(`Download=${dl},Media=${media}`));
});
after(() => rmSync(base, { recursive: true, force: true }));

test('radici: solo quelle configurate', async () => {
  await assert.rejects(f.list('etc', ''), (e) => e.status === 403);
  const r = await f.list('download', '');
  assert.deepEqual(r.entries.map((e) => e.name).sort(), ['Anime', 'note.txt', 'scappatoia']);
});

test('path traversal e symlink verso l’esterno rifiutati', async () => {
  await assert.rejects(f.list('download', '../segreto'), (e) => e.status === 403);
  await assert.rejects(f.list('download', 'Anime/../../segreto'), (e) => e.status === 403);
  await assert.rejects(f.list('download', 'scappatoia'), (e) => e.status === 403);
  await assert.rejects(f.preview('download', 'scappatoia/password.txt'), (e) => e.status === 403);
  await assert.rejects(f.readStream('download', 'scappatoia/password.txt'), (e) => e.status === 403);
  await assert.rejects(f.mkdir('download', '', '../x'), /Nome non valido/);
  await assert.rejects(f.transfer('move', 'download', ['note.txt'], 'download', 'scappatoia'), (e) => e.status === 403);
});

test('rinomina e creazione senza sovrascrivere', async () => {
  await f.mkdir('download', '', 'Nuova');
  await assert.rejects(f.mkdir('download', '', 'Nuova'), (e) => e.status === 409);
  await assert.rejects(f.rename('download', 'note.txt', 'Anime'), (e) => e.status === 409);
  await f.rename('download', 'note.txt', 'appunti.txt');
  assert.ok(existsSync(path.join(dl, 'appunti.txt')));
});

test('info mostra gli hardlink in libreria', async () => {
  const i = await f.info('download', 'Anime/ep01.mkv');
  assert.equal(i.links, 2);
  assert.deepEqual(i.hardlinks, ['Media/Film/ep01.mkv']);
});

test('elimina = cestino, ripristino possibile, svuotamento definitivo', async () => {
  const t = await f.trash('download', ['appunti.txt']);
  assert.ok(!existsSync(path.join(dl, 'appunti.txt')));
  const list = await f.trashList('download');
  assert.equal(list[0].items[0].from, 'appunti.txt');
  const root = await f.list('download', '');
  assert.ok(!root.entries.some((e) => e.name === '.gigi-trash'), 'cestino nascosto nella radice');
  await f.restore('download', t.batch, 'appunti.txt');
  assert.equal(readFileSync(path.join(dl, 'appunti.txt'), 'utf8'), 'ciao mondo');
  await f.trash('download', ['appunti.txt']);
  await f.emptyTrash('download');
  assert.equal((await f.trashList('download')).length, 0);
  await assert.rejects(f.emptyTrash('download', '../../segreto'), /non valido/);
  assert.ok(existsSync(path.join(outside, 'password.txt')));
});

test('hardlink, copia e spostamento tra radici', async () => {
  await f.transfer('link', 'download', ['Anime/ep01.mkv'], 'media', '');
  assert.equal(statSync(path.join(media, 'ep01.mkv')).nlink, 3);
  await assert.rejects(f.transfer('copy', 'download', ['Anime/ep01.mkv'], 'media', ''), (e) => e.status === 409, 'mai sovrascrivere');
  await assert.rejects(f.transfer('move', 'download', ['Anime'], 'download', 'Anime'), /dentro/);
  await f.transfer('move', 'download', ['Nuova'], 'media', '');
  assert.ok(existsSync(path.join(media, 'Nuova')));
});

test('upload atomico, limite di dimensione, niente sovrascrittura', async () => {
  await f.write('download', '', 'caricato.txt', Readable.from([Buffer.from('abc')]), 10);
  assert.equal(readFileSync(path.join(dl, 'caricato.txt'), 'utf8'), 'abc');
  await assert.rejects(f.write('download', '', 'caricato.txt', Readable.from([Buffer.from('x')]), 10), (e) => e.status === 409);
  await assert.rejects(f.write('download', '', 'grosso.bin', Readable.from([Buffer.alloc(50)]), 10), /troppo grande/);
  assert.ok(!existsSync(path.join(dl, 'grosso.bin')));
  assert.ok(!(await f.list('download', '')).entries.some((e) => e.name.includes('gigi-upload')), 'nessun file temporaneo rimasto');
});

test('ricerca e intervalli di lettura', async () => {
  const s = await f.search('download', '', 'ep0');
  assert.deepEqual(s.results.map((r) => r.path), ['Anime/ep01.mkv']);
  const r = await f.readStream('download', 'caricato.txt', 'bytes=1-');
  assert.deepEqual([r.start, r.end, r.partial], [1, 2, true]);
  let got = '';
  for await (const c of r.stream) got += c;
  assert.equal(got, 'bc');
});

test('elimina ovunque: solo lo stesso file del torrent, pulizia cartelle fino alla libreria esclusa', async () => {
  const lib = path.join(media, 'Anime', 'Serie');
  mkdirSync(path.join(lib, 'Show', 'Season 01'), { recursive: true });
  mkdirSync(path.join(lib, 'Altra', 'Season 01'), { recursive: true });
  writeFileSync(path.join(dl, 'src-ep.mkv'), 'episodio');
  linkSync(path.join(dl, 'src-ep.mkv'), path.join(lib, 'Show', 'Season 01', 'Show - S01E01.mkv'));
  writeFileSync(path.join(dl, 'src-ep.srt'), 'sub');
  linkSync(path.join(dl, 'src-ep.srt'), path.join(lib, 'Show', 'Season 01', 'Show - S01E01.srt'));
  writeFileSync(path.join(lib, 'Altra', 'Season 01', 'Altra - S01E01.mkv'), 'contenuto diverso');
  const r = await f.purge('media', [
    { path: 'Anime/Serie/Show/Season 01/Show - S01E01.mkv', src: path.join(dl, 'src-ep.mkv') },
    { path: 'Anime/Serie/Show/Season 01/Show - S01E01.srt', src: path.join(dl, 'src-ep.srt') },
    { path: 'Anime/Serie/Altra/Season 01/Altra - S01E01.mkv', src: path.join(dl, 'src-ep.mkv') },
    { path: '../downloads/src-ep.mkv' },
  ], 'Anime/Serie');
  assert.deepEqual(r.removed.sort(), ['Anime/Serie/Show/Season 01/Show - S01E01.mkv', 'Anime/Serie/Show/Season 01/Show - S01E01.srt']);
  assert.equal(r.skipped.length, 2);
  assert.ok(existsSync(path.join(lib, 'Altra', 'Season 01', 'Altra - S01E01.mkv')), 'file diverso non toccato');
  assert.ok(!existsSync(path.join(lib, 'Show')), 'cartelle vuote rimosse');
  assert.ok(existsSync(lib), 'la cartella della libreria resta');
  assert.ok(existsSync(path.join(dl, 'src-ep.mkv')), 'il download lo elimina qBittorrent, non il file manager');
});

// D-038: «Elimina dalla libreria» e copie in libreria di un torrent
function movieFixture(name) {
  const lib = path.join(media, 'Film');
  const dir = path.join(lib, name);
  mkdirSync(path.join(dir, 'Subs'), { recursive: true });
  writeFileSync(path.join(dl, `${name}.mkv`), 'film');
  linkSync(path.join(dl, `${name}.mkv`), path.join(dir, `${name}.mkv`));
  writeFileSync(path.join(dir, `${name}.it.srt`), 'sub');
  writeFileSync(path.join(dir, `${name}-poster.jpg`), 'img');
  writeFileSync(path.join(dir, 'movie.nfo'), 'nfo');
  writeFileSync(path.join(dir, 'Subs', 'eng.srt'), 'sub');
  return { lib, dir, video: path.join(dir, `${name}.mkv`) };
}

test('anteprima: video, accessori, cartella che resta vuota; niente toccato', async () => {
  const { lib, dir, video } = movieFixture('Film A (2001)');
  const p = await f.mediaPlan([video, path.join(outside, 'password.txt'), path.join(dl, 'note.txt')], [lib, outside, '/config/data/collections']);
  assert.deepEqual(p.videos.map((v) => v.path), [video]);
  assert.equal(p.videos[0].nlink, 2, 'hardlink con il download');
  assert.deepEqual(p.sidecars.map((s) => path.basename(s.path)).sort(), ['Film A (2001)-poster.jpg', 'Film A (2001).it.srt']);
  assert.deepEqual(p.extras.map((s) => path.basename(s.path)).sort(), ['eng.srt', 'movie.nfo']);
  assert.deepEqual(p.dirs, [dir]);
  assert.equal(p.skipped.length, 2, 'fuori dalle radici e fuori dalle librerie');
  assert.equal(p.freed, 3 + 3 + 3 + 3, 'il video condiviso con il torrent non libera spazio');
  assert.ok(existsSync(video));
});

test('una cartella con altri video resta: si toglie solo il file scelto', async () => {
  const lib = path.join(media, 'Serie');
  const season = path.join(lib, 'Show', 'Season 01');
  mkdirSync(season, { recursive: true });
  writeFileSync(path.join(season, 'Show - S01E01.mkv'), 'e1');
  writeFileSync(path.join(season, 'Show - S01E01.srt'), 's1');
  writeFileSync(path.join(season, 'Show - S01E01-E02.mkv'), 'doppio');
  writeFileSync(path.join(lib, 'Show', 'tvshow.nfo'), 'nfo');
  const p = await f.mediaPlan([path.join(season, 'Show - S01E01.mkv')], [lib]);
  assert.deepEqual(p.sidecars.map((s) => path.basename(s.path)), ['Show - S01E01.srt'], 'S01E01-E02 è un video, non un accessorio');
  assert.deepEqual(p.dirs, []);
  const r = await f.mediaDelete([path.join(season, 'Show - S01E01.mkv')], [lib], 'delete', []);
  assert.equal(r.videos.length, 1);
  assert.ok(!existsSync(path.join(season, 'Show - S01E01.mkv')) && !existsSync(path.join(season, 'Show - S01E01.srt')));
  assert.ok(existsSync(path.join(season, 'Show - S01E01-E02.mkv')) && existsSync(path.join(lib, 'Show', 'tvshow.nfo')));
  // Ultimo episodio: va via tutta la serie, accessori compresi, ma mai la cartella della libreria
  await f.mediaDelete([path.join(season, 'Show - S01E01-E02.mkv')], [lib], 'delete', []);
  assert.ok(!existsSync(path.join(lib, 'Show')));
  assert.ok(existsSync(lib));
});

test('cestino: la cartella del film intera, ripristinabile; inode cambiato = stop', async () => {
  const { lib, dir, video } = movieFixture('Film B (2002)');
  const st = statSync(video);
  await assert.rejects(f.mediaDelete([video], [lib], 'trash', [{ path: video, ino: st.ino + 1, dev: st.dev }]), (e) => e.status === 409);
  assert.ok(existsSync(video), 'nessuna modifica se il file è cambiato');
  const r = await f.mediaDelete([video], [lib], 'trash', [{ path: video, ino: st.ino, dev: st.dev }]);
  assert.equal(r.batches.length, 1);
  assert.ok(!existsSync(dir));
  assert.ok(existsSync(path.join(dl, 'Film B (2002).mkv')), 'il download resta');
  const t = await f.trashList('media');
  const b = t.find((x) => x.batch === r.batches[0].batch);
  assert.deepEqual(b.items.map((i) => i.from), ['Film/Film B (2002)']);
  await f.restore('media', r.batches[0].batch, 'Film B (2002)');
  assert.ok(existsSync(video) && existsSync(path.join(dir, 'Subs', 'eng.srt')));
});

test('copie in libreria di un download: per inode, solo nelle cartelle indicate', async () => {
  const { lib, video } = movieFixture('Film C (2003)');
  const [src] = await f.statPaths([path.join(dl, 'Film C (2003).mkv')]);
  assert.equal(src.nlink, 2);
  const found = await f.findLinks([lib], [{ ino: src.ino, dev: src.dev }]);
  assert.deepEqual(found.map((x) => x.path), [video]);
  assert.deepEqual(await f.findLinks([path.join(media, 'Serie')], [{ ino: src.ino, dev: src.dev }]), []);
  const out = await f.statPaths([path.join(outside, 'password.txt')]);
  assert.match(out[0].error, /Fuori dalle cartelle gestite/);
});

test('cestino: due elementi con lo stesso nome non si sovrascrivono', async () => {
  mkdirSync(path.join(media, 'X'), { recursive: true });
  mkdirSync(path.join(media, 'Y'), { recursive: true });
  writeFileSync(path.join(media, 'X', 'same.txt'), 'x');
  writeFileSync(path.join(media, 'Y', 'same.txt'), 'y');
  const r = await f.trash('media', ['X/same.txt', 'Y/same.txt']);
  const b = (await f.trashList('media')).find((x) => x.batch === r.batch);
  assert.deepEqual(b.items.map((i) => i.name).sort(), ['same.txt', 'same.txt (2)']);
});
