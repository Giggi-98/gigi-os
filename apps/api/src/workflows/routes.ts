// Route dei flussi (D-041). Editor, storico e segreti solo admin; le conferme anche agli operatori.
// Il webhook è l'unica route senza sessione: richiede il token del blocco (Authorization: Bearer), mai nell'URL.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Audit, SessionUser } from '../security.js';
import { Workflows, WorkflowError, type Graph } from './engine.js';
import { NODES } from './nodes.js';

const ID = /^[A-Za-z0-9_-]{1,40}$/;
const who = (req: FastifyRequest) => (req.user as SessionUser).username;

const graphSchema = z.object({
  nodes: z
    .array(
      z.object({
        id: z.string().max(40),
        type: z.string().max(60),
        name: z.string().max(60),
        config: z.record(z.unknown()).default({}),
        position: z.object({ x: z.number(), y: z.number() }),
      }),
    )
    .max(100),
  edges: z.array(z.object({ id: z.string().max(40), source: z.string().max(40), port: z.string().max(40), target: z.string().max(40) })).max(300),
});

const n = (id: string, type: string, name: string, x: number, y: number, config: Record<string, unknown> = {}) => ({ id, type, name, config, position: { x, y } });
const e = (source: string, port: string, target: string) => ({ id: `${source}-${port}-${target}`, source, port, target });

/** Modelli pronti: si creano spenti e si adattano nell'editor. */
export const TEMPLATES: { id: string; name: string; description: string; graph: Graph }[] = [
  {
    id: 'borollo',
    name: 'Borollo: film confermato',
    description: 'La wishlist manda un webhook quando confermate un film per una data: se non è già in Jellyfin, pochi giorni prima lo cerca in italiano, ti chiede quale versione scaricare e lo mette in download.',
    graph: {
      nodes: [
        n('hook', 'trigger.webhook', 'Borollo', 0, 120),
        n('ok', 'logic.filter', 'Confermato?', 260, 120, { conditions: [{ left: '{{ trigger.body.status }}', op: 'eq', right: 'confermato' }], mode: 'all' }),
        n('set', 'logic.set', 'Dati del film', 520, 120, {
          fields: [
            { name: 'title', value: '{{ trigger.body.title }}' },
            { name: 'year', value: '{{ trigger.body.year }}' },
            { name: 'date', value: '{{ trigger.body.date }}' },
          ],
          keep: false,
        }),
        n('jf', 'action.jellyfin_find', 'Già in libreria?', 780, 120, { title: '{{ json.title }}', year: '{{ json.year }}' }),
        n('have', 'action.notify', 'Già disponibile', 1040, 0, { title: '🎬 {{ json.title }} è già in libreria', body: 'Pronto per il {{ json.date }}.', level: 'info' }),
        n('wait', 'logic.wait', 'Fino a 3 giorni prima', 1040, 220, { mode: 'until', until: '{{ json.date }}', offsetHours: 72 }),
        n('search', 'action.torrent_search', 'Cerca in italiano', 1300, 220, { query: '{{ json.title }} {{ json.year }} ITA', category: 'movies' }),
        n('none', 'action.notify', 'Nessun risultato', 1560, 380, { title: '🔎 Nessuna versione italiana di {{ json.title }}', body: 'Ricerca: {{ json.query }}. Riprova a mano dalla pagina Download.', level: 'warning' }),
        n('ask', 'logic.approval', 'Quale scarico?', 1560, 160, {
          message: '🎬 {{ json.title }} ({{ json.year }}) per il {{ json.date }}: quale versione scarico?',
          options: '{{ json.torrents }}',
          optionLabel: 'quality & " · " & $string(sizeGb) & " GB · " & $string(seeders) & " seed"',
          timeoutHours: 48,
        }),
        n('add', 'action.torrent_add', 'Scarica', 1820, 120, { url: '{{ json.approval.value.url }}', plugin: '{{ json.approval.value.plugin }}', category: 'Film' }),
        n('done', 'action.notify', 'In download', 2080, 120, { title: '⬇️ {{ json.title }} in download', body: 'Versione: {{ json.approval.label }}. Te lo segnalo quando è in libreria.', level: 'info' }),
      ],
      edges: [e('hook', 'out', 'ok'), e('ok', 'true', 'set'), e('set', 'out', 'jf'), e('jf', 'found', 'have'), e('jf', 'missing', 'wait'), e('wait', 'out', 'search'), e('search', 'found', 'ask'), e('search', 'none', 'none'), e('ask', 'approved', 'add'), e('add', 'out', 'done')],
    },
  },
  {
    id: 'telegram-film',
    name: '/film da Telegram',
    description: 'Scrivi al bot «/film Titolo anno»: cerca la versione italiana, ti propone le migliori e scarica quella che scegli.',
    graph: {
      nodes: [
        n('cmd', 'trigger.telegram', 'Comando /film', 0, 100, { command: '/film' }),
        n('set', 'logic.set', 'Titolo', 260, 100, { fields: [{ name: 'title', value: '{{ trigger.args }}' }], keep: false }),
        n('jf', 'action.jellyfin_find', 'Già in libreria?', 520, 100, { title: '{{ json.title }}' }),
        n('have', 'action.notify', 'C’è già', 780, 0, { title: '🎬 {{ json.title }} è già in libreria', body: '', level: 'info' }),
        n('search', 'action.torrent_search', 'Cerca in italiano', 780, 200, { query: '{{ json.title }} ITA', category: 'movies' }),
        n('ask', 'logic.approval', 'Quale scarico?', 1040, 140, { message: '🎬 {{ json.title }}: quale versione scarico?', options: '{{ json.torrents }}', optionLabel: 'quality & " · " & $string(sizeGb) & " GB · " & $string(seeders) & " seed"', timeoutHours: 12 }),
        n('none', 'action.notify', 'Nessun risultato', 1040, 320, { title: '🔎 Niente per {{ json.title }}', body: 'Ricerca: {{ json.query }}', level: 'warning' }),
        n('add', 'action.torrent_add', 'Scarica', 1300, 140, { url: '{{ json.approval.value.url }}', plugin: '{{ json.approval.value.plugin }}', category: 'Film' }),
        n('done', 'action.notify', 'In download', 1560, 140, { title: '⬇️ {{ json.title }} in download', body: '{{ json.approval.label }}', level: 'info' }),
      ],
      edges: [e('cmd', 'out', 'set'), e('set', 'out', 'jf'), e('jf', 'found', 'have'), e('jf', 'missing', 'search'), e('search', 'found', 'ask'), e('search', 'none', 'none'), e('ask', 'approved', 'add'), e('add', 'out', 'done')],
    },
  },
  {
    id: 'media-ready',
    name: 'Avvisami quando un titolo è pronto',
    description: 'Quando il motore media ha portato un titolo in Jellyfin (e quindi in Apollo), manda una notifica.',
    graph: {
      nodes: [
        n('ev', 'trigger.event', 'Nuovo in Jellyfin', 0, 80, { sources: ['media'], minLevel: 'info', match: 'Disponibile in Jellyfin' }),
        n('msg', 'action.notify', 'Notifica', 260, 80, { title: '🍿 {{ json.title }}', body: 'Pronto da guardare in Jellyfin e Apollo.', level: 'info' }),
      ],
      edges: [e('ev', 'out', 'msg')],
    },
  },
  {
    id: 'empty',
    name: 'Flusso vuoto',
    description: 'Parti da zero con un avvio manuale.',
    graph: { nodes: [n('start', 'trigger.manual', 'Avvio manuale', 0, 80)], edges: [] },
  },
];

/** Catalogo per l'editor: campi e uscite, senza codice. */
const catalog = () =>
  NODES.map((d) => ({
    type: d.type,
    category: d.category,
    label: d.label,
    description: d.description,
    icon: d.icon,
    fields: d.fields,
    outputs: d.outputs,
    dynamic: d.type === 'logic.switch' ? 'routes' : null,
    secret: d.secret ?? null,
    trigger: d.trigger ?? null,
  }));

export function registerWorkflows(app: FastifyInstance, wf: Workflows, audit: Audit, admin: object, operator: object) {
  const err = (e: unknown) => {
    if (e instanceof WorkflowError) throw Object.assign(new Error(e.message), { statusCode: e.statusCode });
    throw e;
  };
  const wrap =
    <T>(fn: (req: FastifyRequest) => T | Promise<T>) =>
    async (req: FastifyRequest) => {
      try {
        return await fn(req);
      } catch (e) {
        return err(e);
      }
    };
  const idOf = (req: FastifyRequest, k = 'id') => {
    const v = (req.params as Record<string, string>)[k];
    if (!ID.test(v ?? '')) throw new WorkflowError('id non valido');
    return v;
  };

  app.get('/api/v1/workflows/catalog', admin, async () => ({ nodes: catalog(), templates: TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description })) }));
  app.get('/api/v1/workflows', admin, wrap(() => wf.list()));
  app.post(
    '/api/v1/workflows',
    admin,
    wrap((req) => {
      const b = z.object({ name: z.string().max(80).optional(), template: z.string().max(40).optional(), graph: graphSchema.optional() }).parse(req.body);
      const t = TEMPLATES.find((x) => x.id === (b.template ?? 'empty'));
      if (!t && !b.graph) throw new WorkflowError('Modello sconosciuto');
      const graph = (b.graph as Graph | undefined) ?? (JSON.parse(JSON.stringify(t!.graph)) as Graph);
      const r = wf.create(b.name?.trim() || t?.name || 'Nuovo flusso', graph, who(req));
      audit.log(req, 'workflow.create', 'ok', r.name, { template: b.template ?? null });
      return r;
    }),
  );
  app.get('/api/v1/workflows/:id', admin, wrap((req) => ({ ...wf.get(idOf(req)), status: wf.triggerStatus(idOf(req)) })));
  app.put(
    '/api/v1/workflows/:id',
    admin,
    wrap((req) => {
      const b = z.object({ name: z.string().max(80).optional(), enabled: z.boolean().optional(), graph: graphSchema.optional() }).parse(req.body);
      const r = wf.update(idOf(req), { name: b.name, enabled: b.enabled, graph: b.graph as Graph | undefined });
      audit.log(req, 'workflow.update', 'ok', r.name, { enabled: r.enabled, blocchi: r.graph.nodes.length });
      return r;
    }),
  );
  app.delete(
    '/api/v1/workflows/:id',
    admin,
    wrap((req) => {
      const r = wf.get(idOf(req));
      wf.remove(r.id);
      audit.log(req, 'workflow.delete', 'ok', r.name);
      return { ok: true };
    }),
  );
  app.post(
    '/api/v1/workflows/:id/run',
    admin,
    wrap((req) => {
      const b = z.object({ nodeId: z.string().max(40).optional(), data: z.record(z.unknown()).optional() }).parse(req.body ?? {});
      const runId = wf.manual(idOf(req), b.nodeId, b.data);
      audit.log(req, 'workflow.run', 'ok', wf.get(idOf(req)).name);
      return { runId };
    }),
  );
  app.get('/api/v1/workflows/:id/runs', admin, wrap((req) => wf.runs(idOf(req))));
  app.get('/api/v1/workflow-runs/:id', admin, wrap((req) => wf.run(idOf(req))));
  app.post(
    '/api/v1/workflow-runs/:id/cancel',
    admin,
    wrap((req) => {
      wf.cancel(idOf(req));
      audit.log(req, 'workflow.cancel', 'ok', idOf(req));
      return { ok: true };
    }),
  );
  app.post(
    '/api/v1/workflows/:id/nodes/:node/token',
    admin,
    wrap((req) => {
      const token = wf.newWebhookToken(idOf(req), idOf(req, 'node'));
      audit.log(req, 'workflow.token', 'ok', `${idOf(req)}:${idOf(req, 'node')}`);
      return { token };
    }),
  );
  app.put(
    '/api/v1/workflows/:id/nodes/:node/secret',
    admin,
    wrap((req) => {
      const b = z.object({ value: z.string().max(2000).nullable() }).parse(req.body);
      wf.setSecret(idOf(req), idOf(req, 'node'), b.value?.trim() || null);
      audit.log(req, 'workflow.secret', 'ok', `${idOf(req)}:${idOf(req, 'node')}`, { impostato: !!b.value });
      return { ok: true };
    }),
  );
  app.get('/api/v1/workflows/:id/nodes/:node/sample', admin, wrap((req) => ({ sample: wf.sample(idOf(req), idOf(req, 'node')) })));

  app.get('/api/v1/workflow-approvals', operator, wrap(() => wf.pendingApprovals()));
  app.post(
    '/api/v1/workflow-approvals/:id',
    operator,
    wrap(async (req) => {
      const b = z.object({ choice: z.number().int().min(0).max(20).nullable() }).parse(req.body);
      const r = await wf.decide(idOf(req), b.choice, who(req));
      audit.log(req, 'workflow.approval', 'ok', idOf(req), { scelta: r.choice });
      return r;
    }),
  );

  // Webhook in entrata: niente sessione né CSRF (vedi app.ts), token obbligatorio, limite di frequenza
  const hook = async (req: FastifyRequest, reply: import('fastify').FastifyReply) => {
    const p = req.params as { wf: string; node: string };
    const auth = String(req.headers.authorization ?? '');
    const token = /^Bearer\s+(\S+)$/i.exec(auth)?.[1] ?? (typeof req.headers['x-gigi-token'] === 'string' ? req.headers['x-gigi-token'] : null);
    const keep = ['content-type', 'user-agent', 'x-github-event', 'x-request-id'];
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => keep.includes(k) || /^x-borollo-/.test(k)));
    try {
      const r = await wf.webhook(p.wf, p.node, token, { body: (req.body ?? null) as unknown, query: req.query as Record<string, unknown>, headers, method: req.method, receivedAt: new Date().toISOString() });
      if (!r.accepted) return reply.code(202).send({ ok: true, started: false, reason: r.reason });
      return reply.code(202).send(r.respond === 'id' ? { ok: true, started: !!r.runId, runId: r.runId } : { ok: true, started: !!r.runId });
    } catch (e) {
      if (e instanceof WorkflowError) return reply.code(e.statusCode).send({ error: e.message });
      throw e;
    }
  };
  const hookOpts = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };
  app.post('/api/v1/hooks/:wf/:node', hookOpts, hook);
  app.put('/api/v1/hooks/:wf/:node', hookOpts, hook);
}
