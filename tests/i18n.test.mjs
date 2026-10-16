// Traduzioni (D-035): ogni testo marcato ha l'inglese con le stesse variabili, e nei file convertiti
// non resta testo scritto direttamente nel JSX (si vedrebbe in italiano anche con l'interfaccia in inglese).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { check, WEB } from '../scripts/dev/i18n.mjs';

/** File già tradotti: aggiungerne uno qui rende il controllo obbligatorio anche per lui. */
export const CONVERTED = [
  'components/Layout.tsx',
  'components/ui.tsx',
  'components/AppTile.tsx',
  'components/CommandPalette.tsx',
  'components/Chart.tsx',
  'pages/Login.tsx',
  'pages/MfaSetup.tsx',
  'pages/Dashboard.tsx',
  'widgets/widgets.tsx',
];
// Uguali in tutte le lingue (nomi propri, sigle, unità)
const SAME = /^(GIGI OS|Homelab control center|CPU|GPU|RAM|Swap|Docker|Kernel|Host|Uptime|Jellyfin|qBittorrent|Armony|Apollo|Telegram|ms|MB|GB|IP|MAC|DNS|HTTP|HTTPS|TCP|UDP|ID|OK|·|—|→|↑|↓|%|\d+)$/;
const ATTRS = new Set(['title', 'placeholder', 'aria-label', 'label', 'description', 'subtitle', 'help', 'alt', 'k', 'ariaLabel']);

test('ogni testo marcato ha la traduzione inglese con le stesse variabili', () => {
  const r = check();
  assert.deepEqual(r.missing, [], `traduzioni mancanti in apps/web/src/i18n/en.json (node scripts/dev/i18n.mjs --missing)`);
  assert.deepEqual(r.badVars, [], 'variabili {nome} diverse tra italiano e inglese');
  assert.deepEqual(r.empty, [], 'traduzioni vuote');
  assert.deepEqual(r.unused, [], 'chiavi inutilizzate in en.json');
});

test('nei file convertiti nessun testo italiano fuori da t()', () => {
  const problems = [];
  for (const rel of CONVERTED) {
    const file = path.join(WEB, rel);
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const at = (n) => `${rel}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
    const visit = (n) => {
      // Comandi e codice (<code>, <kbd>, <pre>) restano come sono
      const tag = n.parent && ts.isJsxElement(n.parent) ? n.parent.openingElement.tagName.getText() : '';
      if (ts.isJsxText(n) && !['code', 'kbd', 'pre'].includes(tag)) {
        const txt = n.text.replace(/\s+/g, ' ').trim();
        if (/[A-Za-zÀ-ÿ]{2,}/.test(txt) && !SAME.test(txt)) problems.push(`${at(n)} testo «${txt}»`);
      }
      if (ts.isJsxAttribute(n) && n.initializer && ts.isStringLiteral(n.initializer) && ATTRS.has(n.name.getText())) {
        const v = n.initializer.text;
        if (/[A-Za-zÀ-ÿ]{2,}/.test(v) && !SAME.test(v)) problems.push(`${at(n)} ${n.name.getText()}="${v}"`);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  assert.deepEqual(problems, []);
});
