// Rilevamento aggiornamenti (D-032): container (digest via agent + versioni nuove dei tag fissati dai registry),
// sistema operativo (via agent), app (Jellyfin, Home Assistant) e GIGI OS. Solo rilevamento: nessun aggiornamento automatico.
// Le richieste esterne vanno solo a un elenco fisso di registry e a GitHub, mai a indirizzi scelti dall'utente.
import type { FastifyInstance } from 'fastify';
import type { AgentClient } from './agent.js';
import { getSetting, setSetting, type DB } from './db.js';
import type { Events } from './events.js';
import type { Integrations } from './integrations.js';
import type { Audit } from './security.js';

const HOUR = 3600_000;
const ALLOWED_HOSTS = new Set(['hub.docker.com', 'ghcr.io', 'quay.io', 'api.github.com']);
const PRE = /(rc|beta|alpha|dev|nightly|preview|snapshot|test|pre|canary|edge|unstable)/i;

// ───────── riferimenti e versioni ─────────
export function parseRef(ref: string): { registry: string; repo: string; tag: string | null } {
  let name = ref;
  let tag: string | null = 'latest';
  const at = name.indexOf('@');
  if (at >= 0) {
    name = name.slice(0, at);
    tag = null; // fissata per digest: nessuna versione da confrontare
  }
  const colon = name.lastIndexOf(':');
  if (colon > name.lastIndexOf('/')) {
    if (tag !== null) tag = name.slice(colon + 1);
    name = name.slice(0, colon);
  }
  const first = name.split('/')[0];
  let registry = 'docker.io';
  let repo = name;
  if (name.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost')) {
    registry = first;
    repo = name.slice(first.length + 1);
  }
  if (registry === 'docker.io' && !repo.includes('/')) repo = `library/${repo}`;
  if (registry === 'lscr.io') registry = 'ghcr.io'; // le immagini linuxserver di lscr.io sono su GHCR
  return { registry, repo, tag };
}

type Ver = { tag: string; prefix: string; nums: number[]; suffix: string };
export function parseTag(tag: string): Ver | null {
  const m = /^(v?)(\d+(?:\.\d+){0,3})([-_+.][0-9A-Za-z.-]*)?$/.exec(tag);
  if (!m) return null;
  return { tag, prefix: m[1], nums: m[2].split('.').map(Number), suffix: m[3] ?? '' };
}
const cmp = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
};
export const compareVersions = (a: string, b: string) => {
  const pa = parseTag(a.replace(/^v/, ''));
  const pb = parseTag(b.replace(/^v/, ''));
  return pa && pb ? cmp(pa.nums, pb.nums) : 0;
};

/** Il tag più recente della stessa «forma» (stesso prefisso, stesse parti numeriche, stesso suffisso, niente pre-release). */
export function newerTag(current: string, tags: string[]): string | null {
  const c = parseTag(current);
  if (!c || c.nums.length < 2 || PRE.test(c.suffix)) return null;
  let best: Ver = c;
  for (const t of tags) {
    const p = parseTag(t);
    if (!p || p.prefix !== c.prefix || p.nums.length !== c.nums.length || p.suffix !== c.suffix || PRE.test(t)) continue;
    if (cmp(p.nums, best.nums) > 0) best = p;
  }
  return best === c ? null : best.tag;
}

// ───────── registry ─────────
type Fetch = typeof fetch;

async function getJson<T>(f: Fetch, url: string, headers: Record<string, string> = {}): Promise<{ body: T; link: string | null }> {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname)) throw new Error(`Destinazione non consentita: ${u.hostname}`);
  const res = await f(u, { headers: { Accept: 'application/json', 'User-Agent': 'gigi-os-update-check', ...headers }, signal: AbortSignal.timeout(10_000) });
  if (!ALLOWED_HOSTS.has(new URL(res.url || url).hostname)) throw new Error('Redirect verso una destinazione non consentita');
  if (!res.ok) throw new Error(`${u.hostname}: HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > 8 * 1024 * 1024) throw new Error('Risposta troppo grande');
  return { body: JSON.parse(text) as T, link: res.headers.get('link') };
}

/** Ultima versione di GIGI OS: la release GitHub più recente, altrimenti il tag vX.Y.Z più alto (repo senza release). */
export async function latestGigi(f: Fetch, repo: string): Promise<{ latest: string | null; url: string | null }> {
  try {
    const r = await getJson<{ tag_name: string; html_url: string }>(f, `https://api.github.com/repos/${repo}/releases/latest`);
    return { latest: r.body.tag_name.replace(/^v/, ''), url: r.body.html_url ?? null };
  } catch (e) {
    if (!/HTTP 404$/.test((e as Error).message)) throw e;
  }
  const tags = (await getJson<{ name: string }[]>(f, `https://api.github.com/repos/${repo}/tags?per_page=100`)).body
    .map((t) => t.name)
    .filter((n) => /^v?\d+\.\d+\.\d+$/.test(n));
  const best = tags.reduce<string | null>((m, n) => (!m || compareVersions(n, m) > 0 ? n : m), null);
  return { latest: best ? best.replace(/^v/, '') : null, url: best ? `https://github.com/${repo}/releases/tag/${best}` : null };
}

export async function listTags(f: Fetch, registry: string, repo: string): Promise<string[]> {
  if (registry === 'docker.io') {
    const r = await getJson<{ results: { name: string }[] }>(f, `https://hub.docker.com/v2/repositories/${repo}/tags?page_size=100&ordering=last_updated`);
    return r.body.results.map((t) => t.name);
  }
  if (registry === 'ghcr.io') {
    const tok = await getJson<{ token: string }>(f, `https://ghcr.io/token?scope=repository:${repo}:pull`);
    const tags: string[] = [];
    let url: string | null = `https://ghcr.io/v2/${repo}/tags/list?n=1000`;
    for (let page = 0; url && page < 5; page++) {
      const r: { body: { tags: string[] | null }; link: string | null } = await getJson<{ tags: string[] | null }>(f, url, { Authorization: `Bearer ${tok.body.token}` });
      tags.push(...(r.body.tags ?? []));
      const next = r.link ? /<([^>]+)>;\s*rel="next"/.exec(r.link)?.[1] : null;
      url = next ? new URL(next, 'https://ghcr.io').toString() : null;
    }
    return tags;
  }
  if (registry === 'quay.io') {
    const r = await getJson<{ tags: { name: string }[] }>(f, `https://quay.io/api/v1/repository/${repo}/tag/?limit=100&onlyActiveTags=true`);
    return r.body.tags.map((t) => t.name);
  }
  throw new Error(`Registry ${registry} non supportato per l’elenco delle versioni`);
}

// ───────── risultato ─────────
type AgentImage = { ref: string; containers: string[]; project: string | null; workingDir: string | null; status: 'aggiornato' | 'disponibile' | 'locale' | 'errore'; error: string | null };
type AgentHost = {
  supported: boolean;
  packages: { upgradable: number | null; security: number; esm: number; at: number | null } | null;
  apt: { lastUpdate: number | null; lastSuccess: number | null; lastUnattended: number | null };
  unattendedEnabled: boolean;
  kernel: { running: string; newest: string | null; rebootNeeded: boolean };
};
export type ImageResult = AgentImage & { newerVersion: string | null; versionError: string | null; managedByGigi: boolean };
export type AppResult = { name: string; status: 'aggiornato' | 'disponibile' | 'non configurato' | 'errore'; current: string | null; latest: string | null; detail: string | null };
export type UpdatesResult = {
  checkedAt: number;
  images: ImageResult[] | null;
  imagesError: string | null;
  host: (AgentHost & { aptStale: boolean }) | null;
  hostError: string | null;
  apps: AppResult[];
  gigi: { version: string; latest: string | null; source: string | null; error: string | null; url: string | null };
};

export class Updates {
  private tagCache = new Map<string, { t: number; tags: string[] }>();
  private running: Promise<UpdatesResult> | null = null;

  constructor(
    private db: DB,
    private agent: Pick<AgentClient, 'json'>,
    private integrations: Pick<Integrations, 'list' | 'resource'>,
    private events: Pick<Events, 'add'>,
    private opts: { version: string; releaseRepo: string | null; stackRoots: string[]; fetch?: Fetch; now?: () => number },
  ) {}

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  last(): UpdatesResult | null {
    try {
      return JSON.parse(getSetting(this.db, 'updates.last') ?? 'null');
    } catch {
      return null;
    }
  }

  /** Un solo controllo alla volta: chiamate concorrenti attendono lo stesso risultato. */
  check() {
    this.running ??= this.run().finally(() => (this.running = null));
    return this.running;
  }

  private async tags(registry: string, repo: string) {
    const key = `${registry}/${repo}`;
    const c = this.tagCache.get(key);
    if (c && this.now() - c.t < 12 * HOUR) return c.tags;
    const tags = await listTags(this.opts.fetch ?? fetch, registry, repo);
    this.tagCache.set(key, { t: this.now(), tags });
    return tags;
  }

  private async run(): Promise<UpdatesResult> {
    const now = this.now();
    const [imgs, host] = await Promise.all([
      this.agent.json<AgentImage[]>('GET', '/v1/updates/images', 180_000).then((x) => ({ ok: x }), (e: Error) => ({ err: e.message })),
      this.agent.json<AgentHost>('GET', '/v1/updates/host').then((x) => ({ ok: x }), (e: Error) => ({ err: e.message })),
    ]);
    let images: ImageResult[] | null = null;
    if ('ok' in imgs) {
      images = [];
      for (const i of imgs.ok) {
        const managed = !!i.workingDir && this.opts.stackRoots.some((r) => i.workingDir!.startsWith(`${r}/`));
        let newerVersion: string | null = null;
        let versionError: string | null = null;
        const ref = parseRef(i.ref);
        if (i.status !== 'locale' && ref.tag && parseTag(ref.tag)) {
          try {
            newerVersion = newerTag(ref.tag, await this.tags(ref.registry, ref.repo));
          } catch (e) {
            versionError = (e as Error).message.slice(0, 160);
          }
        }
        images.push({ ...i, newerVersion, versionError, managedByGigi: managed });
      }
    }

    const apps: AppResult[] = [];
    const list = this.integrations.list();
    const jf = list.find((x) => x.type === 'jellyfin' && x.enabled);
    if (jf) {
      try {
        const o = (await this.integrations.resource(jf.id, 'overview', new URLSearchParams(), 0)) as { version?: string; updateAvailable?: boolean };
        apps.push({ name: 'Jellyfin', status: o.updateAvailable ? 'disponibile' : 'aggiornato', current: o.version ?? null, latest: null, detail: o.updateAvailable ? 'Jellyfin segnala una versione più recente' : null });
      } catch (e) {
        apps.push({ name: 'Jellyfin', status: 'errore', current: null, latest: null, detail: (e as Error).message.slice(0, 160) });
      }
    } else apps.push({ name: 'Jellyfin', status: 'non configurato', current: null, latest: null, detail: null });
    const ha = list.find((x) => x.type === 'homeassistant' && x.enabled);
    if (ha) {
      try {
        const u = (await this.integrations.resource(ha.id, 'updates', new URLSearchParams(), 0)) as { entity: string; title: string; installed: string | null; latest: string | null }[];
        if (!u.length) apps.push({ name: 'Home Assistant', status: 'aggiornato', current: null, latest: null, detail: null });
        for (const x of u) apps.push({ name: `Home Assistant · ${x.title}`, status: 'disponibile', current: x.installed, latest: x.latest, detail: x.entity });
      } catch (e) {
        apps.push({ name: 'Home Assistant', status: 'errore', current: null, latest: null, detail: (e as Error).message.slice(0, 160) });
      }
    } else apps.push({ name: 'Home Assistant', status: 'non configurato', current: null, latest: null, detail: null });

    const gigi: UpdatesResult['gigi'] = { version: this.opts.version, latest: null, source: this.opts.releaseRepo, error: null, url: null };
    if (this.opts.releaseRepo) {
      try {
        Object.assign(gigi, await latestGigi(this.opts.fetch ?? fetch, this.opts.releaseRepo));
      } catch (e) {
        gigi.error = (e as Error).message.slice(0, 160);
      }
    }

    const hostOk = 'ok' in host ? host.ok : null;
    const result: UpdatesResult = {
      checkedAt: now,
      images,
      imagesError: 'err' in imgs ? imgs.err : null,
      // Indici di apt fermi da più di 2 giorni nonostante i tentativi: di solito una sorgente non risponde
      host: hostOk ? { ...hostOk, aptStale: !!hostOk.apt.lastSuccess && !!hostOk.apt.lastUpdate && hostOk.apt.lastUpdate - hostOk.apt.lastSuccess > 48 * HOUR } : null,
      hostError: 'err' in host ? host.err : null,
      apps,
      gigi,
    };
    setSetting(this.db, 'updates.last', JSON.stringify(result));
    this.notify(result);
    return result;
  }

  /** Un evento per ogni novità (stessa chiave = nessuna ripetizione), sorgente «aggiornamenti». */
  private notify(r: UpdatesResult) {
    const found: [key: string, level: 'info' | 'warning', title: string, details: string | null][] = [];
    for (const i of r.images ?? []) {
      if (i.status === 'disponibile') found.push([`img:${i.ref}:${i.containers.join(',')}`, 'info', `Nuova immagine per ${i.containers.join(', ')} (${i.ref})`, null]);
      if (i.newerVersion) found.push([`ver:${i.ref}:${i.newerVersion}`, 'info', `Nuova versione per ${i.containers.join(', ')}: ${parseRef(i.ref).tag} → ${i.newerVersion}`, i.ref]);
    }
    const h = r.host;
    if (h?.packages?.upgradable) found.push([`apt:${h.packages.upgradable}:${h.packages.security}`, h.packages.security ? 'warning' : 'info', `Aggiornamenti di sistema: ${h.packages.upgradable} pacchetti${h.packages.security ? ` (${h.packages.security} di sicurezza)` : ''}`, null]);
    if (h?.kernel.rebootNeeded) found.push([`reboot:${h.kernel.newest}`, 'warning', `Riavvio necessario per il kernel ${h.kernel.newest}`, `In uso: ${h.kernel.running}`]);
    if (h?.aptStale) found.push([`aptstale:${h.apt.lastSuccess}`, 'warning', 'Gli indici dei pacchetti non si aggiornano', 'Prova «sudo apt update» per vedere quale sorgente non risponde']);
    for (const a of r.apps) if (a.status === 'disponibile') found.push([`app:${a.name}:${a.latest ?? ''}`, 'info', `${a.name}: aggiornamento disponibile${a.latest ? ` (${a.current ?? '?'} → ${a.latest})` : ''}`, null]);
    if (r.gigi.latest && compareVersions(r.gigi.latest, r.gigi.version) > 0) found.push([`gigi:${r.gigi.latest}`, 'info', `GIGI OS ${r.gigi.latest} disponibile`, `In uso: ${r.gigi.version}. Per aggiornare, nella cartella di GIGI OS sul server: sudo ./update.sh`]);
    // La deduplicazione degli eventi dura 30 minuti: qui si ricorda ciò che è già stato segnalato
    let seen: string[] = [];
    try {
      seen = JSON.parse(getSetting(this.db, 'updates.notified') ?? '[]');
    } catch {}
    const known = new Set(seen);
    const fresh = found.filter(([key]) => !known.has(key));
    for (const [key, level, title, details] of fresh) this.events.add(level, 'aggiornamenti', title, details, `upd:${key}`);
    // Si conservano solo le chiavi ancora valide: un aggiornamento applicato e poi ricomparso verrà segnalato di nuovo
    // Le sezioni che questa volta non hanno risposto mantengono le chiavi precedenti (niente doppie segnalazioni dopo un errore)
    const keep = seen.filter(
      (k) =>
        (r.images === null && /^(img|ver):/.test(k)) ||
        (r.host === null && /^(apt|reboot|aptstale):/.test(k)) ||
        (k.startsWith('app:') && r.apps.some((a) => a.status === 'errore' && k.startsWith(`app:${a.name}`.split(' · ')[0]))) ||
        (k.startsWith('gigi:') && !!r.gigi.error),
    );
    setSetting(this.db, 'updates.notified', JSON.stringify([...new Set([...found.map(([k]) => k), ...keep])].slice(0, 500)));
  }

  /** Riepilogo breve per il digest. */
  summary(): string | null {
    const r = this.last();
    if (!r) return null;
    const parts: string[] = [];
    const imgs = (r.images ?? []).filter((i) => i.status === 'disponibile').length;
    const vers = (r.images ?? []).filter((i) => i.newerVersion).length;
    if (imgs) parts.push(`${imgs} immagini nuove`);
    if (vers) parts.push(`${vers} versioni nuove`);
    if (r.host?.packages?.upgradable) parts.push(`${r.host.packages.upgradable} pacchetti di sistema${r.host.packages.security ? ` (${r.host.packages.security} di sicurezza)` : ''}`);
    if (r.host?.kernel.rebootNeeded) parts.push('riavvio necessario');
    const apps = r.apps.filter((a) => a.status === 'disponibile').length;
    if (apps) parts.push(`${apps} app`);
    if (r.gigi.latest && compareVersions(r.gigi.latest, r.gigi.version) > 0) parts.push(`GIGI OS ${r.gigi.latest}`);
    return parts.length ? `⬆️ Aggiornamenti: ${parts.join(', ')} (dettagli in GIGI OS → Aggiornamenti)` : '⬆️ Tutto aggiornato';
  }

  start(warn: (m: string, e?: object) => void) {
    const run = () => void this.check().catch((e) => warn('controllo aggiornamenti non riuscito', { err: (e as Error).message }));
    setTimeout(run, 2 * 60_000).unref();
    setInterval(run, 12 * HOUR).unref();
  }
}

export function registerUpdates(app: FastifyInstance, u: Updates, audit: Audit, viewer: object, admin: object) {
  app.get('/api/v1/updates', viewer, async () => u.last());
  app.post('/api/v1/updates/check', { ...admin, config: { rateLimit: { max: 4, timeWindow: '10 minutes' } } }, async (req) => {
    const r = await u.check();
    audit.log(req, 'updates.check', 'ok', null, { immagini: r.images?.length ?? 0 });
    return r;
  });
}
