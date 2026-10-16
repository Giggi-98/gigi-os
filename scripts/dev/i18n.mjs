// Controllo delle traduzioni (D-035). Uso: node scripts/dev/i18n.mjs [--missing|--unused]
// Estrae le chiavi da t('…'), tn('…', '…'), tr('…') e tk('…') nel frontend e le confronta con apps/web/src/i18n/en.json.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const WEB = path.join(ROOT, 'apps/web/src');
export const EN = path.join(WEB, 'i18n/en.json');

const files = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.(tsx?)$/.test(e.name) ? [path.join(dir, e.name)] : []));
const lit = String.raw`'((?:\\.|[^'\\])*)'`;
const unesc = (s) => s.replace(/\\(.)/g, '$1');

/** Mappa chiave → file in cui compare. Chiave plurale = «singolare|plurale». */
export function extract() {
  const keys = new Map();
  const add = (k, f) => keys.set(k, [...(keys.get(k) ?? []), path.relative(ROOT, f)]);
  for (const f of files(WEB)) {
    if (f.endsWith(path.join('lib', 'i18n.ts'))) continue;
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(new RegExp(String.raw`\b(?:t|tr|tk)\(\s*${lit}`, 'g'))) add(unesc(m[1]), f);
    for (const m of src.matchAll(new RegExp(String.raw`\btn\([^,]+,\s*${lit}\s*,\s*${lit}`, 'g'))) add(`${unesc(m[1])}|${unesc(m[2])}`, f);
  }
  return keys;
}

const vars = (s) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort().join(',');

export function check() {
  const keys = extract();
  const en = JSON.parse(readFileSync(EN, 'utf8'));
  const missing = [...keys.keys()].filter((k) => !(k in en));
  const unused = Object.keys(en).filter((k) => !keys.has(k));
  const badVars = Object.entries(en)
    .filter(([k]) => keys.has(k))
    .filter(([k, v]) => {
      if (k.includes('|') && v.includes('|')) {
        const [a, b] = k.split('|');
        const [x, y] = v.split('|');
        return vars(a) !== vars(x) || vars(b) !== vars(y);
      }
      return vars(k) !== vars(v);
    })
    .map(([k, v]) => `${k} → ${v}`);
  const empty = Object.entries(en).filter(([, v]) => !String(v).trim()).map(([k]) => k);
  return { keys, missing, unused, badVars, empty };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const r = check();
  if (process.argv.includes('--missing')) console.log(JSON.stringify(Object.fromEntries(r.missing.map((k) => [k, ''])), null, 2));
  else if (process.argv.includes('--unused')) console.log(r.unused.join('\n'));
  else console.log(`chiavi ${r.keys.size} · mancanti ${r.missing.length} · inutilizzate ${r.unused.length} · variabili diverse ${r.badVars.length} · vuote ${r.empty.length}`);
}
