// Launcher delle app (D-030): lista condivisa gestita dagli admin, proposte su richiesta da integrazioni e porte in ascolto,
// favicon scaricata dal server dell'app (solo destinazioni consentite) e servita da GIGI OS, stato live senza polling dal browser.
import type { FastifyInstance } from 'fastify';
import type { BlockList } from 'node:net';
import os from 'node:os';
import { z } from 'zod';
import type { AgentClient } from './agent.js';
import type { DB } from './db.js';
import type { Integrations } from './integrations.js';
import { newId, type Audit } from './security.js';
import { safeFetch, TargetError, validateUrl } from './ssrf.js';

export const COLORS = ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5'] as const;
/** Porte che non sono interfacce web: non vengono proposte. */
const NON_WEB = new Set([22, 25, 53, 67, 68, 111, 123, 139, 445, 631, 1900, 2019, 3306, 3307, 3389, 4416, 5060, 5353, 5355, 5432, 5900, 6379, 6881, 7359]);
const ICON_TYPE = /^image\/(png|x-icon|vnd\.microsoft\.icon|svg\+xml|jpeg|webp|gif)$/;
const isLoopbackHost = (h: string) => h === 'localhost' || h.startsWith('127.') || h === '[::1]' || h === '::1';

type Row = {
  id: string;
  name: string;
  url: string;
  grp: string;
  color: string;
  position: number;
  container: string | null;
  integration_id: string | null;
  icon_type: string | null;
  status: string | null;
  status_at: number | null;
  updated_at: number;
};
type ContainerInfo = { name: string; state: string; health: string | null };
type IntegrationView = ReturnType<Integrations['list']>[number];
type Listening = { items: { proto: string; port: number; scope: string; service: string | null; source: string | null; ephemeral: boolean }[] };
export type AppStatus = 'online' | 'degraded' | 'offline' | 'unknown';

export function pageTitle(html: string): string | null {
  const m = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(html);
  if (!m) return null;
  const t = m[1]
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return t ? t.slice(0, 60) : null;
}

/** Candidati per l'icona, nell'ordine in cui provarli: apple-touch-icon (più grande), icon, poi /favicon.ico. */
export function iconCandidates(html: string, pageUrl: string): string[] {
  const out: { href: string; rank: number }[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? '';
    const href = /\bhref\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1];
    if (!href || !/\bicon\b/.test(rel) || href.startsWith('data:')) continue;
    try {
      out.push({ href: new URL(href, pageUrl).toString(), rank: rel.includes('apple-touch') ? 0 : /\.svg(\?|$)/i.test(href) ? 1 : 2 });
    } catch {}
  }
  out.sort((a, b) => a.rank - b.rank);
  const list = out.map((o) => o.href);
  // Percorsi comuni quando la pagina iniziale reindirizza (es. Jellyfin → /web/) e non se ne legge l'HTML.
  for (const p of ['/favicon.ico', '/favicon.png', '/apple-touch-icon.png', '/web/favicon.ico']) list.push(new URL(p, pageUrl).toString());
  return [...new Set(list)].slice(0, 7);
}

export function statusFor(row: Pick<Row, 'container' | 'integration_id' | 'status'>, containers: Map<string, ContainerInfo>, integrations: Map<string, IntegrationView>): { status: AppStatus; source: 'integrazione' | 'container' | 'http' | null } {
  const i = row.integration_id ? integrations.get(row.integration_id) : undefined;
  if (i && i.enabled && i.status) {
    // Per il launcher conta se l'interfaccia risponde: credenziali rifiutate o mancanti non la rendono irraggiungibile.
    const map: Record<string, AppStatus> = { online: 'online', unauthorized: 'online', unconfigured: 'online', unhealthy: 'degraded', offline: 'offline', error: 'offline' };
    if (map[i.status]) return { status: map[i.status], source: 'integrazione' };
  }
  const c = row.container ? containers.get(row.container) : undefined;
  if (c) {
    if (c.state !== 'running') return { status: c.state === 'restarting' ? 'degraded' : 'offline', source: 'container' };
    return { status: c.health === 'unhealthy' ? 'degraded' : 'online', source: 'container' };
  }
  if (row.status) return { status: row.status as AppStatus, source: 'http' };
  return { status: 'unknown', source: null };
}

export const appInput = z.object({
  name: z.string().trim().min(1).max(60),
  url: z
    .string()
    .trim()
    .max(500)
    .refine((u) => {
      try {
        validateUrl(u);
        return true;
      } catch {
        return false;
      }
    }, 'Indirizzo non valido: serve http:// o https://, senza credenziali'),
  group: z.string().trim().max(30).default(''),
  color: z.enum(COLORS).default('chart-1'),
  container: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/).nullable().default(null),
  integrationId: z.string().uuid().nullable().default(null),
});
export type AppInput = z.infer<typeof appInput>;

export class Launcher {
  constructor(
    private db: DB,
    private allowed: BlockList,
    private integrations: Pick<Integrations, 'list'>,
    private agent: Pick<AgentClient, 'json'>,
    private listening: (() => Promise<Listening>) | null,
    private bindHost: string,
    private selfPort: number,
  ) {}

  private rows() {
    return this.db.prepare('SELECT id, name, url, grp, color, position, container, integration_id, icon_type, status, status_at, updated_at FROM launcher_apps ORDER BY position, name').all() as Row[];
  }

  async list() {
    const [containers, integrations] = await Promise.all([
      this.agent.json<ContainerInfo[]>('GET', '/v1/containers').catch(() => [] as ContainerInfo[]),
      Promise.resolve(this.integrations.list()),
    ]);
    const cm = new Map(containers.map((c) => [c.name, c]));
    const im = new Map(integrations.map((i) => [i.id, i]));
    return this.rows().map((r) => {
      const s = statusFor(r, cm, im);
      return {
        id: r.id,
        name: r.name,
        url: r.url,
        group: r.grp,
        color: r.color,
        position: r.position,
        container: r.container,
        integrationId: r.integration_id,
        icon: r.icon_type ? `/api/v1/launcher/${r.id}/icon?v=${r.updated_at}` : null,
        status: s.status,
        statusSource: s.source,
        checkedAt: s.source === 'http' ? r.status_at : null,
      };
    });
  }

  icon(id: string) {
    return this.db.prepare('SELECT icon_type, icon_data FROM launcher_apps WHERE id = ?').get(id) as { icon_type: string | null; icon_data: Uint8Array | null } | undefined;
  }

  create(input: AppInput) {
    const id = newId();
    const now = Date.now();
    const pos = (this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM launcher_apps').get() as { p: number }).p;
    this.db
      .prepare('INSERT INTO launcher_apps (id, name, url, grp, color, position, container, integration_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.name, input.url, input.group, input.color, pos, input.container, this.validIntegration(input.integrationId), now, now);
    return id;
  }

  update(id: string, input: AppInput) {
    const old = this.db.prepare('SELECT url FROM launcher_apps WHERE id = ?').get(id) as { url: string } | undefined;
    if (!old) return null;
    this.db
      .prepare('UPDATE launcher_apps SET name = ?, url = ?, grp = ?, color = ?, container = ?, integration_id = ?, updated_at = ?, status = CASE WHEN url = ? THEN status ELSE NULL END WHERE id = ?')
      .run(input.name, input.url, input.group, input.color, input.container, this.validIntegration(input.integrationId), Date.now(), input.url, id);
    return { urlChanged: old.url !== input.url };
  }

  remove(id: string) {
    return this.db.prepare('DELETE FROM launcher_apps WHERE id = ?').run(id).changes > 0;
  }

  reorder(ids: string[]) {
    const up = this.db.prepare('UPDATE launcher_apps SET position = ? WHERE id = ?');
    ids.forEach((id, i) => up.run(i, id));
  }

  private validIntegration(id: string | null) {
    return id && this.integrations.list().some((i) => i.id === id) ? id : null;
  }

  /**
   * Una richiesta GET con timeout breve; un redirect o una risposta troppo grande indicano comunque un servizio attivo.
   * Per leggere titolo e icona segue al massimo un redirect, solo verso la stessa origine (es. Jellyfin / → /web/).
   */
  private async probe(url: string, follow = 1): Promise<{ up: boolean | null; html: string | null; finalUrl: string }> {
    try {
      const r = await safeFetch(this.allowed, url, { timeoutMs: 3000, maxBytes: 512 * 1024, headers: { Accept: 'text/html,*/*' } });
      const html = /text\/html/i.test(r.headers.get('content-type') ?? '') ? r.body.toString('utf8') : null;
      return { up: r.status < 500, html, finalUrl: url };
    } catch (e) {
      if (e instanceof TargetError && e.code === 'redirect' && follow > 0 && e.location) {
        try {
          const next = new URL(e.location, url);
          if (next.origin === new URL(url).origin) {
            const r = await this.probe(next.toString(), follow - 1);
            return r.up ? r : { up: true, html: null, finalUrl: url };
          }
        } catch {}
      }
      if (e instanceof TargetError && (e.code === 'redirect' || e.code === 'too_large')) return { up: true, html: null, finalUrl: url };
      if (e instanceof TargetError && (e.code === 'forbidden_target' || e.code === 'bad_url')) return { up: null, html: null, finalUrl: url };
      return { up: false, html: null, finalUrl: url };
    }
  }

  /** Scarica la favicon dall'app stessa (solo destinazioni consentite) e la salva nel database. */
  async refreshIcon(id: string): Promise<boolean> {
    const row = this.db.prepare('SELECT url FROM launcher_apps WHERE id = ?').get(id) as { url: string } | undefined;
    if (!row) return false;
    const page = await this.probe(row.url);
    const candidates = iconCandidates(page.html ?? '', page.finalUrl);
    for (const c of candidates) {
      try {
        const r = await safeFetch(this.allowed, c, { timeoutMs: 3000, maxBytes: 256 * 1024 });
        const type = (r.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
        if (r.status !== 200 || !ICON_TYPE.test(type) || r.body.length < 16) continue;
        this.db.prepare('UPDATE launcher_apps SET icon_type = ?, icon_data = ?, updated_at = ? WHERE id = ?').run(type, r.body, Date.now(), id);
        return true;
      } catch {}
    }
    return false;
  }

  /** Controllo HTTP per le app senza container o integrazione collegati. */
  async checkHttp() {
    const rows = this.rows().filter((r) => !r.container && !r.integration_id);
    for (const r of rows) await this.checkOne(r.id, r.url);
    return rows.length;
  }

  async checkOne(id: string, url?: string) {
    const u = url ?? (this.db.prepare('SELECT url FROM launcher_apps WHERE id = ?').get(id) as { url: string } | undefined)?.url;
    if (!u) return;
    const p = await this.probe(u);
    const status: AppStatus = p.up === null ? 'unknown' : p.up ? 'online' : 'offline';
    this.db.prepare('UPDATE launcher_apps SET status = ?, status_at = ? WHERE id = ?').run(status, Date.now(), id);
  }

  start(warn: (m: string, e?: object) => void) {
    const run = () => this.checkHttp().catch((e) => warn('launcher: controllo non riuscito', { err: (e as Error).message }));
    setTimeout(run, 10_000).unref();
    setInterval(run, 120_000).unref();
  }

  /** Proposte (mai salvate da sole): integrazioni con indirizzo apribile e porte web in ascolto sull'IP LAN. */
  async discover() {
    const existing = new Set(this.rows().map((r) => normalize(r.url)));
    const out: { name: string; url: string; source: 'integrazione' | 'porta'; type: string | null; container: string | null; integrationId: string | null; openable: boolean; reason: string | null; added: boolean }[] = [];
    const ports = new Set<number>();
    // Indirizzi di questo PC: un'integrazione che punta a uno di questi occupa già la sua porta.
    const self = new Set([this.bindHost, ...Object.values(os.networkInterfaces()).flatMap((l) => (l ?? []).map((a) => a.address))]);
    for (const i of this.integrations.list()) {
      let u: URL;
      try {
        u = new URL(i.webUrl);
      } catch {
        continue;
      }
      const openable = !isLoopbackHost(u.hostname);
      if (self.has(u.hostname) || isLoopbackHost(u.hostname)) ports.add(Number(u.port || (u.protocol === 'https:' ? 443 : 80)));
      out.push({
        name: i.name,
        url: i.webUrl,
        source: 'integrazione',
        type: i.type,
        container: i.config.container ?? null,
        integrationId: i.id,
        openable,
        reason: openable ? null : 'Raggiungibile solo dal server (127.0.0.1): imposta un indirizzo LAN nell’integrazione',
        added: existing.has(normalize(i.webUrl)),
      });
    }
    const listening = this.listening ? await this.listening().catch(() => ({ items: [] })) : { items: [] };
    const cand = listening.items
      .filter((l) => l.proto === 'tcp' && l.scope !== 'local' && !l.ephemeral && !NON_WEB.has(l.port) && l.port !== this.selfPort && !ports.has(l.port))
      .slice(0, 20);
    for (const l of cand) {
      const tries = l.port === 443 || l.port === 8443 ? [`https://${this.bindHost}:${l.port}/`] : [`http://${this.bindHost}:${l.port}/`, `https://${this.bindHost}:${l.port}/`];
      for (const url of tries) {
        const p = await this.probe(url);
        if (!p.up) continue;
        const clean = url.replace(/:443\/$/, '/');
        out.push({
          name: (p.html && pageTitle(p.html)) || l.service || `Porta ${l.port}`,
          url: clean,
          source: 'porta',
          type: null,
          container: l.source === 'docker' ? l.service : null,
          integrationId: null,
          openable: true,
          reason: null,
          added: existing.has(normalize(clean)),
        });
        break;
      }
    }
    return out;
  }
}

function normalize(u: string) {
  try {
    const x = new URL(u);
    return `${x.protocol}//${x.host}${x.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return u;
  }
}

export function registerLauncher(app: FastifyInstance, l: Launcher, audit: Audit, viewer: object, admin: object) {
  const ID = /^[0-9a-f-]{36}$/;
  app.get('/api/v1/launcher', viewer, async () => l.list());

  app.get('/api/v1/launcher/:id/icon', viewer, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!ID.test(id)) return reply.code(400).send({ error: 'id non valido' });
    const ic = l.icon(id);
    if (!ic?.icon_type || !ic.icon_data) return reply.code(404).send({ error: 'Nessuna icona' });
    // Contenuto di terzi: mai interpretato come documento (le SVG restano immagini).
    return reply
      .header('Cache-Control', 'private, max-age=86400')
      .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
      .header('X-Content-Type-Options', 'nosniff')
      .type(ic.icon_type)
      .send(Buffer.from(ic.icon_data));
  });

  app.post('/api/v1/launcher', admin, async (req) => {
    const body = appInput.parse(req.body);
    const id = l.create(body);
    const [icon] = await Promise.all([l.refreshIcon(id).catch(() => false), l.checkOne(id).catch(() => undefined)]);
    audit.log(req, 'launcher.create', 'ok', body.name, { url: body.url });
    return { id, icon };
  });

  app.put('/api/v1/launcher/order', admin, async (req) => {
    const { ids } = z.object({ ids: z.array(z.string().regex(ID)).max(200) }).parse(req.body);
    l.reorder(ids);
    audit.log(req, 'launcher.reorder', 'ok', null, { count: ids.length });
    return { ok: true };
  });

  app.patch('/api/v1/launcher/:id', admin, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!ID.test(id)) return reply.code(400).send({ error: 'id non valido' });
    const body = appInput.parse(req.body);
    const r = l.update(id, body);
    if (!r) return reply.code(404).send({ error: 'App non trovata' });
    if (r.urlChanged) await Promise.all([l.refreshIcon(id).catch(() => false), l.checkOne(id).catch(() => undefined)]);
    audit.log(req, 'launcher.update', 'ok', body.name, { url: body.url });
    return { ok: true };
  });

  app.post('/api/v1/launcher/:id/icon', { ...admin, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!ID.test(id)) return reply.code(400).send({ error: 'id non valido' });
    return { icon: await l.refreshIcon(id) };
  });

  app.delete('/api/v1/launcher/:id', admin, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!ID.test(id)) return reply.code(400).send({ error: 'id non valido' });
    if (!l.remove(id)) return reply.code(404).send({ error: 'App non trovata' });
    audit.log(req, 'launcher.delete', 'ok', id);
    return { ok: true };
  });

  app.post('/api/v1/launcher/discover', { ...admin, config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req) => {
    const r = await l.discover();
    audit.log(req, 'launcher.discover', 'ok', null, { candidates: r.length });
    return r;
  });
}
