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
