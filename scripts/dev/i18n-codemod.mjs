// Conversione alle traduzioni (D-035): avvolge in t('…') i testi JSX e gli attributi visibili, senza riformattare i file.
// Uso: node scripts/dev/i18n-codemod.mjs apps/web/src/pages/Pagina.tsx [...]
// Le frasi spezzate da variabili o elementi non vengono toccate ma elencate: vanno convertite a mano con {variabili} o tr().
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const I18N = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../apps/web/src/lib/i18n');

const ATTRS = new Set(['title', 'placeholder', 'aria-label', 'label', 'description', 'subtitle', 'help', 'alt', 'k', 'ariaLabel']);
const HAS_WORDS = /[A-Za-zÀ-ÿ]{2,}/;
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

for (const file of process.argv.slice(2)) {
  const src = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const edits = [];
  const manual = [];
  const insideT = (n) => {
    for (let p = n.parent; p; p = p.parent) if (ts.isCallExpression(p) && ts.isIdentifier(p.expression) && ['t', 'tn'].includes(p.expression.text)) return true;
    return false;
  };
  const line = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const visit = (n) => {
    if (ts.isJsxText(n) && HAS_WORDS.test(n.text) && !insideT(n)) {
      const parent = n.parent;
      const kids = parent.children ?? [];
      const mixed = kids.some((k) => ts.isJsxExpression(k) && k.expression && !ts.isJsxElement(k.expression));
      const raw = n.text;
      const text = raw.replace(/\s+/g, ' ').trim();
      if (mixed) manual.push(`${line(n.getStart())}: frase con variabili «${text.slice(0, 70)}»`);
      else {
        const lead = raw.length - raw.trimStart().length;
        const trail = raw.length - raw.trimEnd().length;
        const start = n.pos + lead;
        const end = n.end - trail;
        // Spazi significativi ai bordi (es. testo dopo un elemento inline) restano fuori da t()
        const before = /^[ \t]+$/.test(raw.slice(0, lead)) ? ' ' : '';
        const after = /^[ \t]+$/.test(raw.slice(raw.length - trail)) ? ' ' : '';
        edits.push([start - (before ? lead : 0), end + (after ? trail : 0), `${before ? "{' '}" : ''}{t('${esc(text)}')}${after ? "{' '}" : ''}`]);
      }
    }
    if (ts.isJsxAttribute(n) && n.initializer && ts.isStringLiteral(n.initializer) && ATTRS.has(n.name.getText()) && HAS_WORDS.test(n.initializer.text)) {
      edits.push([n.initializer.getStart(), n.initializer.end, `{t('${esc(n.initializer.text)}')}`]);
    }
    // Stringhe fuori dal JSX con testo leggibile: da valutare a mano (toast, etichette, messaggi)
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && !insideT(n) && / /.test(n.text) && HAS_WORDS.test(n.text)) {
      const p = n.parent;
      const isAttr = ts.isJsxAttribute(p);
      const isImport = ts.isImportDeclaration(p) || ts.isExportDeclaration(p);
      const isClass = isAttr && ['className', 'style', 'role', 'type', 'autoComplete', 'inputMode'].includes(p.name.getText());
      const isCx = ts.isCallExpression(p) && ts.isIdentifier(p.expression) && ['cx', 'clsx'].includes(p.expression.text);
      const looksClass = /^[a-z0-9:[\]\-_/.%!() &>*=@#~,]+$/.test(n.text) && !/[àèéìòù]/.test(n.text);
      if (!isImport && !isClass && !isCx && !looksClass && !(isAttr && ATTRS.has(p.name.getText())))
        manual.push(`${line(n.getStart())}: stringa «${n.text.slice(0, 80)}»`);
    }
    if (ts.isTemplateExpression(n) && !insideT(n) && HAS_WORDS.test(n.head.text + n.templateSpans.map((s) => s.literal.text).join(' '))) {
      const txt = n.getText();
      if (!/^`[a-z0-9:[\]\-_/.%!() &>*=@#~,${}]+`$/.test(txt.replace(/\$\{[^}]*\}/g, '')) && / /.test(txt)) manual.push(`${line(n.getStart())}: template ${txt.slice(0, 90)}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  let out = src;
  for (const [s, e, r] of edits.sort((a, b) => b[0] - a[0])) out = out.slice(0, s) + r + out.slice(e);
  if (edits.length && !/import \{[^}]*\bt\b[^}]*\} from '[./]+lib\/i18n'/.test(out)) {
    const rel = path.relative(path.dirname(path.resolve(file)), I18N).replace(/\\/g, '/');
    const spec = rel.startsWith('.') ? rel : `./${rel}`;
    const m = /^import .*;$/m.exec(out);
    // Se il file importa già da lib/i18n (es. locale) si aggiunge t a quell'import
    const existing = new RegExp(`import \\{([^}]*)\\} from '${spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}';`).exec(out);
    if (existing) out = out.replace(existing[0], `import {${existing[1].trimEnd()}, t } from '${spec}';`);
    else out = out.slice(0, m.index) + `import { t } from '${spec}';\n` + out.slice(m.index);
  }
  writeFileSync(file, out);
  console.log(`\n### ${path.basename(file)}: ${edits.length} testi avvolti, ${manual.length} da vedere a mano`);
  for (const x of manual) console.log('  ' + x);
}
