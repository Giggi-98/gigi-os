import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReleaseName as p, similarity, safeName, episodeTag } from '../apps/media/dist/parse.js';

test('fansub reale: [EMBER] Ninja Kamui - 01', () => {
  const r = p('[EMBER] Ninja Kamui - 01.mkv');
  assert.equal(r.kind, 'episode');
  assert.equal(r.title, 'Ninja Kamui');
  assert.equal(r.season, 1);
  assert.deepEqual(r.episodes, [1]);
  assert.equal(r.group, 'EMBER');
  assert.ok(r.animeSignals.length >= 2);
});

test('fansub reale con CRC e tag tecnici: Erai-raws Tatsuki Fujimoto 17_26 - 05', () => {
  const r = p('[Erai-raws] Tatsuki Fujimoto 17_26 - 05 [1080p AMZN WEB-DL AVC EAC3][MultiSub][0FFEE1CA].mkv');
  assert.equal(r.title, 'Tatsuki Fujimoto 17 26');
  assert.deepEqual(r.episodes, [5]);
  assert.equal(r.crc, '0FFEE1CA');
  assert.equal(r.resolution, '1080p');
  assert.ok(similarity(r.title, 'Tatsuki Fujimoto 17-26') === 1);
});

test('cartella batch: " - 01 ~ 08"', () => {
  const r = p('[Erai-raws] Tatsuki Fujimoto 17_26 - 01 ~ 08 [1080p AMZN WEB-DL AVC EAC3][MultiSub]');
  assert.deepEqual(r.episodes, [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('film anime reale con anno tra parentesi e trattino lungo', () => {
  const r = p('Chainsaw Man – The Movie Reze Arc (2025) [WEB] [4K] [AV1] [ItachiUchiha].mkv');
  assert.equal(r.kind, 'movie');
  assert.equal(r.year, 2025);
  assert.equal(r.title, 'Chainsaw Man – The Movie Reze Arc');
  assert.ok(similarity(r.title, 'Chainsaw Man - The Movie: Reze Arc') > 0.95);
});

test('scene: serie SxxEyy e film con anno (casi sbagliati dal parser generico)', () => {
  const bear = p('The.Bear.S03E04.1080p.WEB.h264-ETHEL.mkv');
  assert.deepEqual([bear.kind, bear.title, bear.season, bear.episodes[0]], ['episode', 'The Bear', 3, 4]);
  const dune = p('Dune.Part.Two.2024.2160p.UHD.BluRay.x265-GROUP.mkv');
  assert.deepEqual([dune.kind, dune.title, dune.year], ['movie', 'Dune Part Two', 2024]);
  assert.equal(dune.season, null);
});

test('numerazione assoluta: One Piece - 1100 non diventa S11E00', () => {
  const r = p('[SubsPlease] One Piece - 1100 (1080p) [11223344].mkv');
  assert.equal(r.title, 'One Piece');
  assert.deepEqual(r.episodes, [1100]);
  assert.equal(r.absolute, true);
});

test('versione v2, stagione nel titolo, multi-episodio, speciali', () => {
  const f = p('[SubsPlease] Frieren - 12v2 (1080p) [ABCD1234].mkv');
  assert.deepEqual([f.title, f.episodes[0], f.version], ['Frieren', 12, 2]);
  const s2 = p('[SubsPlease] Dandadan S2 - 03 (1080p) [AAAABBBB].mkv');
  assert.deepEqual([s2.title, s2.season, s2.episodes[0]], ['Dandadan', 2, 3]);
  const s3 = p('[Group] Mushoku Tensei 2nd Season - 05 [1080p].mkv');
  assert.deepEqual([s3.title, s3.season], ['Mushoku Tensei', 2]);
  const multi = p('Show.Name.S01E01E02.720p.HDTV.mkv');
  assert.deepEqual(multi.episodes, [1, 2]);
  assert.equal(episodeTag(1, multi.episodes), 'S01E01-E02');
  const ova = p('Spy x Family - OVA 01 [1080p].mkv');
  assert.deepEqual([ova.title, ova.season, ova.episodes[0], ova.special], ['Spy x Family', 0, 1, 'ova']);
  const judas = p('[Judas] Shingeki no Kyojin - S04E28 [1080p][HEVC x265 10bit].mkv');
  assert.deepEqual([judas.title, judas.season, judas.episodes[0]], ['Shingeki no Kyojin', 4, 28]);
});

test('nomi sicuri: niente separatori, traversal o caratteri vietati', () => {
  assert.equal(safeName('../../etc/passwd'), 'etcpasswd');
  assert.equal(safeName('Chainsaw Man - The Movie: Reze Arc'), 'Chainsaw Man - The Movie - Reze Arc');
  assert.equal(safeName('..'), 'Senza titolo');
  assert.ok(!safeName('a/b\\c').includes('/'));
});
