// Parser dei nomi di release (scene, fansub, film, speciali). Nessuna dipendenza: le librerie valutate
// sbagliano proprio i casi anime (vedi DECISIONS D-010). Ogni deduzione viene annotata in `notes`.

export type Parsed = {
  kind: 'episode' | 'movie' | 'unknown';
  title: string;
  year: number | null;
  season: number | null;
  episodes: number[];
  /** numerazione assoluta (es. One Piece - 1100): la stagione non è deducibile dal nome */
  absolute: boolean;
  special: 'ova' | 'ona' | 'oad' | 'special' | null;
  version: number | null;
  group: string | null;
  crc: string | null;
  resolution: string | null;
  ext: string;
  animeSignals: string[];
  notes: string[];
};

export const VIDEO_EXT = new Set(['mkv', 'mp4', 'avi', 'm4v', 'ts', 'm2ts', 'webm', 'mov', 'wmv']);
export const SUB_EXT = new Set(['srt', 'ass', 'ssa', 'vtt', 'sub', 'idx', 'sup']);

const FANSUB_GROUPS = new Set(
  [
    'subsplease', 'erai-raws', 'ember', 'judas', 'asw', 'horriblesubs', 'yameii', 'tsundere-raws', 'toonshub', 'sallysubs',
    'commie', 'gg', 'coalgirls', 'kametsu', 'beatrice-raws', 'dkb', 'anime time', 'vcb-studio', 'moozzi2', 'nyanpasu',
    'smol', 'golumpa', 'varyg', 'neko-raws', 'kawaiika-raws', 'ohys-raws', 'leopard-raws', 'itachiuchiha', 'sxales',
  ].map((s) => s.toLowerCase()),
);

const TECH =
  /\b(2160p|1080p|720p|576p|480p|4k|uhd|hdr10\+?|hdr|dv|dovi|sdr|web[ .-]?dl|webrip|web|bluray|blu-ray|bdrip|brrip|bd|dvdrip|hdtv|remux|x264|x265|h\.?264|h\.?265|hevc|avc|av1|vp9|aac(?:2\.0)?|eac3|e-ac-3|ac3|ddp?(?:5\.1|2\.0)?|dts(?:-hd)?|truehd|atmos|flac|opus|10bit|8bit|hi10p?|multisub|multi[- ]?subs?|dual[- ]?audio|ita|eng|jpn|sub[- ]?ita|amzn|nf|dsnp|cr|hmax|atvp|proper|repack|internal|limited|extended|uncut|complete|batch)\b/i;

const pad = (n: number) => String(n).padStart(2, '0');

function cleanTitle(s: string): string {
  return s
    .replace(/[._]+/g, ' ')
    .replace(/\s*[-–—:]+\s*$/g, '')
    .replace(/^\s*[-–—:]+\s*/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function parseReleaseName(fileName: string): Parsed {
  const notes: string[] = [];
  const animeSignals: string[] = [];
  const extMatch = /\.([a-z0-9]{2,4})$/i.exec(fileName);
  const ext = extMatch ? extMatch[1].toLowerCase() : '';
  let s = extMatch ? fileName.slice(0, -extMatch[0].length) : fileName;

  // Gruppo iniziale tra parentesi quadre: tipico delle release fansub
  let group: string | null = null;
  const g = /^\s*\[([^\]]+)\]\s*/.exec(s);
  if (g) {
    group = g[1].trim();
    s = s.slice(g[0].length);
    animeSignals.push(`gruppo fansub [${group}]`);
  }
  if (group && FANSUB_GROUPS.has(group.toLowerCase())) animeSignals.push('gruppo noto per release anime');

  // CRC32 finale [0FFEE1CA]
  let crc: string | null = null;
  const c = /\[([0-9A-F]{8})\]\s*$/i.exec(s);
  if (c) {
    crc = c[1].toUpperCase();
    s = s.slice(0, c.index);
    animeSignals.push('checksum CRC32 nel nome');
  }

  const resolution = /\b(2160p|1080p|720p|576p|480p|4k)\b/i.exec(s)?.[1].toLowerCase() ?? null;

  // Rimuove i blocchi tecnici tra parentesi, ma conserva l'anno "(2025)"
  let yearFromParens: number | null = null;
  s = s.replace(/[[(]([^\])]*)[\])]/g, (m, inner: string) => {
    const y = /^\s*((?:19|20)\d{2})\s*$/.exec(inner);
    if (y) {
      yearFromParens = Number(y[1]);
      return ` (${y[1]}) `;
    }
    return TECH.test(inner) || /^[\s\w.+-]*$/.test(inner) ? ' ' : m;
  });
  if (/\bmultisub\b/i.test(fileName)) animeSignals.push('MultiSub');

  let season: number | null = null;
  let episodes: number[] = [];
  let absolute = false;
  let special: Parsed['special'] = null;
  let version: number | null = null;
  let title = '';
  let kind: Parsed['kind'] = 'unknown';

  // 1) SxxEyy, SxxEyyEzz, SxxEyy-Ezz
  const se = /\bS(\d{1,2})[ ._-]?E(\d{1,4})((?:[ ._-]?E\d{1,4}|-\d{1,4})*)\b/i.exec(s);
  // 2) 1x04
  const nx = !se ? /\b(\d{1,2})x(\d{2,3})\b/.exec(s) : null;
  // 3) Speciali: "OVA 01", "OVA", "SP2", "Special 03", "ONA 1"
  const sp = /(?:^|\s-\s|\s)(OVA|OAD|ONA|SP|Specials?)(?:\s*(\d{1,3}))?(?=\s|$)/i.exec(s);
  // 4) Fansub " - 12", " - 12v2", " - 1100", batch " - 01 ~ 08"
  const fs = /\s[-–]\s(\d{1,4})(?:v(\d))?(?:\s*[~-]\s*(\d{1,4}))?(?:\s*(?:END|FINAL))?(?=\s|$)/i.exec(s);

  if (se) {
    season = Number(se[1]);
    episodes = [Number(se[2])];
    for (const m of (se[3] ?? '').matchAll(/(\d{1,4})/g)) episodes.push(Number(m[1]));
    if (/-\d/.test(se[3] ?? '') && episodes.length === 2) episodes = range(episodes[0], episodes[1]);
    title = s.slice(0, se.index);
    kind = 'episode';
    notes.push(`stagione/episodio dal pattern S${pad(season)}E${pad(episodes[0])}`);
  } else if (nx) {
    season = Number(nx[1]);
    episodes = [Number(nx[2])];
    title = s.slice(0, nx.index);
    kind = 'episode';
    notes.push(`stagione/episodio dal pattern ${nx[0]}`);
  } else if (sp) {
    const kw = sp[1].toLowerCase();
    special = kw === 'ova' ? 'ova' : kw === 'oad' ? 'oad' : kw === 'ona' ? 'ona' : 'special';
    season = 0;
    episodes = [sp[2] ? Number(sp[2]) : 1];
    title = s.slice(0, sp.index);
    kind = 'episode';
    notes.push(`speciale (${sp[1].toUpperCase()}) → stagione 0`);
    animeSignals.push(`speciale ${sp[1].toUpperCase()}`);
  } else if (fs) {
    const ep = Number(fs[1]);
    version = fs[2] ? Number(fs[2]) : null;
    title = s.slice(0, fs.index);
    kind = 'episode';
    episodes = fs[3] ? range(ep, Number(fs[3])) : [ep];
    if (fs[3]) notes.push(`pacchetto episodi ${ep}–${fs[3]}`);
    animeSignals.push('numerazione fansub " - NN"');
    // Stagione nel titolo: "Title S2", "Title Season 2", "Title 2nd Season"
    const ts =
      /\s(?:S(\d{1,2})|Season\s+(\d{1,2})|(\d{1,2})(?:st|nd|rd|th)\s+Season)\s*$/i.exec(cleanTitle(title)) ?? null;
    if (ts) {
      season = Number(ts[1] ?? ts[2] ?? ts[3]);
      title = cleanTitle(title).slice(0, ts.index);
      notes.push(`stagione ${season} dal titolo`);
    } else if (ep > 99 && !fs[3]) {
      absolute = true;
      season = 1;
      notes.push(`numerazione assoluta (episodio ${ep}): stagione non deducibile dal nome`);
    } else {
      season = 1;
      notes.push('nessuna stagione nel nome: assunta stagione 1');
    }
    if (version) notes.push(`versione v${version} della release`);
  }

  // Anno: "(2025)" oppure ".2024." non in testa al titolo
  const yearInline = /(?:^|[\s.(])((?:19|20)\d{2})(?=[\s.)]|$)/g;
  let year: number | null = yearFromParens;
  if (kind !== 'episode') {
    let m: RegExpExecArray | null;
    let found: RegExpExecArray | null = null;
    while ((m = yearInline.exec(s))) if (m.index > 0) found = m;
    if (found) {
      year = Number(found[1]);
      title = s.slice(0, found.index);
      kind = 'movie';
      notes.push(`anno ${year} → film`);
    } else {
      // Nessun episodio e nessun anno: probabile film, da confermare
      const firstTech = s.search(TECH);
      title = firstTech > 0 ? s.slice(0, firstTech) : s;
      kind = 'movie';
      notes.push('nessun episodio né anno: ipotesi film');
    }
  }

  title = cleanTitle(title.replace(/\((?:19|20)\d{2}\)/, ''));
  if (/\bthe movie\b|\bmovie\b|劇場版/i.test(title) && kind === 'movie') animeSignals.push('"Movie" nel titolo');

  return { kind, title, year, season, episodes, absolute, special, version, group, crc, resolution, ext, animeSignals, notes };
}

function range(a: number, b: number) {
  if (b < a || b - a > 200) return [a];
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

export function episodeTag(season: number, episodes: number[]) {
  const s = `S${pad(season)}E${pad(episodes[0])}`;
  return episodes.length > 1 ? `${s}-E${pad(episodes[episodes.length - 1])}` : s;
}

/** Normalizzazione per i confronti: minuscolo, senza accenti né punteggiatura. */
export function norm(s: string) {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Similarità 0..1: coefficiente di Dice sui bigrammi + bonus per uguaglianza esatta normalizzata. */
export function similarity(a: string, b: string) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const grams = (t: string) => {
    const m = new Map<string, number>();
    const u = t.replace(/ /g, '');
    for (let i = 0; i < u.length - 1; i++) m.set(u.slice(i, i + 2), (m.get(u.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const ga = grams(x);
  const gb = grams(y);
  let inter = 0;
  for (const [k, v] of ga) inter += Math.min(v, gb.get(k) ?? 0);
  const total = [...ga.values()].reduce((p, v) => p + v, 0) + [...gb.values()].reduce((p, v) => p + v, 0);
  return total ? (2 * inter) / total : 0;
}

/** Nome sicuro per file e cartelle (nessun separatore, nessun carattere vietato, niente ".." ). */
export function safeName(s: string) {
  const out = s
    .replace(/:/g, ' -')
    .replace(/[/\\*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim();
  return out === '' || out === '.' || out === '..' ? 'Senza titolo' : out.slice(0, 180);
}
