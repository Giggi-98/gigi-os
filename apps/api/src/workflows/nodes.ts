// Catalogo dei blocchi dei flussi (D-041): ricezione, logica e azioni. Ogni blocco dichiara i campi (per l'editor),
// le uscite e cosa fa. I campi di tipo «expr» accettano testo con {{ espressioni }} (vedi expr.ts).
import { XMLParser } from 'fast-xml-parser';
import { evaluate, render, renderText, toTime, type Scope } from './expr.js';

export type Json = Record<string, unknown>;
export type FieldKind = 'text' | 'expr' | 'textarea' | 'number' | 'select' | 'multi' | 'bool' | 'channels' | 'rows' | 'secret' | 'json';
export type Field = {
  key: string;
  label: string;
  kind: FieldKind;
  help?: string;
  placeholder?: string;
  required?: boolean;
  default?: unknown;
  options?: { value: string; label: string }[];
  /** rows: colonne di ogni riga */
  columns?: { key: string; label: string; kind: 'text' | 'expr' | 'select'; options?: { value: string; label: string }[] }[];
  min?: number;
  max?: number;
};
export type Category = 'trigger' | 'logic' | 'action';
export type TriggerKind = 'manual' | 'webhook' | 'schedule' | 'event' | 'poll' | 'telegram';

export type Result =
  | { port: string; json: Json }
  | { wait: { until: number }; json: Json }
  | { approval: { message: string; options: { label: string; value: unknown }[]; timeoutMs: number }; json: Json };

export type NodeDeps = {
  /** Azione di un'integrazione (qBittorrent, Jellyfin…) per tipo, con le credenziali del vault */
  integration(type: string): { id: string; name: string } | null;
  integrationAction(id: string, name: string, body: unknown): Promise<unknown>;
  integrationResource(id: string, name: string, params: URLSearchParams): Promise<unknown>;
  notify(channelId: string, title: string, body: string, level: 'info' | 'warning' | 'error', label: string): Promise<void>;
  channelIds(): string[];
  event(level: 'info' | 'warning' | 'error', title: string, details?: string | null): void;
  /** Richiesta HTTP in uscita con le protezioni SSRF di GIGI OS */
  fetchOut(url: string, init: RequestInit & { timeoutMs?: number }): Promise<{ status: number; text: string; type: string | null }>;
  docker(name: string, op: 'start' | 'restart'): Promise<void>;
  rescanLibrary(): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
};

export type RunCtx = {
  json: Json;
  scope: Scope;
  config: Json;
  /** Valore del campo con le espressioni risolte */
  get(key: string): Promise<unknown>;
  text(key: string): Promise<string>;
  deps: NodeDeps;
  workflow: { id: string; name: string };
  nodeName: string;
  secret: string | null;
  state: { get(key: string): string | null; set(key: string, value: string): void };
};

export type NodeDef = {
  type: string;
  category: Category;
  label: string;
  description: string;
  icon: string;
  fields: Field[];
  /** Uscite fisse; `dynamicOutputs` calcola le uscite dalla configurazione (es. «Scegli strada») */
  outputs: { id: string; label: string }[];
  dynamicOutputs?: (config: Json) => { id: string; label: string }[];
  trigger?: TriggerKind;
  /** Blocchi con un segreto (token del webhook generato da GIGI OS, o token di un servizio esterno inserito dall'utente) */
  secret?: 'webhook' | 'user';
  run?(ctx: RunCtx): Promise<Result>;
  /** Ricezione a intervalli: restituisce gli elementi trovati, ognuno con un id stabile per non ripeterli */
  poll?(ctx: RunCtx): Promise<{ id: string; json: Json }[]>;
  /** Intervallo del polling in millisecondi, dalla configurazione */
  every?(config: Json): number;
};

const OUT = [{ id: 'out', label: '' }];
const LEVELS = [
  { value: 'info', label: 'Informazione' },
  { value: 'warning', label: 'Avviso' },
  { value: 'error', label: 'Errore' },
];
const SOURCES = ['docker', 'sistema', 'rete', 'integrazioni', 'media', 'download', 'backup', 'sicurezza', 'aggiornamenti', 'automazioni'].map((s) => ({ value: s, label: s }));
const minutes = (c: Json, key = 'minutes', min = 1) => Math.max(min, Number(c[key] ?? 15) || 15) * 60_000;
const asObj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : { value: v });

// ───────── condizioni (Filtro, Scegli strada) ─────────
export const OPERATORS = [
  { value: 'eq', label: 'è uguale a' },
  { value: 'ne', label: 'è diverso da' },
  { value: 'contains', label: 'contiene' },
  { value: 'not_contains', label: 'non contiene' },
  { value: 'gt', label: 'maggiore di' },
  { value: 'lt', label: 'minore di' },
  { value: 'exists', label: 'esiste (non vuoto)' },
  { value: 'empty', label: 'è vuoto' },
  { value: 'regex', label: 'corrisponde a (regex)' },
  { value: 'before', label: 'data prima di adesso' },
  { value: 'after', label: 'data dopo adesso' },
];
const isEmpty = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v as object).length);
export function compare(left: unknown, op: string, right: unknown, now: number): boolean {
  const ls = typeof left === 'object' && left !== null ? JSON.stringify(left) : String(left ?? '');
  const rs = String(right ?? '');
  const num = (v: unknown) => (typeof v === 'number' ? v : Number(String(v).replace(',', '.')));
  switch (op) {
    case 'eq':
      return ls.toLowerCase() === rs.toLowerCase();
    case 'ne':
      return ls.toLowerCase() !== rs.toLowerCase();
    case 'contains':
      return Array.isArray(left) ? left.some((x) => String(x).toLowerCase() === rs.toLowerCase()) : ls.toLowerCase().includes(rs.toLowerCase());
    case 'not_contains':
      return !compare(left, 'contains', right, now);
    case 'gt':
      return num(left) > num(right);
    case 'lt':
      return num(left) < num(right);
    case 'exists':
      return !isEmpty(left);
    case 'empty':
      return isEmpty(left);
    case 'regex':
      try {
        return new RegExp(rs.slice(0, 200), 'i').test(ls);
      } catch {
        return false;
      }
    case 'before': {
      const t = toTime(left);
      return t !== null && t < now;
    }
    case 'after': {
      const t = toTime(left);
      return t !== null && t > now;
    }
    default:
      return false;
  }
}
const CONDITION_COLUMNS: Field['columns'] = [
  { key: 'left', label: 'Valore', kind: 'expr' },
  { key: 'op', label: 'Condizione', kind: 'select', options: OPERATORS },
  { key: 'right', label: 'Confronto', kind: 'expr' },
];
async function conditions(ctx: RunCtx, rows: unknown, mode: unknown) {
  const list = Array.isArray(rows) ? (rows as Json[]) : [];
  if (!list.length) return true;
  const res: boolean[] = [];
  for (const r of list) res.push(compare(await render(r.left, ctx.scope), String(r.op ?? 'eq'), await render(r.right, ctx.scope), ctx.deps.now()));
  return mode === 'any' ? res.some(Boolean) : res.every(Boolean);
}

// ───────── qualità e scelta dei torrent ─────────
const QUALITY = ['2160p', '1080p', '720p', '480p'];
export const qualityOf = (name: string) => QUALITY.find((q) => new RegExp(`\\b${q}\\b`, 'i').test(name)) ?? (/\b(4k|uhd)\b/i.test(name) ? '2160p' : null);
type Torrent = { name: string; url: string; size: number; seeders: number; leechers: number; plugin: string | null; engine: string; info: string | null };
export function pickTorrents(list: Torrent[], o: { include?: string; exclude?: string; minSeeds?: number; minGb?: number; maxGb?: number; prefer?: string[]; limit?: number }) {
  const re = (s?: string) => {
    if (!s) return null;
    try {
      return new RegExp(s.slice(0, 200), 'i');
    } catch {
      throw new Error(`Espressione regolare non valida: ${s}`);
    }
  };
  const inc = re(o.include);
  const exc = re(o.exclude);
  const prefer = o.prefer?.length ? o.prefer : ['1080p', '2160p', '720p'];
  const rank = (q: string | null) => (q && prefer.includes(q) ? prefer.indexOf(q) : prefer.length);
  return list
    .filter((t) => (!inc || inc.test(t.name)) && (!exc || !exc.test(t.name)))
    .filter((t) => t.seeders >= (o.minSeeds ?? 1))
    .filter((t) => (!o.minGb || t.size >= o.minGb * 1024 ** 3) && (!o.maxGb || t.size <= o.maxGb * 1024 ** 3))
    .map((t) => ({ ...t, quality: qualityOf(t.name), sizeGb: Math.round((t.size / 1024 ** 3) * 10) / 10 }))
    .sort((a, b) => rank(a.quality) - rank(b.quality) || b.seeders - a.seeders)
    .slice(0, Math.min(Math.max(o.limit ?? 3, 1), 10));
}

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', processEntities: true, htmlEntities: true });

// ───────── catalogo ─────────
export const NODES: NodeDef[] = [
  // Ricezione
  {
    type: 'trigger.manual',
    category: 'trigger',
    label: 'Avvio manuale',
    description: 'Parte con il pulsante «Esegui» dell’editor, con i dati di prova indicati.',
    icon: 'Play',
    trigger: 'manual',
    fields: [{ key: 'sample', label: 'Dati di prova (JSON)', kind: 'json', default: '{\n  "title": "Il nome della rosa",\n  "year": 1986\n}' }],
    outputs: OUT,
  },
  {
    type: 'trigger.webhook',
    category: 'trigger',
    label: 'Webhook in entrata',
    description: 'Un servizio esterno chiama un indirizzo di GIGI OS con un token segreto (Authorization: Bearer). Raggiungibile dalla rete locale o dalla VPN.',
    icon: 'Webhook',
    trigger: 'webhook',
    secret: 'webhook',
    fields: [
      {
        key: 'respond',
        label: 'Risposta al chiamante',
        kind: 'select',
        default: 'accepted',
        options: [
          { value: 'accepted', label: '202 subito (il flusso prosegue in background)' },
          { value: 'id', label: '202 con l’id dell’esecuzione' },
        ],
      },
    ],
    outputs: OUT,
  },
  {
    type: 'trigger.schedule',
    category: 'trigger',
    label: 'Pianificazione',
    description: 'Ogni N minuti, ogni giorno o in giorni della settimana a un’ora precisa, oppure una volta sola.',
    icon: 'CalendarClock',
    trigger: 'schedule',
    fields: [
      {
        key: 'mode',
        label: 'Quando',
        kind: 'select',
        default: 'daily',
        options: [
          { value: 'interval', label: 'Ogni N minuti' },
          { value: 'daily', label: 'Ogni giorno' },
          { value: 'weekly', label: 'Giorni della settimana' },
          { value: 'once', label: 'Una volta sola' },
        ],
      },
      { key: 'minutes', label: 'Ogni quanti minuti', kind: 'number', default: 60, min: 1, max: 10080 },
      { key: 'time', label: 'Ora (HH:MM)', kind: 'text', default: '08:00', placeholder: '08:00' },
      {
        key: 'days',
        label: 'Giorni',
        kind: 'multi',
        default: ['1', '2', '3', '4', '5'],
        options: ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'].map((l, i) => ({ value: String(i), label: l })),
      },
      { key: 'at', label: 'Data e ora (una volta sola)', kind: 'text', placeholder: '2026-12-24T20:30' },
    ],
    outputs: OUT,
  },
  {
    type: 'trigger.event',
    category: 'trigger',
    label: 'Evento di GIGI OS',
    description: 'Parte quando GIGI OS registra un evento: container, download, media, backup, aggiornamenti, sicurezza…',
    icon: 'Zap',
    trigger: 'event',
    fields: [
      { key: 'sources', label: 'Origini', kind: 'multi', options: SOURCES, help: 'Nessuna = tutte' },
      { key: 'minLevel', label: 'Livello minimo', kind: 'select', default: 'info', options: LEVELS },
      { key: 'match', label: 'Il titolo contiene', kind: 'text', placeholder: 'Disponibile in Jellyfin' },
    ],
    outputs: OUT,
  },
  {
    type: 'trigger.http',
    category: 'trigger',
    label: 'Controlla un’API (JSON)',
    description: 'Legge a intervalli un indirizzo che risponde in JSON e parte per ogni elemento nuovo.',
    icon: 'RefreshCw',
    trigger: 'poll',
    secret: 'user',
    fields: [
      { key: 'url', label: 'Indirizzo', kind: 'text', required: true, placeholder: 'https://esempio.it/api/lista' },
      { key: 'items', label: 'Elenco degli elementi (JSONata)', kind: 'text', default: '$', help: 'Dove sta la lista nella risposta, es. data.items. «$» = la risposta stessa' },
      { key: 'id', label: 'Id di ogni elemento (JSONata)', kind: 'text', default: 'id', help: 'Serve a non ripartire per elementi già visti' },
      { key: 'minutes', label: 'Ogni quanti minuti', kind: 'number', default: 15, min: 1, max: 1440 },
      { key: 'skipExisting', label: 'Ignora quelli già presenti al primo controllo', kind: 'bool', default: true },
    ],
    outputs: OUT,
    every: (c) => minutes(c),
    async poll(ctx) {
      const r = await ctx.deps.fetchOut(String(ctx.config.url), { headers: { Accept: 'application/json', ...(ctx.secret ? { Authorization: `Bearer ${ctx.secret}` } : {}) }, timeoutMs: 15_000 });
      if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
      const body = JSON.parse(r.text) as unknown;
      const list = await evaluate(String(ctx.config.items || '$'), body);
      const arr = Array.isArray(list) ? list : list ? [list] : [];
      const out: { id: string; json: Json }[] = [];
      for (const it of arr.slice(0, 500)) {
        const id = await evaluate(String(ctx.config.id || 'id'), it);
        out.push({ id: String(id ?? JSON.stringify(it)).slice(0, 200), json: asObj(it) });
      }
      return out;
    },
  },
  {
    type: 'trigger.github',
    category: 'trigger',
    label: 'GitHub',
    description: 'Nuovi commit, issue, pull request o release di una repo, oppure un file che cambia. Per le repo private serve un token in sola lettura.',
    icon: 'GitBranch',
    trigger: 'poll',
    secret: 'user',
    fields: [
      { key: 'repo', label: 'Repo (proprietario/nome)', kind: 'text', required: true, placeholder: 'utente/progetto' },
      {
        key: 'what',
        label: 'Cosa controllare',
        kind: 'select',
        default: 'commits',
        options: [
          { value: 'commits', label: 'Nuovi commit' },
          { value: 'issues', label: 'Issue nuove o con un’etichetta' },
          { value: 'pulls', label: 'Pull request nuove' },
          { value: 'releases', label: 'Release nuove' },
          { value: 'file', label: 'Un file che cambia' },
        ],
      },
      { key: 'branch', label: 'Ramo', kind: 'text', placeholder: 'main' },
      { key: 'path', label: 'Percorso del file (per «un file che cambia»)', kind: 'text', placeholder: 'data/lista.json' },
      { key: 'label', label: 'Etichetta (per le issue)', kind: 'text', placeholder: 'confermato' },
      { key: 'minutes', label: 'Ogni quanti minuti', kind: 'number', default: 5, min: 2, max: 1440 },
      { key: 'skipExisting', label: 'Ignora quelli già presenti al primo controllo', kind: 'bool', default: true },
    ],
    outputs: OUT,
    every: (c) => minutes(c, 'minutes', 2),
    async poll(ctx) {
      const repo = String(ctx.config.repo ?? '');
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Repo non valida: serve «proprietario/nome»');
      const branch = String(ctx.config.branch ?? '').trim();
      const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'gigi-os', ...(ctx.secret ? { Authorization: `Bearer ${ctx.secret}` } : {}) };
      const gh = async (p: string) => {
        const r = await ctx.deps.fetchOut(`https://api.github.com/repos/${repo}${p}`, { headers, timeoutMs: 15_000 });
        if (r.status === 404) throw new Error('Repo non trovata o privata: serve un token con accesso in lettura');
        if (r.status >= 400) throw new Error(`GitHub: HTTP ${r.status}`);
        return JSON.parse(r.text) as unknown;
      };
      const what = String(ctx.config.what ?? 'commits');
      if (what === 'file') {
        const p = String(ctx.config.path ?? '').replace(/^\/+/, '');
        if (!p) throw new Error('Indica il percorso del file');
        const f = (await gh(`/contents/${p.split('/').map(encodeURIComponent).join('/')}${branch ? `?ref=${encodeURIComponent(branch)}` : ''}`)) as { sha: string; content?: string; encoding?: string; path: string; html_url: string };
        const text = f.content && f.encoding === 'base64' ? Buffer.from(f.content, 'base64').toString('utf8') : '';
        let data: unknown = null;
        try {
          data = JSON.parse(text);
        } catch {}
        return [{ id: f.sha, json: { path: f.path, sha: f.sha, url: f.html_url, text: text.slice(0, 200_000), data } }];
      }
      if (what === 'commits') {
        const list = (await gh(`/commits?per_page=30${branch ? `&sha=${encodeURIComponent(branch)}` : ''}`)) as { sha: string; html_url: string; commit: { message: string; author: { name: string; date: string } } }[];
        return list.map((c) => ({ id: c.sha, json: { sha: c.sha, message: c.commit.message, author: c.commit.author.name, date: c.commit.author.date, url: c.html_url } }));
      }
      if (what === 'releases') {
        const list = (await gh('/releases?per_page=20')) as { id: number; tag_name: string; name: string; body: string; html_url: string; published_at: string; prerelease: boolean }[];
        return list.map((r) => ({ id: String(r.id), json: { tag: r.tag_name, name: r.name, notes: r.body, url: r.html_url, date: r.published_at, prerelease: r.prerelease } }));
      }
      const label = String(ctx.config.label ?? '').trim();
      const list = (await gh(what === 'pulls' ? '/pulls?state=open&per_page=30' : `/issues?state=all&per_page=30${label ? `&labels=${encodeURIComponent(label)}` : ''}`)) as {
        id: number;
        number: number;
        title: string;
        body: string | null;
        html_url: string;
        user: { login: string };
        labels?: { name: string }[];
        created_at: string;
        pull_request?: unknown;
      }[];
      return list
        .filter((i) => what === 'pulls' || !i.pull_request)
        .map((i) => ({ id: String(i.id), json: { number: i.number, title: i.title, body: i.body ?? '', url: i.html_url, author: i.user.login, labels: (i.labels ?? []).map((l) => l.name), date: i.created_at } }));
    },
  },
  {
    type: 'trigger.rss',
    category: 'trigger',
    label: 'Feed RSS / Atom',
    description: 'Parte per ogni nuova voce di un feed.',
    icon: 'Rss',
    trigger: 'poll',
    fields: [
      { key: 'url', label: 'Indirizzo del feed', kind: 'text', required: true, placeholder: 'https://esempio.it/feed.xml' },
      { key: 'minutes', label: 'Ogni quanti minuti', kind: 'number', default: 30, min: 5, max: 1440 },
      { key: 'skipExisting', label: 'Ignora le voci già presenti al primo controllo', kind: 'bool', default: true },
    ],
    outputs: OUT,
    every: (c) => minutes(c, 'minutes', 5),
    async poll(ctx) {
      const r = await ctx.deps.fetchOut(String(ctx.config.url), { headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' }, timeoutMs: 15_000 });
      if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
      const doc = xml.parse(r.text) as Json;
      const rss = (doc.rss as Json | undefined)?.channel as Json | undefined;
      const atom = doc.feed as Json | undefined;
      const raw = (rss?.item ?? atom?.entry ?? []) as unknown;
      const items = (Array.isArray(raw) ? raw : [raw]) as Json[];
      const txt = (v: unknown): string => (typeof v === 'string' ? v : v && typeof v === 'object' ? String((v as Json)['#text'] ?? (v as Json)['@href'] ?? '') : v == null ? '' : String(v));
      return items.slice(0, 100).map((i) => {
        const link = Array.isArray(i.link) ? txt(i.link[0]) : txt(i.link);
        const id = txt(i.guid) || txt(i.id) || link || txt(i.title);
        return { id, json: { title: txt(i.title), link, date: txt(i.pubDate ?? i.updated ?? i.published), summary: txt(i.description ?? i.summary).slice(0, 5000) } };
      });
    },
  },
  {
    type: 'trigger.telegram',
    category: 'trigger',
    label: 'Comando Telegram',
    description: 'Parte quando un account collegato (operatore o amministratore) scrive al bot un comando, es. /film Matrix 1999.',
    icon: 'Send',
    trigger: 'telegram',
    fields: [{ key: 'command', label: 'Comando', kind: 'text', required: true, placeholder: '/film', help: 'Lettere minuscole, numeri e _, senza spazi' }],
    outputs: OUT,
  },

  // Logica
  {
    type: 'logic.filter',
    category: 'logic',
    label: 'Filtro (se / allora)',
    description: 'Divide il flusso in due strade secondo una o più condizioni.',
    icon: 'Funnel',
    fields: [
      { key: 'conditions', label: 'Condizioni', kind: 'rows', columns: CONDITION_COLUMNS, default: [{ left: '{{ json.status }}', op: 'eq', right: 'confermato' }] },
      {
        key: 'mode',
        label: 'Passa se',
        kind: 'select',
        default: 'all',
        options: [
          { value: 'all', label: 'Tutte le condizioni sono vere' },
          { value: 'any', label: 'Almeno una è vera' },
        ],
      },
    ],
    outputs: [
      { id: 'true', label: 'Sì' },
      { id: 'false', label: 'No' },
    ],
    async run(ctx) {
      return { port: (await conditions(ctx, ctx.config.conditions, ctx.config.mode)) ? 'true' : 'false', json: ctx.json };
    },
  },
  {
    type: 'logic.switch',
    category: 'logic',
    label: 'Scegli strada',
    description: 'Più strade: la prima condizione vera decide dove prosegue il flusso.',
    icon: 'Split',
    fields: [
      {
        key: 'routes',
        label: 'Strade',
        kind: 'rows',
        columns: [{ key: 'label', label: 'Nome', kind: 'text' }, ...CONDITION_COLUMNS!],
        default: [{ label: 'Film', left: '{{ json.type }}', op: 'eq', right: 'film' }],
      },
    ],
    outputs: [{ id: 'else', label: 'Altrimenti' }],
    dynamicOutputs: (c) => [
      ...(Array.isArray(c.routes) ? (c.routes as Json[]) : []).map((r, i) => ({ id: `r${i}`, label: String(r.label || `Strada ${i + 1}`) })),
      { id: 'else', label: 'Altrimenti' },
    ],
    async run(ctx) {
      const routes = Array.isArray(ctx.config.routes) ? (ctx.config.routes as Json[]) : [];
      for (let i = 0; i < routes.length; i++) if (await conditions(ctx, [routes[i]], 'all')) return { port: `r${i}`, json: ctx.json };
      return { port: 'else', json: ctx.json };
    },
  },
  {
    type: 'logic.set',
    category: 'logic',
    label: 'Imposta campi',
    description: 'Crea o cambia campi dei dati (titolo, data, valori calcolati…) da usare nei blocchi successivi.',
    icon: 'PenLine',
    fields: [
      { key: 'fields', label: 'Campi', kind: 'rows', columns: [{ key: 'name', label: 'Nome', kind: 'text' }, { key: 'value', label: 'Valore', kind: 'expr' }], default: [{ name: 'title', value: '{{ trigger.body.title }}' }] },
      { key: 'keep', label: 'Mantieni gli altri campi', kind: 'bool', default: true },
    ],
    outputs: OUT,
    async run(ctx) {
      const out: Json = ctx.config.keep === false ? {} : { ...ctx.json };
      for (const f of Array.isArray(ctx.config.fields) ? (ctx.config.fields as Json[]) : []) {
        const name = String(f.name ?? '').trim();
        if (name) out[name] = await render(f.value, { ...ctx.scope, json: out });
      }
      return { port: 'out', json: out };
    },
  },
  {
    type: 'logic.wait',
    category: 'logic',
    label: 'Attendi',
    description: 'Mette in pausa questa strada per un certo tempo oppure fino a una data (anche «2 giorni prima della data»). Sopravvive ai riavvii.',
    icon: 'Hourglass',
    fields: [
      {
        key: 'mode',
        label: 'Attesa',
        kind: 'select',
        default: 'until',
        options: [
          { value: 'for', label: 'Per un certo tempo' },
          { value: 'until', label: 'Fino a una data' },
        ],
      },
      { key: 'amount', label: 'Quanto (per un certo tempo)', kind: 'number', default: 30, min: 1 },
      {
        key: 'unit',
        label: 'Unità',
        kind: 'select',
        default: 'minutes',
        options: [
          { value: 'minutes', label: 'minuti' },
          { value: 'hours', label: 'ore' },
          { value: 'days', label: 'giorni' },
        ],
      },
      { key: 'until', label: 'Data (fino a una data)', kind: 'expr', default: '{{ json.date }}', help: 'ISO 8601, «AAAA-MM-GG» o millisecondi' },
      { key: 'offsetHours', label: 'Anticipo in ore', kind: 'number', default: 0, help: 'Es. 48 = due giorni prima della data' },
    ],
    outputs: OUT,
    async run(ctx) {
      const unit = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 }[String(ctx.config.unit ?? 'minutes')] ?? 60_000;
      let until: number;
      if (ctx.config.mode === 'for') until = ctx.deps.now() + Math.max(1, Number(ctx.config.amount ?? 1)) * unit;
      else {
        const t = toTime(await ctx.get('until'));
        if (t === null) throw new Error('Data non riconosciuta: usa ISO 8601 (2026-12-24T20:30) o AAAA-MM-GG');
        until = t - (Number(ctx.config.offsetHours ?? 0) || 0) * 3_600_000;
      }
      return until <= ctx.deps.now() ? { port: 'out', json: ctx.json } : { wait: { until }, json: ctx.json };
    },
  },
  {
    type: 'logic.dedupe',
    category: 'logic',
    label: 'Ignora doppioni',
    description: 'Fa passare un valore (es. il titolo) una volta sola in un periodo; le ripetizioni vanno nell’uscita «Doppione».',
    icon: 'CopyX',
    fields: [
      { key: 'key', label: 'Chiave', kind: 'expr', default: '{{ json.title }}' },
      { key: 'days', label: 'Per quanti giorni', kind: 'number', default: 30, min: 1, max: 3650 },
    ],
    outputs: [
      { id: 'new', label: 'Nuovo' },
      { id: 'dup', label: 'Doppione' },
    ],
    async run(ctx) {
      const key = (await ctx.text('key')).trim().toLowerCase().slice(0, 300);
      const k = `dedupe:${key}`;
      const prev = Number(ctx.state.get(k) ?? 0);
      const days = Number(ctx.config.days ?? 30) * 86_400_000;
      if (prev && ctx.deps.now() - prev < days) return { port: 'dup', json: ctx.json };
      ctx.state.set(k, String(ctx.deps.now()));
      return { port: 'new', json: ctx.json };
    },
  },
  {
    type: 'logic.approval',
    category: 'logic',
    label: 'Chiedi conferma',
    description: 'Manda una domanda su Telegram agli account collegati (operatori e amministratori) e nella pagina Automazioni, con un pulsante per opzione. Il flusso aspetta la risposta.',
    icon: 'UserCheck',
    fields: [
      { key: 'message', label: 'Messaggio', kind: 'textarea', default: 'Scarico «{{ json.title }}»?' },
      { key: 'options', label: 'Opzioni (lista, facoltativa)', kind: 'expr', help: 'Es. {{ json.torrents }}: un pulsante per elemento. Vuoto = solo «Approva»' },
      { key: 'optionLabel', label: 'Testo di ogni opzione (JSONata sull’elemento)', kind: 'text', default: 'name', help: 'Es. quality & " · " & $string(sizeGb) & " GB · " & $string(seeders) & " seed"' },
      { key: 'timeoutHours', label: 'Scade dopo (ore)', kind: 'number', default: 24, min: 1, max: 720 },
    ],
    outputs: [
      { id: 'approved', label: 'Approvato' },
      { id: 'rejected', label: 'Rifiutato' },
      { id: 'timeout', label: 'Scaduto' },
    ],
    async run(ctx) {
      const message = await ctx.text('message');
      const raw = await ctx.get('options');
      const list = Array.isArray(raw) ? raw.slice(0, 8) : [];
      const options: { label: string; value: unknown }[] = [];
      for (const v of list) {
        const l = await evaluate(String(ctx.config.optionLabel || 'name'), v).catch(() => null);
        options.push({ label: String(l ?? (typeof v === 'object' ? JSON.stringify(v) : v)).slice(0, 60), value: v });
      }
      if (!options.length) options.push({ label: 'Approva', value: true });
      return { approval: { message, options, timeoutMs: Math.max(1, Number(ctx.config.timeoutHours ?? 24)) * 3_600_000 }, json: ctx.json };
    },
  },

  // Azioni
  {
    type: 'action.notify',
    category: 'action',
    label: 'Notifica',
    description: 'Manda un messaggio sui canali di notifica configurati (Telegram, ntfy, Home Assistant, webhook).',
    icon: 'Bell',
    fields: [
      { key: 'channels', label: 'Canali', kind: 'channels', help: 'Nessuno = tutti i canali attivi' },
      { key: 'title', label: 'Titolo', kind: 'expr', default: '{{ json.title }}' },
      { key: 'body', label: 'Testo', kind: 'textarea', default: '' },
      { key: 'level', label: 'Livello', kind: 'select', default: 'info', options: LEVELS },
    ],
    outputs: OUT,
    async run(ctx) {
      const chosen = Array.isArray(ctx.config.channels) && ctx.config.channels.length ? (ctx.config.channels as string[]) : ctx.deps.channelIds();
      if (!chosen.length) throw new Error('Nessun canale di notifica configurato');
      const title = await ctx.text('title');
      const body = await ctx.text('body');
      const level = (['info', 'warning', 'error'].includes(String(ctx.config.level)) ? ctx.config.level : 'info') as 'info';
      const errors: string[] = [];
      for (const c of chosen) await ctx.deps.notify(c, title, body, level, `flusso ${ctx.workflow.name}`).catch((e: Error) => errors.push(e.message));
      if (errors.length === chosen.length) throw new Error(`Notifica non inviata: ${errors[0]}`);
      return { port: 'out', json: { ...ctx.json, notified: chosen.length - errors.length } };
    },
  },
  {
    type: 'action.http',
    category: 'action',
    label: 'Richiesta HTTP',
    description: 'Chiama un’API esterna o della rete locale autorizzata. La risposta finisce in json.response.',
    icon: 'Globe',
    secret: 'user',
    fields: [
      { key: 'method', label: 'Metodo', kind: 'select', default: 'POST', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({ value: m, label: m })) },
      { key: 'url', label: 'Indirizzo', kind: 'expr', required: true, placeholder: 'https://esempio.it/api' },
      { key: 'headers', label: 'Intestazioni', kind: 'rows', columns: [{ key: 'name', label: 'Nome', kind: 'text' }, { key: 'value', label: 'Valore', kind: 'expr' }] },
      { key: 'body', label: 'Corpo (JSON)', kind: 'textarea', default: '{{ json }}' },
    ],
    outputs: OUT,
    async run(ctx) {
      const method = String(ctx.config.method ?? 'POST');
      const headers: Record<string, string> = { 'User-Agent': 'gigi-os' };
      for (const h of Array.isArray(ctx.config.headers) ? (ctx.config.headers as Json[]) : []) {
        const n = String(h.name ?? '').trim();
        if (/^[\w-]{1,60}$/.test(n)) headers[n] = await renderText(h.value, ctx.scope);
      }
      if (ctx.secret) headers.Authorization = `Bearer ${ctx.secret}`;
      let body: string | undefined;
      if (!['GET', 'DELETE'].includes(method)) {
        const b = await render(ctx.config.body ?? '', ctx.scope);
        body = typeof b === 'string' ? b : JSON.stringify(b);
        headers['Content-Type'] ??= 'application/json';
      }
      const r = await ctx.deps.fetchOut(await ctx.text('url'), { method, headers, body, timeoutMs: 20_000 });
      let parsed: unknown = r.text;
      try {
        parsed = JSON.parse(r.text);
      } catch {}
      if (r.status >= 400) throw new Error(`HTTP ${r.status}: ${r.text.slice(0, 200)}`);
      return { port: 'out', json: { ...ctx.json, response: { status: r.status, body: parsed } } };
    },
  },
  {
    type: 'action.torrent_search',
    category: 'action',
    label: 'Cerca torrent',
    description: 'Cerca con i plugin di ricerca già installati in qBittorrent e tiene i risultati migliori secondo lingua, qualità, dimensione e seed. Scarica solo ciò che hai diritto di scaricare.',
    icon: 'Search',
    fields: [
      { key: 'query', label: 'Ricerca', kind: 'expr', required: true, default: '{{ json.title }} {{ json.year }} ITA' },
      {
        key: 'category',
        label: 'Categoria',
        kind: 'select',
        default: 'movies',
        options: [
          { value: 'all', label: 'Tutte' },
          { value: 'movies', label: 'Film' },
          { value: 'tv', label: 'Serie TV' },
          { value: 'anime', label: 'Anime' },
        ],
      },
      { key: 'include', label: 'Il nome deve contenere (regex)', kind: 'text', default: '\\b(ita|italian|italiano)\\b', help: 'Predefinito: audio italiano' },
      { key: 'exclude', label: 'Escludi (regex)', kind: 'text', default: '\\b(cam|camrip|ts|telesync|hdcam)\\b' },
      { key: 'prefer', label: 'Qualità preferite, in ordine', kind: 'text', default: '1080p, 2160p, 720p' },
      { key: 'minSeeds', label: 'Seed minimi', kind: 'number', default: 3, min: 0 },
      { key: 'minGb', label: 'Dimensione minima (GB)', kind: 'number', default: 0.7, min: 0 },
      { key: 'maxGb', label: 'Dimensione massima (GB)', kind: 'number', default: 25, min: 0 },
      { key: 'limit', label: 'Quanti risultati tenere', kind: 'number', default: 3, min: 1, max: 10 },
      { key: 'seconds', label: 'Durata della ricerca (secondi)', kind: 'number', default: 25, min: 5, max: 120 },
    ],
    outputs: [
      { id: 'found', label: 'Trovati' },
      { id: 'none', label: 'Nessuno' },
    ],
    async run(ctx) {
      const qb = ctx.deps.integration('qbittorrent');
      if (!qb) throw new Error('qBittorrent non è collegato');
      const pattern = (await ctx.text('query')).replace(/\s+/g, ' ').trim();
      const { id } = (await ctx.deps.integrationAction(qb.id, 'searchStart', { pattern, category: ctx.config.category ?? 'all' })) as { id: number };
      let results: Torrent[] = [];
      try {
        const end = ctx.deps.now() + Math.min(Math.max(Number(ctx.config.seconds ?? 25), 5), 120) * 1000;
        for (;;) {
          await ctx.deps.sleep(2000);
          const r = (await ctx.deps.integrationAction(qb.id, 'searchResults', { id })) as { status: string; results: Torrent[] };
          results = r.results;
          if (r.status !== 'Running' || ctx.deps.now() >= end) break;
        }
      } finally {
        await ctx.deps.integrationAction(qb.id, 'searchStop', { id }).catch(() => undefined);
      }
      const torrents = pickTorrents(results, {
        include: String(ctx.config.include ?? ''),
        exclude: String(ctx.config.exclude ?? ''),
        minSeeds: Number(ctx.config.minSeeds ?? 1),
        minGb: Number(ctx.config.minGb ?? 0),
        maxGb: Number(ctx.config.maxGb ?? 0),
        prefer: String(ctx.config.prefer ?? '').split(/[,\s]+/).filter(Boolean),
        limit: Number(ctx.config.limit ?? 3),
      });
      return { port: torrents.length ? 'found' : 'none', json: { ...ctx.json, query: pattern, totalResults: results.length, torrents, best: torrents[0] ?? null } };
    },
  },
  {
    type: 'action.torrent_add',
    category: 'action',
    label: 'Aggiungi a qBittorrent',
    description: 'Aggiunge un link magnet o un risultato di ricerca. Il motore media lo porterà in libreria quando è completo.',
    icon: 'Download',
    fields: [
      { key: 'url', label: 'Link (magnet o risultato)', kind: 'expr', required: true, default: '{{ json.approval.value.url }}' },
      { key: 'plugin', label: 'Plugin del risultato', kind: 'expr', default: '{{ json.approval.value.plugin }}', help: 'Serve per i risultati che puntano a una pagina web' },
      { key: 'category', label: 'Categoria di qBittorrent', kind: 'text', default: 'Film' },
      { key: 'stopped', label: 'Aggiungi in pausa', kind: 'bool', default: false },
    ],
    outputs: OUT,
    async run(ctx) {
      const qb = ctx.deps.integration('qbittorrent');
      if (!qb) throw new Error('qBittorrent non è collegato');
      const url = await ctx.text('url');
      if (!url) throw new Error('Nessun link da aggiungere');
      const plugin = await ctx.text('plugin');
      const r = (await ctx.deps.integrationAction(qb.id, 'add', { urls: [url], plugin, category: ctx.config.category ?? '', stopped: ctx.config.stopped === true })) as { hashes: string[] };
      return { port: 'out', json: { ...ctx.json, added: r.hashes } };
    },
  },
  {
    type: 'action.jellyfin_find',
    category: 'action',
    label: 'C’è già in Jellyfin?',
    description: 'Cerca un titolo nella libreria di Jellyfin, per non scaricare quello che c’è già.',
    icon: 'Clapperboard',
    fields: [
      { key: 'title', label: 'Titolo', kind: 'expr', required: true, default: '{{ json.title }}' },
      { key: 'year', label: 'Anno (facoltativo)', kind: 'expr', default: '{{ json.year }}' },
    ],
    outputs: [
      { id: 'found', label: 'C’è già' },
      { id: 'missing', label: 'Non c’è' },
    ],
    async run(ctx) {
      const jf = ctx.deps.integration('jellyfin');
      if (!jf) throw new Error('Jellyfin non è collegato');
      const title = (await ctx.text('title')).trim();
      const year = Number(await ctx.text('year')) || null;
      const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
      const hits = (await ctx.deps.integrationResource(jf.id, 'search', new URLSearchParams({ q: title }))) as { id: string; name: string; type: string; year: number | null }[];
      const match = hits.find((h) => h.type !== 'Episode' && norm(h.name) === norm(title) && (!year || !h.year || Math.abs(h.year - year) <= 1));
      return { port: match ? 'found' : 'missing', json: { ...ctx.json, jellyfin: match ?? null } };
    },
  },
  {
    type: 'action.jellyfin_scan',
    category: 'action',
    label: 'Scansione Jellyfin',
    description: 'Avvia la scansione delle librerie di Jellyfin.',
    icon: 'ScanLine',
    fields: [],
    outputs: OUT,
    async run(ctx) {
      await ctx.deps.rescanLibrary();
      return { port: 'out', json: ctx.json };
    },
  },
  {
    type: 'action.docker',
    category: 'action',
    label: 'Container Docker',
    description: 'Avvia o riavvia un container consentito (GIGI_CONTROL_ALLOW). Fermare resta un’azione manuale.',
    icon: 'Container',
    fields: [
      { key: 'container', label: 'Nome del container', kind: 'expr', required: true },
      {
        key: 'op',
        label: 'Azione',
        kind: 'select',
        default: 'restart',
        options: [
          { value: 'start', label: 'Avvia' },
          { value: 'restart', label: 'Riavvia' },
        ],
      },
    ],
    outputs: OUT,
    async run(ctx) {
      const name = (await ctx.text('container')).trim();
      if (!/^[\w.-]{1,100}$/.test(name)) throw new Error('Nome del container non valido');
      await ctx.deps.docker(name, ctx.config.op === 'start' ? 'start' : 'restart');
      return { port: 'out', json: { ...ctx.json, container: name } };
    },
  },
  {
    type: 'action.event',
    category: 'action',
    label: 'Scrivi un evento',
    description: 'Aggiunge una riga agli eventi di GIGI OS (origine «automazioni»): utile come registro o per far partire altri flussi.',
    icon: 'ScrollText',
    fields: [
      { key: 'title', label: 'Titolo', kind: 'expr', required: true, default: '{{ json.title }}' },
      { key: 'details', label: 'Dettagli', kind: 'textarea' },
      { key: 'level', label: 'Livello', kind: 'select', default: 'info', options: LEVELS },
    ],
    outputs: OUT,
    async run(ctx) {
      const level = (['info', 'warning', 'error'].includes(String(ctx.config.level)) ? ctx.config.level : 'info') as 'info';
      ctx.deps.event(level, (await ctx.text('title')).slice(0, 200), (await ctx.text('details')).slice(0, 2000) || null);
      return { port: 'out', json: ctx.json };
    },
  },
];

export const NODE_BY_TYPE = new Map(NODES.map((n) => [n.type, n]));
export const outputsOf = (def: NodeDef, config: Json) => (def.dynamicOutputs ? def.dynamicOutputs(config) : def.outputs);
