// Traduzioni (D-035). Il testo italiano è la chiave: t('Testo') restituisce la traduzione nella lingua attiva,
// oppure il testo stesso. Variabili con {nome}; plurali con tn(n, 'singolare', 'plurale') e Intl.PluralRules.
// La lingua si sceglie prima che i moduli vengano valutati e il cambio ricarica la pagina: così funzionano anche
// le etichette definite fuori dai componenti (menu, mappe di stati).
import { createElement, Fragment, type ReactNode } from 'react';
import en from '../i18n/en.json';

export type Lang = 'en' | 'it';
export const LANGS: { id: Lang; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'it', label: 'Italiano' },
];
const DICTS: Record<Lang, Record<string, string>> = { en: en as Record<string, string>, it: {} };
const KEY = 'gigi-lang';

function detect(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'en' || saved === 'it') return saved;
  } catch {}
  const prefs = typeof navigator !== 'undefined' ? navigator.languages ?? [navigator.language] : [];
  return prefs.some((l) => l?.toLowerCase().startsWith('it')) ? 'it' : 'en';
}

export const lang: Lang = detect();
/** Locale per date e numeri: italiano, oppure l'inglese del browser (en-US, en-GB…). */
export const locale =
  lang === 'it' ? 'it-IT' : (typeof navigator !== 'undefined' && (navigator.languages ?? []).find((l) => /^en(-|$)/i.test(l))) || 'en-US';
if (typeof document !== 'undefined') document.documentElement.lang = lang;

export function setLang(l: Lang) {
  try {
    localStorage.setItem(KEY, l);
  } catch {}
  window.location.reload();
}

const fill = (s: string, vars?: Record<string, string | number>) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s);

/**
 * Testo nella lingua attiva. Una parola con più significati usa una chiave con contesto, «contesto::Testo»
 * (es. «rete::Download» per la direzione del traffico): senza traduzione si mostra la parte dopo «::».
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const tr = DICTS[lang][key];
  return fill(tr ?? (key.includes('::') ? key.slice(key.indexOf('::') + 2) : key), vars);
}

const plural = new Intl.PluralRules(locale);
/** Plurale: la chiave è «singolare|plurale» in italiano; in en.json il valore è «singular|plural». {n} = numero. */
export function tn(n: number, one: string, other: string, vars?: Record<string, string | number>): string {
  const tr = DICTS[lang][`${one}|${other}`];
  const [o, p] = tr ? tr.split('|') : [one, other];
  return fill(plural.select(n) === 'one' ? o : p, { n, ...vars });
}

/** Marca una chiave tradotta più avanti con t(variabile): restituisce il testo così com'è, ma il controllo delle traduzioni la vede. */
export const tk = (key: string) => key;

/** Frase con elementi (es. <code>, <strong>): tr('Lo trovi con {cmd}.', { cmd: <code>…</code> }). La frase resta intera da tradurre. */
export function tr(key: string, parts: Record<string, ReactNode>): ReactNode {
  const s = DICTS[lang][key] ?? key;
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of s.matchAll(/\{(\w+)\}/g)) {
    out.push(s.slice(last, m.index));
    out.push(m[1] in parts ? createElement(Fragment, { key: m.index }, parts[m[1]]) : m[0]);
    last = m.index! + m[0].length;
  }
  out.push(s.slice(last));
  return createElement(Fragment, null, ...out);
}
