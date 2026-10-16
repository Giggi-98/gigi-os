// Ponte API ↔ gigi-media: autorizzazione, audit e credenziali iniettate in memoria a ogni richiesta.
// Le mappature dei percorsi sono ricavate dai mount reali dei container (via agent), non configurate a mano.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AgentClient } from './agent.js';
import type { Events } from './events.js';
import type { Integrations } from './integrations.js';
import type { Audit, SessionUser } from './security.js';
import { jellyfinExisting, jellyfinLocations, jellyfinNotifyDeleted, jellyfinTitleFiles } from './connectors/jellyfin.js';
import { qbtTorrentFiles } from './connectors/qbittorrent.js';
import type { ConnectorContext } from './connectors/types.js';

type Mount = { type: string; source: string; destination: string };
type Creds = {
  qbt: { baseUrl: string; auth: 'apikey' | 'password'; secret: Record<string, string> } | null;
  jf: { baseUrl: string; apiKey: string } | null;
  qbtPathMap: { from: string; to: string }[];
  jfPathMap: { host: string; jf: string }[];
};

const ID = /^[0-9a-f]{20}$/;
/** Vista minima di un elemento del motore media (i campi completi li mostra l’interfaccia). */
export type MediaItem = { id: string; fileName: string; status: string; confidence: number | null; torrentHash: string; plan: { dest: string } | null; jellyfin?: { id: string } | null };
type FsFile = { path: string; size: number };
type FsVideo = FsFile & { ino: number; dev: number; nlink: number };
/** Anteprima di gigi-files (mediaPlan): video, accessori, cartelle che si svuotano. */
type FsPlan = { videos: FsVideo[]; sidecars: FsFile[]; extras: FsFile[]; dirs: string[]; skipped: { path: string; reason: string }[]; size: number; freed: number };
const HASH = /^[a-f0-9]{40}$|^[a-f0-9]{64}$/;
export const MEDIA_ID = ID;

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
      if (r.removed.length || !r.skipped.length) {
        await this.media.json('POST', `/v1/items/${it.id}/removed`, 10_000, { actor, details: { rimossi: full } });
      }
    }
    return { removed, skipped };
  }

  // ───────── eliminazioni dalla libreria (D-038) ─────────

  /** Attesa sostituibile nei test. */
  wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  private ctxOf(type: string): ConnectorContext | null {
    const i = this.integrations.list().find((x) => x.type === type && x.enabled);
    return i ? this.integrations.contextFor(i.id).ctx : null;
  }

  private static toHost(p: string, creds: Creds) {
    const m = [...creds.jfPathMap].sort((a, b) => b.jf.length - a.jf.length).find((x) => p === x.jf || p.startsWith(x.jf + '/'));
    return m ? m.host + p.slice(m.jf.length) : null;
  }
  private static toJf(p: string, creds: Creds) {
    const m = creds.jfPathMap.find((x) => p === x.host || p.startsWith(x.host + '/'));
    return m ? m.jf + p.slice(m.host.length) : null;
  }
  private static qbToHost(p: string, creds: Creds) {
    const m = creds.qbtPathMap.find((x) => p === x.from || p.startsWith(x.from + '/'));
    return m ? m.to + p.slice(m.from.length) : null;
  }

  /** Cartelle delle librerie sull'host: quelle di Jellyfin, altrimenti quelle in cui il motore media ha importato. */
  private async libraryStops(creds: Creds): Promise<string[]> {
    const jf = this.ctxOf('jellyfin');
    if (jf) {
      const locs = await jellyfinLocations(jf).catch(() => null);
      if (locs) return [...new Set(locs.map((l) => MediaBridge.toHost(l, creds)).filter((x): x is string => !!x))];
    }
    const items = await this.media.json<{ plan: { libraryRoot?: string } | null }[]>('GET', '/v1/items?limit=1000').catch(() => []);
    return [...new Set(items.map((i) => i.plan?.libraryRoot).filter((x): x is string => !!x))];
  }

  private async statAll(paths: string[]) {
    const out: { path: string; ino?: number; dev?: number; nlink?: number; size?: number }[] = [];
    for (let i = 0; i < paths.length; i += 1000) out.push(...(await this.files!.json<typeof out>('POST', '/v1/stat', 60_000, { paths: paths.slice(i, i + 1000) })));
    return out;
  }

  /** Torrent di qBittorrent che hanno uno di questi file (stesso inode: hardlink tra download e libreria). */
  private async linkedTorrents(creds: Creds, videos: FsVideo[]) {
    const want = new Set(videos.filter((v) => v.nlink > 1).map((v) => `${v.dev}:${v.ino}`));
    const qb = this.ctxOf('qbittorrent');
    if (!want.size || !qb) return [];
    const torrents = await qbtTorrentFiles(qb);
    const hostOf = new Map<string, string>();
    for (const t of torrents) for (const f of t.files) {
      const h = MediaBridge.qbToHost(f.path, creds);
      if (h) hostOf.set(f.path, h);
    }
    const st = new Map((await this.statAll([...new Set(hostOf.values())])).filter((x) => x.ino !== undefined).map((x) => [x.path, `${x.dev}:${x.ino}`]));
    return torrents.filter((t) => t.files.some((f) => want.has(st.get(hostOf.get(f.path) ?? '') ?? ''))).map((t) => ({ hash: t.hash, name: t.name }));
  }

  /** Anteprima di «Elimina dalla libreria» per un titolo di Jellyfin: file, accessori, cartelle, torrent collegati. */
  async libraryPlan(jfId: string) {
    if (!this.files) throw Object.assign(new Error('File manager non disponibile'), { statusCode: 503 });
    const jf = this.ctxOf('jellyfin');
    if (!jf) throw Object.assign(new Error('Jellyfin non è collegato'), { statusCode: 409 });
    const creds = await this.creds();
    const t = await jellyfinTitleFiles(jf, jfId);
    const mapped = t.paths.map((p) => ({ jf: p, host: MediaBridge.toHost(p, creds) }));
    const unmapped = mapped.filter((m) => !m.host).map((m) => m.jf);
    const files = mapped.map((m) => m.host).filter((x): x is string => !!x);
    if (!files.length) {
      throw Object.assign(new Error(t.paths.length ? 'I file di questo titolo non sono in cartelle che GIGI OS può raggiungere' : 'Jellyfin non ha file per questo titolo'), { statusCode: 409 });
    }
    const stops = await this.libraryStops(creds);
    const plan = await this.files.json<FsPlan>('POST', '/v1/media-plan', 60_000, { files, stops });
    let torrents: { hash: string; name: string }[] = [];
    let torrentsError: string | null = null;
    try {
      torrents = await this.linkedTorrents(creds, plan.videos);
    } catch (e) {
      torrentsError = (e as Error).message;
    }
    return { item: t.item, episodes: t.episodes, ...plan, unmapped, stops, torrents, torrentsError };
  }

  /** Esegue «Elimina dalla libreria»: file (cestino o definitivo), torrent scelti, stato media, verifica in Jellyfin. */
  async libraryDelete(jfId: string, opts: { mode: 'trash' | 'delete'; torrents: string[]; expect: { path: string; ino: number; dev: number }[] }, actor: string) {
    const plan = await this.libraryPlan(jfId);
    const r = await this.files!.json<FsPlan & { batches: { root: string; batch: string }[] }>('POST', '/v1/media-delete', 120_000, {
      files: plan.videos.map((v) => v.path),
      stops: plan.stops,
      mode: opts.mode,
      expect: opts.expect,
    });
    const chosen = plan.torrents.map((t) => t.hash).filter((h) => opts.torrents.includes(h));
    let torrentsDeleted = 0;
    let torrentError: string | null = null;
    const qb = this.integrations.list().find((i) => i.type === 'qbittorrent' && i.enabled);
    if (chosen.length && qb) {
      try {
        await this.integrations.action(qb.id, 'delete', { hashes: chosen, deleteFiles: true });
        torrentsDeleted = chosen.length;
      } catch (e) {
        torrentError = (e as Error).message;
      }
    }
    const gone = new Set(r.videos.map((v) => v.path));
    const items = await this.items(1000).catch(() => [] as MediaItem[]);
    for (const it of items.filter((i) => i.status !== 'removed' && ((i.plan && gone.has(i.plan.dest)) || chosen.includes(i.torrentHash)))) {
      await this.media.json('POST', `/v1/items/${it.id}/removed`, 10_000, { actor, details: { motivo: 'eliminato dalla libreria' } }).catch(() => undefined);
    }
    const label = plan.item.seriesName && plan.item.type !== 'Series' ? `${plan.item.seriesName} · ${plan.item.name}` : plan.item.name;
    const jellyfin = await this.afterDelete([...r.videos.map((v) => v.path), ...r.dirs], [jfId], label);
    this.events.add('info', 'media', `${opts.mode === 'trash' ? 'Spostato nel cestino' : 'Eliminato'} da ${actor}: ${label}`, `${r.videos.length} file video${torrentsDeleted ? `, ${torrentsDeleted} torrent` : ''}`);
    return {
      title: label,
      mode: opts.mode,
      videos: r.videos.length,
      files: r.videos.length + r.sidecars.length + r.extras.length,
      dirs: r.dirs.length,
      freed: opts.mode === 'delete' ? r.freed : 0,
      size: r.size,
      batches: r.batches,
      torrentsDeleted,
      torrentError,
      jellyfin,
    };
  }

  /**
   * Dopo un'eliminazione: avvisa Jellyfin dei percorsi tolti, avvia la scansione delle librerie (l'avviso da solo
   * viene applicato con il ritardo del monitor di Jellyfin) e verifica che i titoli spariscano; se serve più tempo,
   * continua a controllare in background e lo segnala con un evento.
   */
  async afterDelete(hostPaths: string[], ids: string[], label: string): Promise<'removed' | 'pending' | 'unconfigured'> {
    const jf = this.ctxOf('jellyfin');
    if (!jf) return 'unconfigured';
    const creds = await this.creds();
    const jfPaths = [...new Set(hostPaths.map((p) => MediaBridge.toJf(p, creds)).filter((x): x is string => !!x))];
    await jellyfinNotifyDeleted(jf, jfPaths, true).catch(() => jellyfinNotifyDeleted(jf, [], true).catch(() => undefined));
    if (!ids.length) return 'pending';
    const check = async () => (await jellyfinExisting(jf, ids).catch(() => ids)).length === 0;
    for (let i = 0; i < 8; i++) {
      await this.wait(2000);
      if (await check()) return 'removed';
    }
    void (async () => {
      for (let i = 0; i < 40; i++) {
        await this.wait(15_000);
        if (await check()) return this.events.add('info', 'media', `Sparito da Jellyfin: ${label}`);
      }
      this.events.add('warning', 'media', `${label} risulta ancora in Jellyfin`, 'I file sono stati tolti, ma dopo 10 minuti Jellyfin mostra ancora il titolo: avvia «Scansiona tutte le librerie» in Jellyfin');
    })();
    return 'pending';
  }

  /** Il file manager ha cestinato dei percorsi: se sono in una libreria, Jellyfin deve toglierli. */
  async libraryRemoved(hostPaths: string[]) {
    const stops = await this.libraryStops(await this.creds());
    const inLib = hostPaths.filter((p) => stops.some((s) => p.startsWith(s + '/')));
    if (inLib.length) await this.afterDelete(inLib, [], 'file manager');
  }

  /** Il file manager ha ripristinato qualcosa: una scansione lo rimette nelle librerie. */
  async libraryRescan() {
    const jf = this.ctxOf('jellyfin');
    if (jf) await jellyfinNotifyDeleted(jf, [], true);
  }

  /** Anteprima di «Elimina ovunque»: per ogni torrent, le sue copie in libreria (hardlink, riconosciuti dall'inode). */
  async purgePlan(hashes: string[]) {
    if (!this.files) throw Object.assign(new Error('File manager non disponibile'), { statusCode: 503 });
    const qb = this.ctxOf('qbittorrent');
    if (!qb) throw Object.assign(new Error('qBittorrent non è collegato'), { statusCode: 409 });
    const creds = await this.creds();
    const torrents = await qbtTorrentFiles(qb, hashes);
    const hostFiles = torrents.map((t) => ({ t, files: t.files.map((f) => MediaBridge.qbToHost(f.path, creds)).filter((x): x is string => !!x) }));
    const st = await this.statAll(hostFiles.flatMap((x) => x.files));
    const key = new Map(st.filter((x) => x.ino !== undefined).map((x) => [x.path, `${x.dev}:${x.ino}`]));
    const targets = st.filter((x) => (x.nlink ?? 1) > 1).map((x) => ({ ino: x.ino, dev: x.dev }));
    const stops = await this.libraryStops(creds);
    const links = targets.length ? await this.files.json<(FsFile & { ino: number; dev: number })[]>('POST', '/v1/find-links', 120_000, { dirs: stops, targets }) : [];
    // I file del download stesso non sono «copie in libreria»
    const own = new Set(hostFiles.flatMap((x) => x.files));
    return {
      stops,
      torrents: hostFiles.map(({ t, files }) => {
        const mine = new Set(files.map((f) => key.get(f)).filter(Boolean));
        return {
          hash: t.hash,
          name: t.name,
          size: t.files.reduce((n, f) => n + f.size, 0),
          library: links.filter((l) => !own.has(l.path) && mine.has(`${l.dev}:${l.ino}`)),
        };
      }),
    };
  }

  /** «Elimina ovunque»: copie in libreria (stesso inode) → qBittorrent con i file → stato media → verifica in Jellyfin. */
  async purgeEverywhere(hashes: string[], actor: string) {
    const plan = await this.purgePlan(hashes);
    const lib = plan.torrents.flatMap((t) => t.library);
    let removed: FsPlan | null = null;
    if (lib.length) {
      removed = await this.files!.json<FsPlan>('POST', '/v1/media-delete', 120_000, { files: lib.map((l) => l.path), stops: plan.stops, mode: 'delete', expect: lib });
    }
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
    const set = new Set(hashes.map((h) => h.toLowerCase()));
    const items = (await this.items(1000).catch(() => [] as MediaItem[])).filter((i) => set.has(i.torrentHash.toLowerCase()) && i.status !== 'removed');
    for (const it of items) {
      await this.media.json('POST', `/v1/items/${it.id}/removed`, 10_000, { actor, details: { motivo: 'eliminato ovunque' } }).catch(() => undefined);
    }
    const libraryRemoved = removed ? [...removed.videos, ...removed.sidecars, ...removed.extras].map((f) => f.path) : [];
    const ids = items.map((i) => i.jellyfin?.id).filter((x): x is string => !!x);
    const jellyfin = libraryRemoved.length ? await this.afterDelete([...(removed?.videos.map((v) => v.path) ?? []), ...(removed?.dirs ?? [])], ids, plan.torrents.map((t) => t.name).join(', ')) : 'unchanged';
    this.events.add('info', 'media', `Eliminato ovunque da ${actor}: ${hashes.length} torrent, ${removed?.videos.length ?? 0} file in libreria`);
    return { torrentsDeleted, torrentError, libraryRemoved, skipped: removed?.skipped ?? [], jellyfin };
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

  /** Elementi del motore media (usati anche da bot e digest). */
  items(limit = 300) {
    return this.media.json<MediaItem[]>('GET', `/v1/items?limit=${Math.min(limit, 1000)}`);
  }

  item(id: string) {
    return this.media.json<MediaItem>('GET', `/v1/items/${id}`);
  }

  /** Azione su un elemento a nome di `actor`: stesso percorso per interfaccia e bot. L'audit lo fa il chiamante. */
  async act(name: 'import' | 'ignore' | 'restore' | 'reanalyze', id: string, actor: string) {
    const r = await this.media.json<{ fileName: string; plan?: { dest: string } }>('POST', `/v1/items/${id}/${name}`, 120_000, {
      creds: name === 'ignore' || name === 'restore' ? null : await this.creds(),
      actor,
    });
    if (name === 'import') this.events.add('info', 'media', `Importato da ${actor}: ${r.fileName}`);
    return r;
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
        const r = await this.act(name, id, who(req));
        audit.log(req, `media.${name}`, 'ok', r.fileName, name === 'import' ? { destinazione: r.plan?.dest } : undefined);
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
      const b = z.object({ hashes: z.array(z.string().regex(HASH)).min(1).max(100), confirm: z.string() }).parse(req.body);
      if (b.confirm !== 'ELIMINA') return reply.code(400).send({ error: 'Conferma richiesta: scrivi ELIMINA' });
      const r = await this.purgeEverywhere(b.hashes, who(req));
      audit.log(req, 'downloads.purge', r.torrentError ? 'error' : 'ok', `${b.hashes.length} torrent`, r);
      return r;
    });

    app.post('/api/v1/downloads/purge-plan', admin, async (req) => {
      const b = z.object({ hashes: z.array(z.string().regex(HASH)).min(1).max(100) }).parse(req.body);
      return this.purgePlan(b.hashes);
    });

    const JF = /^[0-9a-f]{32}$/i;
    app.get('/api/v1/media/library/:jfId/plan', admin, async (req, reply) => {
      const { jfId } = req.params as { jfId: string };
      if (!JF.test(jfId)) return badId(reply);
      return this.libraryPlan(jfId);
    });
    app.post('/api/v1/media/library/:jfId/delete', admin, async (req, reply) => {
      const { jfId } = req.params as { jfId: string };
      if (!JF.test(jfId)) return badId(reply);
      const b = z
        .object({
          confirm: z.string(),
          mode: z.enum(['trash', 'delete']),
          torrents: z.array(z.string().regex(HASH)).max(100).default([]),
          expect: z.array(z.object({ path: z.string().max(4096), ino: z.number(), dev: z.number() })).max(2000).default([]),
        })
        .parse(req.body);
      if (b.confirm !== 'ELIMINA') return reply.code(400).send({ error: 'Conferma richiesta: scrivi ELIMINA' });
      try {
        const r = await this.libraryDelete(jfId, b, who(req));
        audit.log(req, 'media.library.delete', r.torrentError ? 'error' : 'ok', r.title, { ...r, batches: undefined });
        return r;
      } catch (e) {
        audit.log(req, 'media.library.delete', 'error', jfId, { err: (e as Error).message });
        throw e;
      }
    });

    app.post('/api/v1/media/items/:id/purge', admin, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!ID.test(id)) return badId(reply);
      const b = z.object({ confirm: z.string() }).parse(req.body);
      if (b.confirm !== 'ELIMINA') return reply.code(400).send({ error: 'Conferma richiesta: scrivi ELIMINA' });
      const item = await m.json<{ id: string; fileName: string; srcPath: string; status: string; plan: never; jellyfin: { id: string } | null }>('GET', `/v1/items/${id}`);
      const r = await this.purgeLibrary([item], who(req));
      if (r.removed.length) await this.afterDelete(r.removed, item.jellyfin ? [item.jellyfin.id] : [], item.fileName);
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
