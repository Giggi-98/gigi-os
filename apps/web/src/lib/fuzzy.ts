// Ricerca per somiglianza per Ctrl+K: sottostringa (meglio se a inizio parola), altrimenti lettere in ordine («jlf» → jellyfin).
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const boundary = (t: string, i: number) => i === 0 || /[\s\-_./:()]/.test(t[i - 1]);

/** 0 = nessuna corrispondenza; più alto = più pertinente. */
export function fuzzyScore(query: string, text: string): number {
  const q = norm(query.trim());
  const t = norm(text);
  if (!q) return 1;
  const idx = t.indexOf(q);
  if (idx >= 0) return 1000 + (boundary(t, idx) ? 300 : 0) - idx * 2 - t.length * 0.1;
  let score = 0;
  let from = 0;
  let prev = -2;
  for (const ch of q) {
    if (ch === ' ') continue;
    const f = t.indexOf(ch, from);
    if (f < 0) return 0;
    score += (f === prev + 1 ? 15 : 4) + (boundary(t, f) ? 10 : 0);
    prev = f;
    from = f + 1;
  }
  return Math.max(1, score - t.length * 0.1);
}
