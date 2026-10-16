// Ponte API ↔ gigi-media: autorizzazione, audit e credenziali iniettate in memoria a ogni richiesta.
// Le mappature dei percorsi sono ricavate dai mount reali dei container (via agent), non configurate a mano.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AgentClient } from './agent.js';
import type { Events } from './events.js';
import type { Integrations } from './integrations.js';
import type { Audit, SessionUser } from './security.js';

type Mount = { type: string; source: string; destination: string };
type Creds = {
  qbt: { baseUrl: string; auth: 'apikey' | 'password'; secret: Record<string, string> } | null;
  jf: { baseUrl: string; apiKey: string } | null;
  qbtPathMap: { from: string; to: string }[];
  jfPathMap: { host: string; jf: string }[];
};

const ID = /^[0-9a-f]{20}$/;

export class MediaBridge {
  constructor(
    private media: AgentClient,
    private agent: AgentClient,
    private integrations: Integrations,
    private events: Events,
    private files?: AgentClient,
  ) {}

  /**
   * Elimina dalla libreria i file importati dagli elementi indicati (solo se sono lo stesso file del download),
   * notifica Jellyfin della rimozione e marca gli elementi come «rimossi».
   */
  private async purgeLibrary(items: { id: string; fileName: string; srcPath: string; status: string; plan: { dest: string; libraryRoot: string; subtitles?: { src: string; dest: string }[] } | null }[], actor: string) {
    if (!this.files) throw Object.assign(new Error('File manager non disponibile'), { statusCode: 503 });
    const roots = await this.files.json<{ id: string; path: string }[]>('GET', '/v1/roots');
    const creds = await this.creds();
    const removed: string[] = [];
    const skipped: { path: string; reason: string }[] = [];
    for (const it of items) {
      if (!it.plan || !['imported', 'indexed'].includes(it.status)) continue;
      const root = roots.find((r) => it.plan!.dest.startsWith(r.path + '/'));
      if (!root) {
        skipped.push({ path: it.plan.dest, reason: 'fuori dalle cartelle gestite' });
        continue;
      }
      const rel = (p: string) => p.slice(root.path.length + 1);
      const list = [{ path: rel(it.plan.dest), src: it.srcPath }, ...(it.plan.subtitles ?? []).map((s) => ({ path: rel(s.dest), src: s.src }))];
      const r = await this.files.json<{ removed: string[]; skipped: { path: string; reason: string }[] }>('POST', '/v1/purge', 60_000, {
        root: root.id,
        items: list,
        stopAt: rel(it.plan.libraryRoot),
      });
      skipped.push(...r.skipped);
      const full = r.removed.map((x) => `${root.path}/${x}`);
      removed.push(...full);
      if (creds.jf && full.length) {
        const jfPaths = full
          .map((p) => {
            const m = creds.jfPathMap.find((x) => p.startsWith(x.host + '/'));
            return m ? m.jf + p.slice(m.host.length) : null;
          })
          .filter((x): x is string => !!x);
        if (jfPaths.length) {
          await fetch(`${creds.jf.baseUrl}/Library/Media/Updated`, {
            method: 'POST',
            headers: {
              Authorization: `MediaBrowser Client="GIGI OS", Device="gigi-os", DeviceId="gigi-os", Version="0.2.0", Token="${creds.jf.apiKey}"`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ Updates: jfPaths.map((Path) => ({ Path, UpdateType: 'Deleted' })) }),
            signal: AbortSignal.timeout(10_000),
          }).catch(() => undefined);
        }
      }
      if (r.removed.length || !r.skipped.length) {
        await this.media.json('POST', `/v1/items/${it.id}/removed`, 10_000, { actor, details: { rimossi: full } });
      }
    }
    return { removed, skipped };
  }

  /** «Elimina ovunque»: libreria (con verifica inode) → qBittorrent con file → Jellyfin → stato media. */
  async purgeEverywhere(hashes: string[], actor: string) {
    const all = await this.media.json<{ id: string; torrentHash: string; fileName: string; srcPath: string; status: string; plan: never }[]>('GET', '/v1/items?limit=1000');
    const set = new Set(hashes.map((h) => h.toLowerCase()));
    const items = all.filter((i) => set.has(i.torrentHash.toLowerCase()));
    const lib = await this.purgeLibrary(items, actor);
    const qb = this.integrations.list().find((i) => i.type === 'qbittorrent' && i.enabled);
    let torrentsDeleted = false;
    let torrentError: string | null = null;
    if (qb) {
      try {
        await this.integrations.action(qb.id, 'delete', { hashes, deleteFiles: true });
        torrentsDeleted = true;
      } catch (e) {
        torrentError = (e as Error).message;
      }
    }
    for (const it of items.filter((i) => !['imported', 'indexed', 'removed'].includes(i.status))) {
      await this.media.json('POST', `/v1/items/${it.id}/removed`, 10_000, { actor, details: { motivo: 'torrent eliminato' } }).catch(() => undefined);
    }
    this.events.add('info', 'media', `Eliminato ovunque da ${actor}: ${hashes.length} torrent, ${lib.removed.length} file di libreria`);
    return { torrentsDeleted, torrentError, libraryRemoved: lib.removed, skipped: lib.skipped };
  }

  private async mounts(container: string | undefined): Promise<Mount[]> {
    if (!container) return [];
    try {
      const c = await this.agent.json<{ mounts: Mount[] }>('GET', `/v1/containers/${encodeURIComponent(container)}`);
      return c.mounts.filter((m) => m.type === 'bind');
    } catch {
      return [];
    }
  }

  async creds(): Promise<Creds> {
    const list = this.integrations.list();
    const q = list.find((i) => i.type === 'qbittorrent' && i.enabled);
    const j = list.find((i) => i.type === 'jellyfin' && i.enabled);
    const out: Creds = { qbt: null, jf: null, qbtPathMap: [], jfPathMap: [] };
    if (q) {
      const { row, ctx } = this.integrations.contextFor(q.id);
      out.qbt = { baseUrl: row.base_url, auth: row.auth_type as 'apikey' | 'password', secret: ctx.secret };
      // es. bind /srv -> /data  ⇒  /data/... (qBittorrent) = /srv/... (host)
      out.qbtPathMap = (await this.mounts(q.config.container))
        .map((m) => ({ from: m.destination, to: m.source }))
        .sort((a, b) => b.from.length - a.from.length);
    }
    if (j) {
      const { row, ctx } = this.integrations.contextFor(j.id);
      if (ctx.secret.apiKey) out.jf = { baseUrl: row.base_url, apiKey: ctx.secret.apiKey };
      out.jfPathMap = (await this.mounts(j.config.container))
        .map((m) => ({ host: m.source, jf: m.destination }))
        .sort((a, b) => b.host.length - a.host.length);
    }
    return out;
  }

  async scan(actor: string) {
    const creds = await this.creds();
    if (!creds.qbt) return null;
    const r = await this.media.json<{ detected: number; analyzed: number; imported: string[]; indexed: string[]; review?: string[]; errors: string[] }>(
      'POST',
      '/v1/scan',
      300_000,
      { creds, actor },
    );
    for (const f of r.imported) this.events.add('info', 'media', `Importato: ${f}`);
    for (const t of r.indexed) this.events.add('info', 'media', `Disponibile in Jellyfin/Apollo: ${t}`);
    if (r.detected) this.events.add('info', 'media', `${r.detected} nuovi file rilevati nei download`, null, `media:detected:${Math.floor(Date.now() / 600_000)}`);
    for (const f of r.review ?? []) this.events.add('info', 'media', `Da rivedere: ${f}`, 'Il motore media non è abbastanza sicuro: serve una conferma', `media:review:${f}`);
    for (const e of r.errors.slice(0, 3)) this.events.add('warning', 'media', 'Problema nel motore media', e, `media:err:${e.slice(0, 60)}`);
    return r;
  }

  /** File dei torrent indicati che il motore media non ha ancora portato in libreria. */
  async pendingFor(hashes: string[]): Promise<string[]> {
    const items = await this.media.json<{ torrentHash: string; fileName: string; status: string }[]>('GET', '/v1/items?limit=1000');
    const set = new Set(hashes.map((h) => h.toLowerCase()));
    return items.filter((i) => set.has(i.torrentHash.toLowerCase()) && !['imported', 'indexed', 'ignored'].includes(i.status)).map((i) => i.fileName);
  }

  register(app: FastifyInstance, audit: Audit, viewer: object, admin: object, operator: object = admin) {
    const m = this.media;
    const who = (req: FastifyRequest) => (req.user as SessionUser).username;
    const badId = (reply: FastifyReply) => reply.code(400).send({ error: 'id non valido' });

    app.get('/api/v1/media/summary', viewer, async () => {
      const [s, creds] = await Promise.all([m.json<Record<string, unknown>>('GET', '/v1/summary'), this.creds()]);
      return {
        ...s,
        sources: {
          qbittorrent: !!creds.qbt,
          jellyfin: !!creds.jf,
          qbtPathMap: creds.qbtPathMap,
          jfPathMap: creds.jfPathMap,
        },
      };
    });
    app.get('/api/v1/media/items', viewer, async (req) => {
      const q = req.query as { status?: string; limit?: string };
      const status = q.status && /^[a-z]{3,12}$/.test(q.status) ? q.status : '';
      return m.json('GET', `/v1/items?limit=${Math.min(Number(q.limit ?? 300) || 300, 1000)}${status ? `&status=${status}` : ''}`);
    });
    app.get('/api/v1/media/items/:id', viewer, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!ID.test(id)) return badId(reply);
      return m.json('GET', `/v1/items/${id}`);
    });

    app.post('/api/v1/media/scan', operator, async (req, reply) => {
      const r = await this.scan(who(req));
      if (!r) return reply.code(409).send({ error: 'qBittorrent non è collegato' });
      audit.log(req, 'media.scan', 'ok', null, { rilevati: r.detected, analizzati: r.analyzed, importati: r.imported.length });
      return r;
    });

    app.put('/api/v1/media/settings', admin, async (req) => {
      const body = z.object({ autoImport: z.boolean().optional(), threshold: z.number().int().min(60).max(100).optional() }).parse(req.body);
      const r = await m.json('PUT', '/v1/settings', 10_000, body);
      audit.log(req, 'media.settings', 'ok', null, body);
      return r;
    });

    const action = (name: 'import' | 'ignore' | 'restore' | 'reanalyze') => async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      if (!ID.test(id)) return badId(reply);
      try {
        const r = await m.json<{ fileName: string; plan?: { dest: string } }>('POST', `/v1/items/${id}/${name}`, 120_000, {
          creds: name === 'ignore' || name === 'restore' ? null : await this.creds(),
          actor: who(req),
        });
        audit.log(req, `media.${name}`, 'ok', r.fileName, name === 'import' ? { destinazione: r.plan?.dest } : undefined);
        if (name === 'import') this.events.add('info', 'media', `Importato da ${who(req)}: ${r.fileName}`);
        return r;
      } catch (e) {
        audit.log(req, `media.${name}`, 'error', id, { err: (e as Error).message });
        throw e;
      }
    };
    // Revisione dei media anche agli operatori (D-028); purge, eliminazioni e impostazioni restano admin.
    app.post('/api/v1/media/items/:id/import', operator, action('import'));
    app.post('/api/v1/media/items/:id/ignore', operator, action('ignore'));
    app.post('/api/v1/media/items/:id/restore', operator, action('restore'));
    app.post('/api/v1/media/items/:id/reanalyze', operator, action('reanalyze'));

    app.post('/api/v1/downloads/purge', admin, async (req, reply) => {
      const b = z.object({ hashes: z.array(z.string().regex(/^[a-f0-9]{40}$|^[a-f0-9]{64}$/)).min(1).max(100), confirm: z.string() }).parse(req.body);
      if (b.confirm !== 'ELIMINA') return reply.code(400).send({ error: 'Conferma richiesta: scrivi ELIMINA' });
      const r = await this.purgeEverywhere(b.hashes, who(req));
      audit.log(req, 'downloads.purge', r.torrentError ? 'error' : 'ok', `${b.hashes.length} torrent`, r);
      return r;
    });

    app.post('/api/v1/media/items/:id/purge', admin, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!ID.test(id)) return badId(reply);
      const b = z.object({ confirm: z.string() }).parse(req.body);
      if (b.confirm !== 'ELIMINA') return reply.code(400).send({ error: 'Conferma richiesta: scrivi ELIMINA' });
      const item = await m.json<{ id: string; fileName: string; srcPath: string; status: string; plan: never }>('GET', `/v1/items/${id}`);
      const r = await this.purgeLibrary([item], who(req));
      audit.log(req, 'media.purge', 'ok', item.fileName, r);
      this.events.add('info', 'media', `Rimosso dalla libreria da ${who(req)}: ${item.fileName}`);
      return r;
    });

    app.post('/api/v1/media/items/:id/override', operator, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!ID.test(id)) return badId(reply);
      const override = z
        .object({
          kind: z.enum(['movie', 'episode']).optional(),
          anime: z.boolean().optional(),
          title: z.string().trim().min(1).max(150).optional(),
          year: z.number().int().min(1880).max(2100).nullable().optional(),
          season: z.number().int().min(0).max(99).optional(),
          episodes: z.array(z.number().int().min(0).max(9999)).min(1).max(50).optional(),
        })
        .parse(req.body);
      const r = await m.json<{ fileName: string }>('POST', `/v1/items/${id}/override`, 120_000, { creds: await this.creds(), actor: who(req), override });
      audit.log(req, 'media.override', 'ok', r.fileName, override);
      return r;
    });
  }
}
