// Espressioni dei flussi (D-041): testo con {{ … }} valutato con JSONata sui dati dell'esecuzione.
// Niente JavaScript: JSONata è un linguaggio di interrogazione. Limiti di tempo e profondità contro le espressioni infinite.
import jsonata from 'jsonata';

export type Scope = { json: unknown; trigger: unknown; node: Record<string, unknown>; now: number };

const MAX_MS = 500;
const MAX_DEPTH = 200;
function compile(src: string) {
  try {
    return jsonata(src);
  } catch (err) {
    throw new Error(`Espressione non valida «${src.slice(0, 80)}»: ${(err as Error).message}`);
  }
}

/** Valuta una singola espressione JSONata (senza {{ }}) sul dato indicato: il contesto dei flussi o un singolo elemento. */
export async function evaluate(src: string, scope: Scope | unknown): Promise<unknown> {
  // Una compilazione per valutazione: i limiti (hook documentati di JSONata) restano di questa valutazione
  const expr = compile(src);
  let depth = 0;
  const start = Date.now();
  const bind = expr.assign as unknown as (k: symbol, v: unknown) => void;
  bind(Symbol.for('jsonata.__evaluate_entry'), () => {
    depth++;
    if (depth > MAX_DEPTH) throw new Error('Espressione troppo profonda');
    if (Date.now() - start > MAX_MS) throw new Error('Espressione troppo lenta');
  });
  bind(Symbol.for('jsonata.__evaluate_exit'), () => {
    depth--;
  });
  try {
    const v = await expr.evaluate(scope);
    return v === undefined ? null : v;
  } catch (err) {
    const e = err as { message?: string };
    throw new Error(`Espressione «${src.slice(0, 80)}»: ${e.message ?? String(err)}`);
  }
}

const TEMPLATE = /\{\{([\s\S]+?)\}\}/g;

/**
 * Testo con espressioni. Se il campo è una sola espressione ({{ x }}) restituisce il valore così com'è
 * (numero, lista, oggetto); altrimenti sostituisce ogni {{ … }} con il suo valore come testo.
 */
export async function render(value: unknown, scope: Scope): Promise<unknown> {
  if (typeof value !== 'string') return value;
  const whole = /^\s*\{\{([\s\S]+?)\}\}\s*$/.exec(value);
  if (whole && !whole[1].includes('}}')) return evaluate(whole[1].trim(), scope);
  if (!value.includes('{{')) return value;
  let out = '';
  let last = 0;
  for (const m of value.matchAll(TEMPLATE)) {
    out += value.slice(last, m.index);
    const v = await evaluate(m[1].trim(), scope);
    out += v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    last = m.index! + m[0].length;
  }
  return out + value.slice(last);
}

export async function renderText(value: unknown, scope: Scope): Promise<string> {
  const v = await render(value, scope);
  return v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** Controllo della sintassi al salvataggio. */
export function checkTemplate(value: unknown): string | null {
  if (typeof value !== 'string' || !value.includes('{{')) return null;
  for (const m of value.matchAll(TEMPLATE)) {
    try {
      compile(m[1].trim());
    } catch (e) {
      return (e as Error).message;
    }
  }
  return null;
}

/** Converte in data: millisecondi, secondi Unix, ISO 8601, «AAAA-MM-GG». */
export function toTime(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e11 ? v * 1000 : v;
  if (typeof v === 'string' && v.trim()) {
    const s = v.trim();
    if (/^\d+$/.test(s)) return toTime(Number(s));
    // «AAAA-MM-GG» senza ora: mezzanotte locale, non UTC
    const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00`) : new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  }
  return null;
}
