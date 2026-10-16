// Operazioni Docker distruttive (D-024) e stack compose creati dal wizard (D-025).
// Tutto riservato agli admin, con conferma scritta e audit; l'agent ripete i controlli.
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AgentClient } from './agent.js';
import type { Events } from './events.js';
import type { Audit, SessionUser } from './security.js';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:@-]{0,199}$/;
const PROJECT = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const KINDS = { image: 'images', volume: 'volumes', network: 'networks', container: 'containers' } as const;
const KIND_LABEL = { image: 'immagine', volume: 'volume', network: 'rete', container: 'container' } as const;

type Finding = { level: 'error' | 'danger' | 'warn' | 'info'; service?: string; message: string };
type Preflight = { ok: boolean; needsConfirm: boolean; dir: string; update: boolean; findings: Finding[]; envKeys: string[] };

const stackInput = z.object({
  root: z.string().min(1).max(64),
  path: z.string().min(1).max(200),
  project: z.string().regex(PROJECT, 'Nome stack non valido: minuscole, numeri, - e _'),
  compose: z.string().min(1).max(200_000),
  // null = mantieni il valore già salvato (i valori del .env non tornano mai al browser)
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), z.string().max(8192).nullable()).optional(),
});

export function registerStacks(app: FastifyInstance, agent: AgentClient, audit: Audit, events: Events, viewer: object, admin: object) {
  const who = (req: FastifyRequest) => (req.user as SessionUser).username;

  // ───────────── Spazio e pulizia ─────────────
  app.get('/api/v1/docker/df', viewer, async () => agent.json('GET', '/v1/docker/df', 60_000));

  app.post('/api/v1/docker/cleanup', admin, async (req, reply) => {
    const body = z
      .object({ kind: z.enum(['image', 'volume', 'network', 'container']), ids: z.array(z.string().regex(ID)).min(1).max(100), confirm: z.string().max(32) })
      .parse(req.body);
    if (body.confirm !== 'ELIMINA') return reply.code(400).send({ error: 'Conferma richiesta: scrivi ELIMINA' });
    const results: { id: string; ok: boolean; error?: string; detail?: unknown }[] = [];
    for (const id of [...new Set(body.ids)]) {
      try {
        const r = await agent.json('DELETE', `/v1/${KINDS[body.kind]}/${encodeURIComponent(id)}`, 120_000);
        audit.log(req, `docker.remove.${body.kind}`, 'ok', id, r);
        results.push({ id, ok: true, detail: r });
      } catch (e) {
        const msg = (e as Error).message;
        audit.log(req, `docker.remove.${body.kind}`, (e as { status?: number }).status === 403 ? 'denied' : 'error', id, { err: msg });
        results.push({ id, ok: false, error: msg });
      }
    }
    const ok = results.filter((r) => r.ok).length;
    if (ok) events.add('info', 'docker', `${who(req)} ha eliminato ${ok} ${KIND_LABEL[body.kind]}${ok > 1 ? ' (in blocco)' : ''}`);
    return { ok, failed: results.length - ok, results };
  });

  app.post('/api/v1/docker/build-cache/prune', admin, async (req, reply) => {
    const body = z.object({ confirm: z.string().max(32) }).parse(req.body);
    if (body.confirm !== 'SVUOTA') return reply.code(400).send({ error: 'Conferma richiesta: scrivi SVUOTA' });
    const r = await agent.json<{ reclaimed: number }>('POST', '/v1/docker/build-cache/prune', 300_000);
    audit.log(req, 'docker.prune.build-cache', 'ok', null, r);
    events.add('info', 'docker', `${who(req)} ha svuotato la cache di build`);
    return r;
  });

  // ───────────── Stack ─────────────
  app.get('/api/v1/stacks', viewer, async () => agent.json('GET', '/v1/stacks', 30_000));
  app.get('/api/v1/stacks/roots', admin, async () => agent.json('GET', '/v1/stacks/roots'));
  app.get('/api/v1/stacks/browse', admin, async (req) => {
    const q = z.object({ root: z.string().max(64), path: z.string().max(200).default('') }).parse(req.query);
    return agent.json('GET', `/v1/stacks/browse?${new URLSearchParams(q)}`);
  });
  app.get('/api/v1/stacks/jobs/:id', admin, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/.test(id)) return reply.code(400).send({ error: 'id non valido' });
    return agent.json('GET', `/v1/stacks/jobs/${id}`);
  });
  app.get('/api/v1/stacks/:project', admin, async (req, reply) => {
    const { project } = req.params as { project: string };
    if (!PROJECT.test(project)) return reply.code(400).send({ error: 'Nome stack non valido' });
    return agent.json('GET', `/v1/stacks/${project}`);
  });

  app.post('/api/v1/stacks/preflight', admin, async (req) => agent.json('POST', '/v1/stacks/preflight', 60_000, stackInput.parse(req.body)));

  app.post('/api/v1/stacks/deploy', admin, async (req, reply) => {
    const body = stackInput.extend({ pull: z.enum(['missing', 'always']).default('missing'), confirm: z.string().max(64).optional() }).parse(req.body);
    const { confirm, pull, ...input } = body;
    const pf = await agent.json<Preflight>('POST', '/v1/stacks/preflight', 60_000, input);
    const details = {
      dir: pf.dir,
      update: pf.update,
      compose: createHash('sha256').update(input.compose).digest('hex').slice(0, 16),
      findings: pf.findings.filter((f) => f.level !== 'info').map((f) => `${f.level}: ${f.service ? `${f.service}: ` : ''}${f.message}`).slice(0, 20),
    };
    if (!pf.ok) {
      audit.log(req, pf.update ? 'stack.update' : 'stack.create', 'denied', input.project, { ...details, reason: 'errori bloccanti' });
      return reply.code(409).send({ error: 'Il compose ha errori bloccanti', findings: pf.findings });
    }
    if (pf.needsConfirm && confirm !== input.project)
      return reply.code(400).send({ error: `Ci sono avvisi: per confermare scrivi il nome dello stack (${input.project})`, findings: pf.findings });
    try {
      const r = await agent.json('POST', '/v1/stacks/deploy', 60_000, { ...input, pull, user: who(req) });
      audit.log(req, pf.update ? 'stack.update' : 'stack.create', 'ok', input.project, details);
      events.add('info', 'docker', `${who(req)} ha ${pf.update ? 'aggiornato' : 'creato'} lo stack ${input.project}`, pf.dir);
      return r;
    } catch (e) {
      audit.log(req, pf.update ? 'stack.update' : 'stack.create', 'error', input.project, { ...details, err: (e as Error).message });
      throw e;
    }
  });

  app.post('/api/v1/stacks/:project/actions', admin, async (req, reply) => {
    const { project } = req.params as { project: string };
    if (!PROJECT.test(project)) return reply.code(400).send({ error: 'Nome stack non valido' });
    const body = z
      .object({
        action: z.enum(['up', 'stop', 'restart', 'pull', 'down', 'remove', 'rollback']),
        confirm: z.string().max(64).optional(),
        removeVolumes: z.boolean().default(false),
        volumesConfirm: z.string().max(32).optional(),
      })
      .parse(req.body);
    const destructive = body.action !== 'up' && body.action !== 'pull';
    if (destructive && body.confirm !== project) return reply.code(400).send({ error: `Conferma richiesta: digita il nome dello stack (${project})` });
    const removeVolumes = (body.action === 'down' || body.action === 'remove') && body.removeVolumes;
    if (removeVolumes && body.volumesConfirm !== 'ELIMINA') return reply.code(400).send({ error: 'Eliminare i volumi richiede di scrivere ELIMINA' });
    try {
      const r = await agent.json('POST', `/v1/stacks/${project}/${body.action}`, 60_000, { removeVolumes });
      audit.log(req, `stack.${body.action}`, 'ok', project, { removeVolumes });
      events.add(destructive ? 'warning' : 'info', 'docker', `Stack ${project}: ${body.action}${removeVolumes ? ' con volumi' : ''} richiesto da ${who(req)}`);
      return r;
    } catch (e) {
      audit.log(req, `stack.${body.action}`, 'error', project, { err: (e as Error).message });
      throw e;
    }
  });
}
