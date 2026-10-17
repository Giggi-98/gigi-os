// Motore dei flussi (D-041): grafo di blocchi salvato nel database, esecuzioni con storico per blocco, attese e
// approvazioni persistenti (sopravvivono ai riavvii), pianificazioni e polling con un solo timer.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DB } from '../db.js';
import type { Vault } from '../vault.js';
import { checkTemplate, render, renderText, type Scope } from './expr.js';
import { NODE_BY_TYPE, outputsOf, type Field, type Json, type NodeDef, type NodeDeps, type Result, type RunCtx } from './nodes.js';

export type WfNode = { id: string; type: string; name: string; config: Json; position: { x: number; y: number } };
export type WfEdge = { id: string; source: string; port: string; target: string };
export type Graph = { nodes: WfNode[]; edges: WfEdge[] };
type WfRow = { id: string; name: string; enabled: number; graph: string; created_by: string | null; created_at: number; updated_at: number };
type RunRow = { id: string; workflow_id: string; trigger: string; status: string; context: string; error: string | null; started_at: number; finished_at: number | null };
type WaitRow = { id: string; run_id: string; node_id: string; kind: 'timer' | 'approval'; resume_at: number | null; input: string; options: string | null; message: string | null; created_at: number };
export type Approval = { waitId: string; workflow: string; message: string; options: { label: string }[]; expiresAt: number };

const ID = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_STEPS = 200;
const MAX_CONCURRENT = 4;
const RATE = { runs: 60, windowMs: 10 * 60_000 };
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const newId = () => randomBytes(10).toString('hex');
const clip = (v: unknown, n = 20_000) => {
  const s = JSON.stringify(v ?? null);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};
const parse = <T>(s: string | null, d: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : d;
  } catch {
    return d;
  }
};

export class WorkflowError extends Error {
  constructor(
    message: string,
    public statusCode = 400,
  ) {
    super(message);
  }
}

export type EngineDeps = NodeDeps & { log(msg: string, extra?: object): void };

export class Workflows {
  /** Invio delle richieste di conferma (bot Telegram); impostato da chi crea il bot */
  approvalSender: ((a: Approval) => Promise<void>) | null = null;
  private running = 0;
  private queue: (() => void)[] = [];
  private polling = new Set<string>();
  private recent = new Map<string, number[]>();
  private emitting = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private db: DB,
    private vault: Vault,
    private deps: EngineDeps,
  ) {
    // Le esecuzioni interrotte da un riavvio non si possono riprendere a metà di un blocco: si segnano come errore.
    // Attese e approvazioni invece sono salvate e riprendono.
    db.prepare("UPDATE workflow_runs SET status = 'error', error = 'Interrotto da un riavvio di GIGI OS', finished_at = ? WHERE status = 'running'").run(Date.now());
  }

  private now() {
    return this.deps.now();
  }

  // ───────── flussi ─────────
  private row(id: string) {
    const r = this.db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as WfRow | undefined;
    if (!r) throw new WorkflowError('Flusso non trovato', 404);
    return r;
  }
  private view(r: WfRow) {
    return { id: r.id, name: r.name, enabled: !!r.enabled, graph: parse<Graph>(r.graph, { nodes: [], edges: [] }), createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at };
  }

  list() {
    const rows = this.db.prepare('SELECT * FROM workflows ORDER BY name COLLATE NOCASE').all() as WfRow[];
    const last = this.db.prepare('SELECT status, started_at, error FROM workflow_runs WHERE workflow_id = ? ORDER BY started_at DESC LIMIT 1');
    const count = this.db.prepare("SELECT COUNT(*) AS n, SUM(status = 'error') AS e, SUM(status = 'waiting') AS w FROM workflow_runs WHERE workflow_id = ? AND started_at > ?");
    return rows.map((r) => {
      const v = this.view(r);
      const l = last.get(r.id) as { status: string; started_at: number; error: string | null } | undefined;
      const c = count.get(r.id, this.now() - 7 * 86_400_000) as { n: number; e: number | null; w: number | null };
      return {
        id: v.id,
        name: v.name,
        enabled: v.enabled,
        updatedAt: v.updatedAt,
        triggers: v.graph.nodes.filter((n) => NODE_BY_TYPE.get(n.type)?.category === 'trigger').map((n) => ({ type: n.type, name: n.name })),
        nodes: v.graph.nodes.length,
        lastRun: l ? { status: l.status, at: l.started_at, error: l.error } : null,
        week: { runs: c.n, errors: c.e ?? 0, waiting: c.w ?? 0 },
      };
    });
  }

  get(id: string) {
    const v = this.view(this.row(id));
    const secrets = this.db.prepare('SELECT node_id, token_hash, secret_enc FROM workflow_secrets WHERE workflow_id = ?').all(id) as { node_id: string; token_hash: string | null; secret_enc: string | null }[];
    return {
      ...v,
      secrets: Object.fromEntries(secrets.map((s) => [s.node_id, { token: !!s.token_hash, secret: !!s.secret_enc }])),
    };
  }

  create(name: string, graph: Graph, by: string) {
    this.validate(graph, name);
    const id = randomBytes(8).toString('hex');
    const now = this.now();
    this.db.prepare('INSERT INTO workflows (id, name, enabled, graph, created_by, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?, ?)').run(id, name.trim(), JSON.stringify(graph), by, now, now);
    return this.get(id);
  }

  update(id: string, p: { name?: string; enabled?: boolean; graph?: Graph }) {
    const r = this.row(id);
    const name = p.name ?? r.name;
    const graph = p.graph ?? parse<Graph>(r.graph, { nodes: [], edges: [] });
    this.validate(graph, name);
    if (p.enabled) this.checkReady(id, graph);
    this.db.prepare('UPDATE workflows SET name = ?, enabled = ?, graph = ?, updated_at = ? WHERE id = ?').run(name.trim(), (p.enabled ?? !!r.enabled) ? 1 : 0, JSON.stringify(graph), this.now(), id);
    // Segreti e stato di blocchi eliminati non servono più
    const ids = graph.nodes.map((n) => n.id);
    for (const t of ['workflow_secrets', 'workflow_state']) {
      const rows = this.db.prepare(`SELECT DISTINCT node_id FROM ${t} WHERE workflow_id = ?`).all(id) as { node_id: string }[];
      for (const x of rows) if (!ids.includes(x.node_id)) this.db.prepare(`DELETE FROM ${t} WHERE workflow_id = ? AND node_id = ?`).run(id, x.node_id);
    }
    return this.get(id);
  }

  remove(id: string) {
    this.row(id);
    this.db.prepare('DELETE FROM workflows WHERE id = ?').run(id);
  }

  /** Prima di attivare: ogni webhook deve avere il suo token. */
  private checkReady(id: string, graph: Graph) {
    for (const n of graph.nodes) {
      if (n.type !== 'trigger.webhook') continue;
      const s = this.db.prepare('SELECT token_hash FROM workflow_secrets WHERE workflow_id = ? AND node_id = ?').get(id, n.id) as { token_hash: string | null } | undefined;
      if (!s?.token_hash) throw new WorkflowError(`Il webhook «${n.name}» non ha ancora un token: generalo prima di attivare il flusso`);
    }
  }

  validate(graph: Graph, name: string) {
    if (!name?.trim() || name.trim().length > 80) throw new WorkflowError('Nome del flusso: da 1 a 80 caratteri');
    if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new WorkflowError('Grafo non valido');
    if (graph.nodes.length > 100) throw new WorkflowError('Massimo 100 blocchi per flusso');
    if (graph.edges.length > 300) throw new WorkflowError('Massimo 300 collegamenti per flusso');
    if (JSON.stringify(graph).length > 400_000) throw new WorkflowError('Flusso troppo grande');
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const n of graph.nodes) {
      if (!ID.test(n.id ?? '')) throw new WorkflowError(`Id di blocco non valido: ${n.id}`);
      if (ids.has(n.id)) throw new WorkflowError(`Id di blocco ripetuto: ${n.id}`);
      ids.add(n.id);
      const def = NODE_BY_TYPE.get(n.type);
      if (!def) throw new WorkflowError(`Tipo di blocco sconosciuto: ${n.type}`);
      const nm = String(n.name ?? '').trim();
      if (!nm || nm.length > 60) throw new WorkflowError('Il nome di ogni blocco va da 1 a 60 caratteri');
      if (names.has(nm.toLowerCase())) throw new WorkflowError(`Due blocchi si chiamano «${nm}»: i nomi servono nelle espressioni, devono essere diversi`);
      names.add(nm.toLowerCase());
      if (!n.position || !Number.isFinite(n.position.x) || !Number.isFinite(n.position.y)) throw new WorkflowError(`Posizione non valida per «${nm}»`);
      n.config = this.checkConfig(def, n.config ?? {}, nm);
    }
    if (!graph.nodes.some((n) => NODE_BY_TYPE.get(n.type)!.category === 'trigger')) throw new WorkflowError('Serve almeno un blocco di ricezione (da dove parte il flusso)');
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const eids = new Set<string>();
    for (const e of graph.edges) {
      if (!ID.test(e.id ?? '') || eids.has(e.id)) throw new WorkflowError('Collegamento con id non valido o ripetuto');
      eids.add(e.id);
      const s = byId.get(e.source);
      const t = byId.get(e.target);
      if (!s || !t) throw new WorkflowError('Collegamento verso un blocco inesistente');
      if (e.source === e.target) throw new WorkflowError(`«${s.name}» è collegato a sé stesso`);
      if (NODE_BY_TYPE.get(t.type)!.category === 'trigger') throw new WorkflowError(`«${t.name}» è un blocco di ricezione: non può avere ingressi`);
      if (!outputsOf(NODE_BY_TYPE.get(s.type)!, s.config).some((o) => o.id === e.port)) throw new WorkflowError(`Uscita «${e.port}» inesistente in «${s.name}»`);
    }
    // Niente cicli: un flusso infinito non deve essere possibile
    const out = new Map<string, string[]>();
    for (const e of graph.edges) out.set(e.source, [...(out.get(e.source) ?? []), e.target]);
    const state = new Map<string, 1 | 2>();
    const visit = (id: string): void => {
      if (state.get(id) === 2) return;
      if (state.get(id) === 1) throw new WorkflowError(`Il flusso contiene un ciclo (passa due volte da «${byId.get(id)!.name}»)`);
      state.set(id, 1);
      for (const t of out.get(id) ?? []) visit(t);
      state.set(id, 2);
    };
    for (const n of graph.nodes) visit(n.id);
  }

  private checkConfig(def: NodeDef, cfg: Json, nodeName: string): Json {
    if (typeof cfg !== 'object' || Array.isArray(cfg) || JSON.stringify(cfg).length > 50_000) throw new WorkflowError(`Configurazione non valida in «${nodeName}»`);
    const out: Json = {};
    const fail = (f: Field, why: string) => {
      throw new WorkflowError(`«${nodeName}» → ${f.label}: ${why}`);
    };
    const tmpl = (f: Field, v: unknown) => {
      const e = checkTemplate(v);
      if (e) fail(f, e);
    };
    for (const f of def.fields) {
      let v = cfg[f.key] ?? f.default;
      const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
      if (empty) {
        if (f.required) fail(f, 'obbligatorio');
        if (v !== undefined) out[f.key] = v;
        continue;
      }
      switch (f.kind) {
        case 'number': {
          const n = Number(v);
          if (!Number.isFinite(n)) fail(f, 'serve un numero');
          if (f.min !== undefined && n < f.min) fail(f, `minimo ${f.min}`);
          if (f.max !== undefined && n > f.max) fail(f, `massimo ${f.max}`);
          v = n;
          break;
        }
        case 'bool':
          v = v === true || v === 'true';
          break;
        case 'select':
          if (!f.options!.some((o) => o.value === v)) fail(f, 'valore non previsto');
          break;
        case 'multi':
        case 'channels':
          if (!Array.isArray(v) || v.length > 50 || v.some((x) => typeof x !== 'string')) fail(f, 'elenco non valido');
          if (f.kind === 'multi' && (v as string[]).some((x) => !f.options!.some((o) => o.value === x))) fail(f, 'valore non previsto');
          break;
        case 'rows': {
          if (!Array.isArray(v) || v.length > 30) fail(f, 'massimo 30 righe');
          v = (v as Json[]).map((r) => {
            const row: Json = {};
            for (const c of f.columns ?? []) {
              const x = r?.[c.key];
              if (x === undefined || x === null) continue;
              if (typeof x !== 'string' || x.length > 2000) fail(f, `colonna «${c.label}» non valida`);
              if (c.kind === 'select' && !c.options!.some((o) => o.value === x)) fail(f, `«${c.label}»: valore non previsto`);
              if (c.kind === 'expr') tmpl(f, x);
              row[c.key] = x;
            }
            return row;
          });
          break;
        }
        case 'json':
          if (typeof v !== 'string' || v.length > 20_000) fail(f, 'testo troppo lungo');
          try {
            JSON.parse(v as string);
          } catch {
            fail(f, 'JSON non valido');
          }
          break;
        default:
          if (typeof v !== 'string' || v.length > 5000) fail(f, 'testo non valido o troppo lungo');
          if (f.kind === 'expr' || f.kind === 'textarea') tmpl(f, v);
      }
      out[f.key] = v;
    }
    if (def.type === 'trigger.telegram' && !/^\/[a-z0-9_]{1,30}$/.test(String(out.command ?? ''))) throw new WorkflowError(`«${nodeName}»: il comando va scritto come /nome (minuscole, numeri, _)`);
    if (def.type === 'trigger.schedule') {
      if (['daily', 'weekly'].includes(String(out.mode)) && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(out.time ?? ''))) throw new WorkflowError(`«${nodeName}»: ora nel formato HH:MM`);
      if (out.mode === 'once' && Number.isNaN(Date.parse(String(out.at ?? '')))) throw new WorkflowError(`«${nodeName}»: data e ora non valide (es. 2026-12-24T20:30)`);
    }
    return out;
  }

  // ───────── segreti ─────────
  /** Nuovo token del webhook: restituito una volta sola, nel database resta l'hash. */
  newWebhookToken(wfId: string, nodeId: string) {
    const n = this.node(wfId, nodeId);
    if (n.type !== 'trigger.webhook') throw new WorkflowError('Non è un webhook');
    const token = `gwh_${randomBytes(24).toString('base64url')}`;
    this.db
      .prepare('INSERT INTO workflow_secrets (workflow_id, node_id, token_hash, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (workflow_id, node_id) DO UPDATE SET token_hash = excluded.token_hash, updated_at = excluded.updated_at')
      .run(wfId, nodeId, sha256(token), this.now());
    return token;
  }

  setSecret(wfId: string, nodeId: string, value: string | null) {
    const n = this.node(wfId, nodeId);
    if (NODE_BY_TYPE.get(n.type)?.secret !== 'user') throw new WorkflowError('Questo blocco non usa un token');
    const enc = value ? this.vault.encrypt(value, `workflow:${wfId}:${nodeId}`) : null;
    this.db
      .prepare('INSERT INTO workflow_secrets (workflow_id, node_id, secret_enc, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (workflow_id, node_id) DO UPDATE SET secret_enc = excluded.secret_enc, updated_at = excluded.updated_at')
      .run(wfId, nodeId, enc, this.now());
  }

  private secretOf(wfId: string, nodeId: string): string | null {
    const s = this.db.prepare('SELECT secret_enc FROM workflow_secrets WHERE workflow_id = ? AND node_id = ?').get(wfId, nodeId) as { secret_enc: string | null } | undefined;
    return s?.secret_enc ? this.vault.decrypt(s.secret_enc, `workflow:${wfId}:${nodeId}`) : null;
  }

  private node(wfId: string, nodeId: string) {
    const n = this.view(this.row(wfId)).graph.nodes.find((x) => x.id === nodeId);
    if (!n) throw new WorkflowError('Blocco non trovato (salva il flusso prima)', 404);
    return n;
  }

  // ───────── stato dei blocchi ─────────
  private stateGet(wfId: string, nodeId: string, key: string) {
    return (this.db.prepare('SELECT value FROM workflow_state WHERE workflow_id = ? AND node_id = ? AND key = ?').get(wfId, nodeId, key) as { value: string } | undefined)?.value ?? null;
  }
  private stateSet(wfId: string, nodeId: string, key: string, value: string) {
    this.db
      .prepare('INSERT INTO workflow_state (workflow_id, node_id, key, value, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (workflow_id, node_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(wfId, nodeId, key, value, this.now());
  }

  /** Ultimo evento ricevuto da un blocco di ricezione (per costruire le espressioni sui dati veri) */
  sample(wfId: string, nodeId: string) {
    return parse<unknown>(this.stateGet(wfId, nodeId, 'sample'), null);
  }

  // ───────── ricezione ─────────
  /** Chiamata esterna a un webhook. Il token si confronta in tempo costante con l'hash salvato. */
  async webhook(wfId: string, nodeId: string, token: string | null, data: Json) {
    if (!ID.test(wfId) || !ID.test(nodeId)) throw new WorkflowError('Non trovato', 404);
    const s = this.db.prepare('SELECT token_hash FROM workflow_secrets WHERE workflow_id = ? AND node_id = ?').get(wfId, nodeId) as { token_hash: string | null } | undefined;
    const ok = !!token && !!s?.token_hash && timingSafeEqual(Buffer.from(sha256(token)), Buffer.from(s.token_hash));
    if (!ok) throw new WorkflowError('Token mancante o non valido', 401);
    const r = this.row(wfId);
    const n = this.view(r).graph.nodes.find((x) => x.id === nodeId && x.type === 'trigger.webhook');
    if (!n) throw new WorkflowError('Non trovato', 404);
    // Il campione si salva anche con il flusso spento: serve a preparare le espressioni
    this.stateSet(wfId, nodeId, 'sample', clip(data, 32_000).endsWith('…') ? JSON.stringify({ truncated: true }) : JSON.stringify(data));
    if (!r.enabled) return { accepted: false as const, reason: 'Flusso spento: evento salvato come esempio' };
    const runId = this.start(wfId, n, data);
    return { accepted: true as const, runId, respond: n.config.respond };
  }

  /** Eventi di GIGI OS (Events.onAdd). Gli eventi scritti dai flussi stessi non fanno ripartire nulla. */
  onEvent(e: { level: string; source: string; title: string; details?: string | null }) {
    if (this.emitting) return;
    const rank = { info: 0, warning: 1, error: 2 } as Record<string, number>;
    for (const wf of this.enabled()) {
      for (const n of wf.graph.nodes.filter((x) => x.type === 'trigger.event')) {
        const src = (n.config.sources as string[] | undefined) ?? [];
        if (src.length && !src.includes(e.source)) continue;
        if ((rank[e.level] ?? 0) < (rank[String(n.config.minLevel ?? 'info')] ?? 0)) continue;
        const m = String(n.config.match ?? '').trim().toLowerCase();
        if (m && !e.title.toLowerCase().includes(m)) continue;
        this.start(wf.id, n, { level: e.level, source: e.source, title: e.title, details: e.details ?? null, at: this.now() });
      }
    }
  }

  /** Comando del bot Telegram (account collegati, operatori o admin): restituisce i flussi avviati. */
  telegramCommand(command: string, text: string, who: { username: string; role: string }) {
    const started: string[] = [];
    const args = text.trim().split(/\s+/).slice(1).join(' ');
    for (const wf of this.enabled()) {
      for (const n of wf.graph.nodes.filter((x) => x.type === 'trigger.telegram' && x.config.command === command)) {
        this.start(wf.id, n, { command, args, text, user: who.username, role: who.role, at: this.now() });
        started.push(wf.name);
      }
    }
    return started;
  }

  /** «Esegui» dall'editor: dal blocco indicato (o dal primo di ricezione) con i dati indicati o quelli di prova. */
  manual(wfId: string, nodeId: string | undefined, data: Json | undefined) {
    const wf = this.view(this.row(wfId));
    const n = nodeId ? wf.graph.nodes.find((x) => x.id === nodeId) : wf.graph.nodes.find((x) => x.type === 'trigger.manual') ?? wf.graph.nodes.find((x) => NODE_BY_TYPE.get(x.type)?.category === 'trigger');
    if (!n || NODE_BY_TYPE.get(n.type)?.category !== 'trigger') throw new WorkflowError('Scegli un blocco di ricezione da cui partire');
    const input = data ?? (n.type === 'trigger.manual' ? parse<Json>(String(n.config.sample ?? '{}'), {}) : (this.sample(wfId, n.id) as Json | null) ?? {});
    const id = this.start(wfId, n, input, true);
    if (!id) throw new WorkflowError('Troppe esecuzioni di questo flusso negli ultimi minuti', 429);
    return id;
  }

  private enabled() {
    return (this.db.prepare('SELECT * FROM workflows WHERE enabled = 1').all() as WfRow[]).map((r) => this.view(r));
  }

  // ───────── esecuzione ─────────
  /** Nuova esecuzione. Limite per flusso (60 ogni 10 minuti) contro i flussi che si richiamano a vicenda. */
  start(wfId: string, trigger: WfNode, data: Json, manual = false): string | null {
    const now = this.now();
    const times = (this.recent.get(wfId) ?? []).filter((t) => now - t < RATE.windowMs);
    if (times.length >= RATE.runs) {
      if (times.length === RATE.runs) this.emit('warning', `Flusso «${this.row(wfId).name}» fermato: troppe esecuzioni in 10 minuti`, 'Controlla che non si richiami da solo');
      times.push(now);
      this.recent.set(wfId, times);
      return null;
    }
    times.push(now);
    this.recent.set(wfId, times);
    const id = newId();
    const context = { __trigger: data, [trigger.name]: data };
    this.db
      .prepare("INSERT INTO workflow_runs (id, workflow_id, trigger, status, context, started_at) VALUES (?, ?, ?, 'running', ?, ?)")
      .run(id, wfId, manual ? `${trigger.name} (manuale)` : trigger.name, JSON.stringify(context), now);
    this.step(id, trigger, 'ok', 'out', null, data, null, now);
    void this.schedule(() => this.continue(id, this.next(wfId, trigger.id, 'out', data)));
    return id;
  }

  /** Coda con al massimo MAX_CONCURRENT esecuzioni contemporanee */
  private schedule(fn: () => Promise<void>) {
    return new Promise<void>((resolve) => {
      const go = () => {
        this.running++;
        fn()
          .catch((e) => this.deps.log('flusso: errore inatteso', { err: (e as Error).message }))
          .finally(() => {
            this.running--;
            this.queue.shift()?.();
            resolve();
          });
      };
      if (this.running < MAX_CONCURRENT) go();
      else this.queue.push(go);
    });
  }

  private next(wfId: string, nodeId: string, port: string, json: Json) {
    const g = this.view(this.row(wfId)).graph;
    return g.edges.filter((e) => e.source === nodeId && e.port === port).map((e) => ({ nodeId: e.target, json }));
  }

  private step(runId: string, node: WfNode, status: string, port: string | null, input: unknown, output: unknown, error: string | null, startedAt: number) {
    this.db
      .prepare('INSERT INTO workflow_steps (run_id, node_id, node_name, status, port, input, output, error, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(runId, node.id, node.name, status, port, input === null ? null : clip(input), output === null ? null : clip(output), error, startedAt, this.now());
  }

  /** Esegue i blocchi in coda fino alla fine, a un'attesa o a un errore. */
  private async continue(runId: string, queue: { nodeId: string; json: Json }[]) {
    const run = this.db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(runId) as RunRow | undefined;
    if (!run || run.status === 'cancelled') return;
    this.db.prepare("UPDATE workflow_runs SET status = 'running' WHERE id = ?").run(runId);
    const wfRow = this.db.prepare('SELECT * FROM workflows WHERE id = ?').get(run.workflow_id) as WfRow | undefined;
    if (!wfRow) return;
    const wf = this.view(wfRow);
    const ctx = parse<Json>(run.context, {});
    let steps = (this.db.prepare('SELECT COUNT(*) AS n FROM workflow_steps WHERE run_id = ?').get(runId) as { n: number }).n;
    const fail = (msg: string) => {
      this.db.prepare("UPDATE workflow_runs SET status = 'error', error = ?, context = ?, finished_at = ? WHERE id = ?").run(msg.slice(0, 1000), clip(ctx, 300_000), this.now(), runId);
      this.emit('warning', `Flusso «${wf.name}» non riuscito`, msg.slice(0, 500));
    };
    while (queue.length) {
      const cur = this.db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string };
      if (cur.status === 'cancelled') return;
      const { nodeId, json } = queue.shift()!;
      const node = wf.graph.nodes.find((n) => n.id === nodeId);
      const def = node && NODE_BY_TYPE.get(node.type);
      if (!node || !def?.run) return fail('Un blocco del flusso è stato rimosso o non è eseguibile');
      if (++steps > MAX_STEPS) return fail(`Superato il limite di ${MAX_STEPS} passi`);
      const t0 = this.now();
      let result: Result;
      try {
        result = await def.run(this.runCtx(wf, node, json, ctx));
      } catch (e) {
        const msg = (e as Error).message || String(e);
        this.step(runId, node, 'error', null, json, null, msg.slice(0, 2000), t0);
        return fail(`${node.name}: ${msg}`);
      }
      if ('wait' in result || 'approval' in result) {
        const waitId = newId();
        const insert = this.db.prepare('INSERT INTO workflow_waits (id, run_id, node_id, kind, resume_at, input, options, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
        if ('wait' in result) {
          insert.run(waitId, runId, node.id, 'timer', result.wait.until, JSON.stringify(result.json), null, null, this.now());
          this.step(runId, node, 'waiting', null, json, { until: new Date(result.wait.until).toISOString() }, null, t0);
        } else {
          const ap = result.approval;
          const expiresAt = this.now() + ap.timeoutMs;
          insert.run(waitId, runId, node.id, 'approval', expiresAt, JSON.stringify(result.json), JSON.stringify(ap.options), ap.message, this.now());
          this.step(runId, node, 'waiting', null, json, { message: ap.message, options: ap.options.map((o) => o.label) }, null, t0);
          const a: Approval = { waitId, workflow: wf.name, message: ap.message, options: ap.options.map((o) => ({ label: o.label })), expiresAt };
          this.emit('info', `Flusso «${wf.name}»: serve una conferma`, ap.message.slice(0, 300));
          void this.approvalSender?.(a).catch((e: Error) => this.deps.log('flusso: richiesta di conferma non inviata', { err: e.message }));
        }
        continue;
      }
      ctx[node.name] = result.json;
      this.db.prepare('UPDATE workflow_runs SET context = ? WHERE id = ?').run(clip(ctx, 300_000), runId);
      this.step(runId, node, 'ok', result.port, json, result.json, null, t0);
      queue.push(...this.next(wf.id, node.id, result.port, result.json));
    }
    const waiting = (this.db.prepare('SELECT COUNT(*) AS n FROM workflow_waits WHERE run_id = ?').get(runId) as { n: number }).n;
    this.db.prepare('UPDATE workflow_runs SET status = ?, finished_at = ? WHERE id = ?').run(waiting ? 'waiting' : 'success', waiting ? null : this.now(), runId);
  }

  private runCtx(wf: { id: string; name: string }, node: WfNode, json: Json, ctx: Json): RunCtx {
    const scope: Scope = { json, trigger: ctx.__trigger ?? null, node: ctx, now: this.now() };
    return {
      json,
      scope,
      config: node.config,
      get: (k) => render(node.config[k], scope),
      text: (k) => renderText(node.config[k], scope),
      deps: { ...this.deps, event: (l, t, d) => this.emit(l, t, d) },
      workflow: { id: wf.id, name: wf.name },
      nodeName: node.name,
      secret: this.secretOf(wf.id, node.id),
      state: { get: (k) => this.stateGet(wf.id, node.id, k), set: (k, v) => this.stateSet(wf.id, node.id, k, v) },
    };
  }

  /** Eventi scritti dai flussi: origine «automazioni», senza far ripartire i flussi a eventi */
  private emit(level: 'info' | 'warning' | 'error', title: string, details?: string | null) {
    this.emitting = true;
    try {
      this.deps.event(level, title, details);
    } finally {
      this.emitting = false;
    }
  }

  // ───────── attese e approvazioni ─────────
  private async resume(w: WaitRow, port: string, extra: Json = {}) {
    // Una riga alla volta: chi la cancella per primo riprende il flusso (doppio clic, Telegram + interfaccia)
    if (!this.db.prepare('DELETE FROM workflow_waits WHERE id = ?').run(w.id).changes) return false;
    const run = this.db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(w.run_id) as RunRow | undefined;
    if (!run || run.status === 'cancelled') return false;
    const wf = this.view(this.row(run.workflow_id));
    const node = wf.graph.nodes.find((n) => n.id === w.node_id);
    const json = { ...parse<Json>(w.input, {}), ...extra };
    if (!node) {
      this.db.prepare("UPDATE workflow_runs SET status = 'error', error = 'Blocco rimosso durante l’attesa', finished_at = ? WHERE id = ?").run(this.now(), run.id);
      return true;
    }
    const ctx = parse<Json>(run.context, {});
    ctx[node.name] = json;
    this.db.prepare('UPDATE workflow_runs SET context = ? WHERE id = ?').run(clip(ctx, 300_000), run.id);
    this.step(run.id, node, 'ok', port, null, json, null, this.now());
    await this.schedule(() => this.continue(run.id, this.next(wf.id, node.id, port, json)));
    return true;
  }

  pendingApprovals() {
    const rows = this.db
      .prepare("SELECT w.*, r.workflow_id, f.name AS wf_name FROM workflow_waits w JOIN workflow_runs r ON r.id = w.run_id JOIN workflows f ON f.id = r.workflow_id WHERE w.kind = 'approval' ORDER BY w.created_at")
      .all() as (WaitRow & { workflow_id: string; wf_name: string })[];
    return rows.map((w) => ({
      id: w.id,
      runId: w.run_id,
      workflowId: w.workflow_id,
      workflow: w.wf_name,
      message: w.message ?? '',
      options: parse<{ label: string }[]>(w.options, []).map((o) => o.label),
      createdAt: w.created_at,
      expiresAt: w.resume_at,
    }));
  }

  /** Risposta a una richiesta di conferma: indice dell'opzione, oppure null = rifiuto. */
  async decide(waitId: string, choice: number | null, by: string) {
    const w = this.db.prepare("SELECT * FROM workflow_waits WHERE id = ? AND kind = 'approval'").get(waitId) as WaitRow | undefined;
    if (!w) throw new WorkflowError('Richiesta già gestita o scaduta', 404);
    const options = parse<{ label: string; value: unknown }[]>(w.options, []);
    if (choice !== null && !options[choice]) throw new WorkflowError('Opzione non valida');
    const extra = choice === null ? { approval: { by, approved: false } } : { approval: { by, approved: true, index: choice, label: options[choice].label, value: options[choice].value } };
    if (!(await this.resume(w, choice === null ? 'rejected' : 'approved', extra))) throw new WorkflowError('Richiesta già gestita', 409);
    return { ok: true, choice: choice === null ? null : options[choice].label };
  }

  // ───────── storico ─────────
  runs(wfId: string, limit = 50) {
    return (this.db.prepare('SELECT id, trigger, status, error, started_at, finished_at FROM workflow_runs WHERE workflow_id = ? ORDER BY started_at DESC LIMIT ?').all(wfId, Math.min(limit, 200)) as Omit<RunRow, 'context' | 'workflow_id'>[]).map((r) => ({
      id: r.id,
      trigger: r.trigger,
      status: r.status,
      error: r.error,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
    }));
  }

  run(runId: string) {
    const r = this.db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(runId) as RunRow | undefined;
    if (!r) throw new WorkflowError('Esecuzione non trovata', 404);
    const steps = this.db.prepare('SELECT * FROM workflow_steps WHERE run_id = ? ORDER BY id').all(runId) as {
      node_id: string;
      node_name: string;
      status: string;
      port: string | null;
      input: string | null;
      output: string | null;
      error: string | null;
      started_at: number;
      finished_at: number | null;
    }[];
    return {
      id: r.id,
      workflowId: r.workflow_id,
      trigger: r.trigger,
      status: r.status,
      error: r.error,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      steps: steps.map((s) => ({ nodeId: s.node_id, name: s.node_name, status: s.status, port: s.port, input: s.input, output: s.output, error: s.error, startedAt: s.started_at, finishedAt: s.finished_at })),
    };
  }

  cancel(runId: string) {
    const r = this.db.prepare("UPDATE workflow_runs SET status = 'cancelled', finished_at = ? WHERE id = ? AND status IN ('running', 'waiting')").run(this.now(), runId);
    this.db.prepare('DELETE FROM workflow_waits WHERE run_id = ?').run(runId);
    if (!r.changes) throw new WorkflowError('Esecuzione già conclusa', 409);
  }

  // ───────── pianificazione ─────────
  startScheduler(intervalMs = 15_000) {
    this.timer = setInterval(() => void this.tick().catch((e: Error) => this.deps.log('flussi: controllo non riuscito', { err: e.message })), intervalMs);
    this.timer.unref?.();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Un giro: attese scadute, conferme scadute, pianificazioni e polling dovuti, pulizia dello storico. */
  async tick() {
    const now = this.now();
    for (const w of this.db.prepare("SELECT * FROM workflow_waits WHERE kind = 'timer' AND resume_at <= ?").all(now) as WaitRow[]) await this.resume(w, 'out');
    for (const w of this.db.prepare("SELECT * FROM workflow_waits WHERE kind = 'approval' AND resume_at <= ?").all(now) as WaitRow[]) await this.resume(w, 'timeout', { approval: { approved: false, expired: true } });
    for (const wf of this.enabled()) {
      for (const n of wf.graph.nodes) {
        const def = NODE_BY_TYPE.get(n.type);
        if (n.type === 'trigger.schedule') this.checkSchedule(wf, n, now);
        else if (def?.poll) void this.checkPoll(wf, n, def, now);
      }
    }
    // Storico: 30 giorni e al massimo 200 esecuzioni per flusso (mai quelle in attesa)
    this.db.prepare("DELETE FROM workflow_runs WHERE started_at < ? AND status NOT IN ('running', 'waiting')").run(now - 30 * 86_400_000);
    this.db
      .prepare(
        "DELETE FROM workflow_runs WHERE status NOT IN ('running', 'waiting') AND id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY workflow_id ORDER BY started_at DESC) AS rn FROM workflow_runs) WHERE rn > 200)",
      )
      .run();
  }

  /** Prossima scadenza di una pianificazione giornaliera/settimanale dopo `from` (ora locale). */
  static nextAt(cfg: Json, from: number): number | null {
    if (cfg.mode === 'interval') return from + Math.max(1, Number(cfg.minutes ?? 60)) * 60_000;
    if (cfg.mode === 'once') {
      const t = Date.parse(String(cfg.at ?? ''));
      return Number.isNaN(t) || t <= from ? null : t;
    }
    const [h, m] = String(cfg.time ?? '08:00').split(':').map(Number);
    const days = cfg.mode === 'weekly' ? ((cfg.days as string[] | undefined) ?? []).map(Number) : [0, 1, 2, 3, 4, 5, 6];
    if (!days.length) return null;
    const d = new Date(from);
    for (let i = 0; i < 8; i++) {
      const c = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, h, m, 0, 0);
      if (c.getTime() > from && days.includes(c.getDay())) return c.getTime();
    }
    return null;
  }

  private checkSchedule(wf: { id: string; graph: Graph }, n: WfNode, now: number) {
    const sig = JSON.stringify([n.config.mode, n.config.minutes, n.config.time, n.config.days, n.config.at]);
    // Pianificazione nuova o cambiata: si riparte da adesso, senza recuperare le scadenze passate
    if (this.stateGet(wf.id, n.id, 'sig') !== sig) {
      this.stateSet(wf.id, n.id, 'sig', sig);
      this.stateSet(wf.id, n.id, 'next', String(n.config.mode === 'once' ? 0 : Workflows.nextAt(n.config, now) ?? 0));
      this.stateSet(wf.id, n.id, 'fired', '');
    }
    if (n.config.mode === 'once') {
      const at = Date.parse(String(n.config.at ?? ''));
      if (this.stateGet(wf.id, n.id, 'fired') || Number.isNaN(at) || now < at) return;
      this.stateSet(wf.id, n.id, 'fired', String(now));
      // Oltre 15 minuti di ritardo (GIGI OS spento all'ora indicata) non parte più
      if (now - at <= 15 * 60_000) this.start(wf.id, n, { scheduledAt: new Date(at).toISOString(), at: now });
      return;
    }
    const due = Number(this.stateGet(wf.id, n.id, 'next') ?? 0);
    if (!due || now < due) return;
    this.stateSet(wf.id, n.id, 'next', String(Workflows.nextAt(n.config, now) ?? 0));
    this.start(wf.id, n, { scheduledAt: new Date(due).toISOString(), at: now });
  }

  private async checkPoll(wf: { id: string; name: string }, n: WfNode, def: NodeDef, now: number) {
    const key = `${wf.id}:${n.id}`;
    if (this.polling.has(key)) return;
    const due = Number(this.stateGet(wf.id, n.id, 'next') ?? 0);
    if (now < due) return;
    this.polling.add(key);
    this.stateSet(wf.id, n.id, 'next', String(now + (def.every?.(n.config) ?? 15 * 60_000)));
    try {
      const items = await def.poll!(this.runCtx(wf, n, {}, {}));
      const seenRaw = this.stateGet(wf.id, n.id, 'seen');
      const seen = new Set(parse<string[]>(seenRaw, []));
      const fresh = items.filter((i) => !seen.has(i.id));
      // Primo controllo: con «ignora quelli già presenti» si ricorda tutto senza partire
      const silent = seenRaw === null && n.config.skipExisting !== false;
      if (!silent) for (const i of fresh.slice(0, 20)) this.start(wf.id, n, { ...i.json, __id: i.id });
      const all = [...fresh.map((i) => i.id), ...seen].slice(0, 1000);
      this.stateSet(wf.id, n.id, 'seen', JSON.stringify(all));
      this.stateSet(wf.id, n.id, 'error', '');
      if (fresh.length) this.stateSet(wf.id, n.id, 'sample', clip(fresh[0].json, 32_000).endsWith('…') ? '{"truncated":true}' : JSON.stringify(fresh[0].json));
    } catch (e) {
      const msg = (e as Error).message.slice(0, 300);
      if (this.stateGet(wf.id, n.id, 'error') !== msg) this.emit('warning', `Flusso «${wf.name}»: «${n.name}» non riesce a leggere`, msg);
      this.stateSet(wf.id, n.id, 'error', msg);
    } finally {
      this.polling.delete(key);
    }
  }

  /** Stato dei blocchi di ricezione a intervalli (ultimo errore, prossimo controllo) per l'editor */
  triggerStatus(wfId: string) {
    const wf = this.view(this.row(wfId));
    return Object.fromEntries(
      wf.graph.nodes
        .filter((n) => NODE_BY_TYPE.get(n.type)?.category === 'trigger')
        .map((n) => [n.id, { next: Number(this.stateGet(wfId, n.id, 'next') ?? 0) || null, error: this.stateGet(wfId, n.id, 'error') || null, hasSample: this.stateGet(wfId, n.id, 'sample') !== null }]),
    );
  }
}
