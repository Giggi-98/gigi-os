// Decisione: dai dati raccolti (parsing, ffprobe, Jellyfin locale e remoto) alla destinazione proposta,
// con punteggio di confidenza e motivazioni leggibili. Funzione pura: nessun I/O, interamente testabile.
import path from 'node:path';
import { episodeTag, norm, safeName, similarity, type Parsed } from './parse.js';
import type { Probe } from './probe.js';

export type LibraryKey = 'movies' | 'series' | 'animeMovies' | 'animeSeries';
export type Libraries = Record<LibraryKey, string>;

export const LIBRARY_LABEL: Record<LibraryKey, string> = {
  movies: 'Film',
  series: 'Serie TV',
  animeMovies: 'Anime · Film',
  animeSeries: 'Anime · Serie',
};

export type Candidate = { name: string; year: number | null; ids: Record<string, string>; source: string; hostPath?: string | null };

export type Override = {
  kind?: 'movie' | 'episode';
  anime?: boolean;
  title?: string;
  year?: number | null;
  season?: number;
  episodes?: number[];
  by?: string;
};

export type DecideInput = {
  fileName: string;
  ext: string;
  category: string | null;
  parsed: Parsed;
  probe: Probe | null;
  local: Candidate[];
  remote: Candidate[];
  libraries: Libraries;
  override?: Override | null;
};

export type Reason = { delta: number; text: string };

export type Plan = {
  library: LibraryKey;
  libraryRoot: string;
  kind: 'movie' | 'episode';
  anime: boolean;
  name: string;
  year: number | null;
  season: number | null;
  episodes: number[];
  folder: string;
  dest: string;
  matched: Candidate | null;
  existingFolder: boolean;
};

export type Decision = { plan: Plan | null; confidence: number; reasons: Reason[]; blocking: string | null };

function categoryHint(cat: string | null): { anime: boolean | null; kind: 'movie' | 'episode' | null } {
  const c = norm(cat ?? '');
  if (!c) return { anime: null, kind: null };
  if (c.includes('anime')) return { anime: true, kind: null };
  if (/\b(film|movie|movies|cinema)\b/.test(c)) return { anime: false, kind: 'movie' };
  if (/\b(serie|series|tv|show|shows)\b/.test(c)) return { anime: false, kind: 'episode' };
  return { anime: null, kind: null };
}

function within(root: string, p: string) {
  const r = path.resolve(root);
  const x = path.resolve(p);
  return x === r || x.startsWith(r + path.sep);
}

export function decide(i: DecideInput): Decision {
  const reasons: Reason[] = [];
  const add = (delta: number, text: string) => reasons.push({ delta, text });
  const p = i.parsed;
  const o = i.override ?? null;

  const kind: 'movie' | 'episode' | 'unknown' = o?.kind ?? p.kind;
  if (kind === 'unknown' || !(o?.title ?? p.title)) {
    return { plan: null, confidence: 0, reasons: [{ delta: 0, text: 'Nome non interpretabile: serve una correzione manuale' }], blocking: 'nome non interpretabile' };
  }

  // ── Anime o no ──
  const hint = categoryHint(i.category);
  const localAnime = i.local.find((c) => c.hostPath && (within(i.libraries.animeSeries, c.hostPath) || within(i.libraries.animeMovies, c.hostPath)));
  let anime: boolean;
  if (o?.anime !== undefined) anime = o.anime;
  else if (localAnime) anime = true;
  else if (hint.anime !== null) anime = hint.anime;
  else anime = p.animeSignals.length >= 2;

  // ── Corrispondenze ──
  const title = o?.title ?? p.title;
  const year = o?.year !== undefined ? o.year : p.year;
  const bestLocal = [...i.local]
    .map((c) => ({ c, s: similarity(title, c.name) }))
    .sort((a, b) => b.s - a.s)[0];
  const ranked = [...i.remote].map((c) => ({ c, s: similarity(title, c.name) })).sort((a, b) => b.s - a.s || (a.c.source === 'TheMovieDb' ? -1 : 1));
  const top = ranked[0];

  if (o) {
    add(0, `Dati confermati manualmente${o.by ? ` da ${o.by}` : ''}`);
  } else {
    add(25, kind === 'episode' ? `Episodio riconosciuto dal nome (${p.notes[0] ?? 'pattern episodio'})` : `Film riconosciuto dal nome (${p.notes.find((n) => n.includes('film')) ?? 'nessun episodio'})`);
    if (hint.kind) {
      if (hint.kind === kind) add(10, `Categoria qBittorrent «${i.category}» coerente`);
      else add(-25, `Categoria qBittorrent «${i.category}» in conflitto con il nome (${kind === 'movie' ? 'film' : 'episodio'})`);
    }
    if (hint.anime === true) add(5, `Categoria «${i.category}» → anime`);
    else if (hint.anime === null && !localAnime) {
      if (anime) add(0, `Anime dedotto da: ${p.animeSignals.join(', ')}`);
      else if (p.animeSignals.length === 1) add(-5, `Un solo indizio anime (${p.animeSignals[0]}): trattato come non anime`);
    }
  }

  let matched: Candidate | null = null;
  let existingFolder = false;
  let name = title;
  let finalYear = year ?? null;

  if (kind === 'episode' && bestLocal && bestLocal.s >= 0.9 && bestLocal.c.hostPath) {
    matched = bestLocal.c;
    existingFolder = true;
    name = bestLocal.c.name;
    finalYear = bestLocal.c.year ?? finalYear;
    if (!o) add(45, `Serie già presente in Jellyfin: «${bestLocal.c.name}» (${path.basename(bestLocal.c.hostPath)})`);
  } else if (top) {
    const yearOk = !year || !top.c.year || Math.abs(top.c.year - year) <= 1;
    if (top.s >= 0.92 && yearOk) {
      matched = top.c;
      name = top.c.name;
      finalYear = top.c.year ?? finalYear;
      if (!o) add(35, `Corrispondenza ${top.c.source}: «${top.c.name}»${top.c.year ? ` (${top.c.year})` : ''}, similarità ${Math.round(top.s * 100)}%`);
    } else if (top.s >= 0.8 && yearOk) {
      matched = top.c;
      name = top.c.name;
      finalYear = top.c.year ?? finalYear;
      if (!o) add(15, `Corrispondenza probabile ${top.c.source}: «${top.c.name}», similarità ${Math.round(top.s * 100)}%`);
    } else if (!o) {
      add(-15, top.s >= 0.8 ? `Titolo simile a «${top.c.name}» ma anno diverso (${top.c.year} vs ${year})` : 'Nessuna corrispondenza affidabile nei provider di Jellyfin');
    }
    const homonyms = ranked.filter((r) => r !== top && r.s >= 0.92 && r.c.year && r.c.year !== top.c.year && norm(r.c.name) === norm(top.c.name));
    if (homonyms.length && !year && !o) add(-15, `Titoli omonimi con anni diversi (${[top, ...homonyms].map((r) => r.c.year).join(', ')}): anno non indicato nel nome`);
    if (year && top.c.year && yearOk && !o) add(10, `Anno ${year} confermato`);
  } else if (!o) {
    add(-15, 'Nessun risultato dai provider di metadati di Jellyfin');
  }
  if (o) name = o.title ?? name;

  // ── Analisi tecnica ──
  if (i.probe) {
    if (!i.probe.ok || !i.probe.video) add(-35, `ffprobe: file non leggibile o senza video${i.probe.error ? ` (${i.probe.error})` : ''}`);
    else {
      add(10, `File valido: ${i.probe.video.codec} ${i.probe.video.width}×${i.probe.video.height}, ${Math.round((i.probe.duration ?? 0) / 60)} min`);
      const min = (i.probe.duration ?? 0) / 60;
      if (kind === 'movie' && min > 0 && min < 40) add(-15, `Durata di ${Math.round(min)} min: insolita per un film`);
      if (kind === 'episode' && min > 80 && (p.episodes.length ?? 1) <= 1) add(-10, `Durata di ${Math.round(min)} min: insolita per un singolo episodio`);
    }
  }

  // ── Casi ambigui espliciti ──
  if (!o) {
    if (p.absolute) add(-35, 'Numerazione assoluta: la stagione corretta va verificata a mano');
    if (p.special) add(-15, `Speciale (${p.special.toUpperCase()}): la numerazione in stagione 0 va verificata`);
    if (p.version && p.version > 1) add(0, `Release v${p.version}: sostituisce eventuali versioni precedenti`);
  }

  // ── Piano ──
  const library: LibraryKey = kind === 'movie' ? (anime ? 'animeMovies' : 'movies') : anime ? 'animeSeries' : 'series';
  let libraryRoot = i.libraries[library];
  const season = kind === 'episode' ? (o?.season ?? p.season ?? 1) : null;
  const episodes = kind === 'episode' ? (o?.episodes ?? p.episodes) : [];
  let folder: string;
  let dest: string;

  if (kind === 'episode') {
    let seriesDir: string;
    if (existingFolder && matched?.hostPath) {
      seriesDir = matched.hostPath;
      const owner = (Object.keys(i.libraries) as LibraryKey[]).find((k) => within(i.libraries[k], seriesDir));
      if (owner && owner !== library) {
        libraryRoot = i.libraries[owner];
        add(0, `La serie esiste già in «${LIBRARY_LABEL[owner]}»: uso quella cartella`);
      }
    } else {
      const homonymYear = i.remote.some((r) => r !== matched && norm(r.name) === norm(name) && r.year && r.year !== finalYear);
      seriesDir = path.join(libraryRoot, safeName(homonymYear && finalYear ? `${name} (${finalYear})` : name));
    }
    folder = path.join(seriesDir, season === 0 ? 'Season 00' : `Season ${String(season).padStart(2, '0')}`);
    dest = path.join(folder, `${safeName(path.basename(seriesDir))} - ${episodeTag(season ?? 1, episodes.length ? episodes : [1])}.${i.ext}`);
  } else {
    const base = safeName(finalYear ? `${name} (${finalYear})` : name);
    folder = path.join(libraryRoot, base);
    dest = path.join(folder, `${base}.${i.ext}`);
    if (!finalYear && !o) add(-10, 'Anno del film sconosciuto: possibile confusione con omonimi');
  }

  if (!within(libraryRoot, dest)) {
    return { plan: null, confidence: 0, reasons: [...reasons, { delta: 0, text: 'Destinazione fuori dalla libreria: rifiutata' }], blocking: 'destinazione non valida' };
  }

  const raw = o ? 100 : reasons.reduce((a, r) => a + r.delta, 0);
  const confidence = Math.max(0, Math.min(100, raw));
  return {
    plan: { library, libraryRoot, kind, anime, name, year: finalYear, season, episodes, folder, dest, matched, existingFolder },
    confidence,
    reasons,
    blocking: null,
  };
}
