// Digest (D-031): riepilogo giornaliero e settimanale composto da storico metriche, eventi e stato attuale,
// inviato sui canali scelti. Testo semplice con emoji: va bene per Telegram, ntfy e Home Assistant.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AgentClient } from './agent.js';
import type { Automations } from './automations.js';
import { getSetting, setSetting, type DB } from './db.js';
import type { Integrations } from './integrations.js';
import type { MediaBridge } from './media.js';
import type { Forecast, Metrics } from './metrics.js';
import type { Audit } from './security.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** Se GIGI OS era spento all'ora prevista, il digest parte entro questo margine; oltre, si salta. */
const CATCH_UP = 3 * HOUR;
const MAX_CHARS = 3500;

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const digestSchema = z.object({
  daily: z.object({ enabled: z.boolean(), time }),
  weekly: z.object({ enabled: z.boolean(), day: z.number().int().min(0).max(6), time }),
  channels: z.array(z.string().uuid()).max(10),
});
export type DigestSettings = z.infer<typeof digestSchema>;
export type DigestKind = 'daily' | 'weekly';
const DEFAULTS: DigestSettings = { daily: { enabled: false, time: '08:00' }, weekly: { enabled: false, day: 1, time: '08:00' }, channels: [] };

/** Ultima occorrenza pianificata non successiva a `now` (ora locale del processo, vedi TZ in compose.yaml). */
export function lastScheduled(kind: DigestKind, s: DigestSettings, now: Date): Date {
  const [h, m] = (kind === 'daily' ? s.daily.time : s.weekly.time).split(':').map(Number);
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
  if (kind === 'daily') {
    if (d > now) d.setDate(d.getDate() - 1);
    return d;
  }
  let back = (d.getDay() - s.weekly.day + 7) % 7;
  if (back === 0 && d > now) back = 7;
  d.setDate(d.getDate() - back);
  return d;
}

/** Da inviare se l'ultima occorrenza è passata da meno di CATCH_UP e non è già stata inviata. */
export function isDue(kind: DigestKind, s: DigestSettings, now: Date, lastSent: number | null): boolean {
  if (!(kind === 'daily' ? s.daily.enabled : s.weekly.enabled)) return false;
  const at = lastScheduled(kind, s, now).getTime();
  return now.getTime() - at <= CATCH_UP && (lastSent === null || lastSent < at);
}

const GB = 1024 ** 3;
export const bytes = (n: number) => (n >= GB * 100 ? `${Math.round(n / GB)} GB` : n >= GB ? `${(n / GB).toFixed(1).replace('.', ',')} GB` : `${Math.round(n / 1024 ** 2)} MB`);
const pct = (n: number) => `${Math.round(n)}%`;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const nums = (xs: (number | null)[]) => xs.filter((x): x is number => x !== null);
const list = (xs: string[], max = 3) => (xs.length > max ? `${xs.slice(0, max).join(', ')} e altri ${xs.length - max}` : xs.join(', '));

export function forecastLine(f: Forecast): string {
  switch (f.status) {
    case 'insufficient':
      return 'previsione dopo 3 giorni di storico';
    case 'stable':
      return 'occupazione stabile';
    case 'shrinking':
      return `in calo (${bytes(-f.perDay)}/giorno)`;
    case 'growing':
      return f.days > 365 ? 'pieno tra oltre un anno' : `pieno tra circa ${f.days} giorni (+${bytes(f.perDay)}/giorno)`;
  }
}

type EventRow = { ts: number; level: string; source: string; title: string };

export class Digest {
  constructor(
    private db: DB,
    private automations: Pick<Automations, 'deliver' | 'channels'>,
    private metrics: Pick<Metrics, 'host' | 'containers' | 'disks'>,
    private agent: Pick<AgentClient, 'json'>,
    private integrations: Pick<Integrations, 'list'>,
    private media: Pick<MediaBridge, 'items'> | null,
    private now = () => new Date(),
    /** Riepilogo dell'ultimo controllo aggiornamenti (D-032), se disponibile. */
    private updates: { summary: () => string | null } | null = null,
  ) {}

  settings(): DigestSettings {
    try {
      return digestSchema.parse(JSON.parse(getSetting(this.db, 'digest') ?? 'null') ?? DEFAULTS);
    } catch {
      return DEFAULTS;
    }
  }

  setSettings(s: DigestSettings) {
    const known = new Set(this.automations.channels().map((c) => c.id));
    const clean = { ...s, channels: s.channels.filter((c) => known.has(c)) };
    setSetting(this.db, 'digest', JSON.stringify(clean));
    return clean;
  }

  lastSent(kind: DigestKind) {
    const v = getSetting(this.db, `digest.last.${kind}`);
    return v ? Number(v) : null;
  }

  private events(since: number) {
    return this.db.prepare('SELECT ts, level, source, title FROM events WHERE ts >= ? ORDER BY ts').all(since) as EventRow[];
  }

  async compose(kind: DigestKind): Promise<{ title: string; body: string }> {
    const now = this.now().getTime();
    const since = now - (kind === 'daily' ? DAY : 7 * DAY);
    const range = kind === 'daily' ? '24h' : '7d';
    const lines: string[] = [];
    const ev = this.events(since);
    const sys = await this.agent
      .json<{ hostname?: string; disks?: { label: string; total: number; free: number; used: number; ok: boolean }[] } | null>('GET', '/v1/system')
      .catch(() => null);

    // Risorse dallo storico (D-027)
    const h = this.metrics.host(range);
    const cpu = avg(nums(h.cpu));
    if (cpu === null) lines.push('🖥 Storico delle risorse non ancora disponibile');
    else {
      const peak = Math.max(...nums(h.cpuMax));
      const mem = avg(nums(h.mem));
      const temps = nums(h.temp);
      lines.push(`🖥 CPU media ${pct(cpu)} (picco ${pct(peak)}) · RAM media ${pct(mem ?? 0)}${temps.length ? ` · temperatura max ${Math.round(Math.max(...temps))} °C` : ''}`);
    }

    // Dischi: stato attuale + previsione
    const trend = new Map(this.metrics.disks().map((d) => [d.label, d]));
    for (const d of sys?.disks?.filter((x) => x.ok && x.total > 0) ?? []) {
      const t = trend.get(d.label);
      const week = kind === 'weekly' && t && t.points.length > 1 ? t.points[t.points.length - 1].used - (t.points.find((p) => p.t >= since)?.used ?? t.points[0].used) : null;
      const delta = week !== null && Math.abs(week) >= 0.1 * GB ? ` · ${week > 0 ? '+' : '−'}${bytes(Math.abs(week))} in 7 giorni` : '';
      lines.push(`💾 ${d.label}: ${pct((d.used / d.total) * 100)} usato, ${bytes(d.free)} liberi${delta}${t ? ` · ${forecastLine(t.forecast)}` : ''}`);
    }

    // Backup
    const backups = ev.filter((e) => e.source === 'backup');
    const lastBackup = backups[backups.length - 1];
    if (!lastBackup) lines.push(`🗄 Backup: nessuno nel periodo${kind === 'daily' ? ' (controlla Backup)' : ''}`);
    else if (lastBackup.level === 'error') lines.push(`⚠️ Backup non riuscito alle ${hm(lastBackup.ts)}: controlla la pagina Backup`);
    else lines.push(`🗄 ${kind === 'daily' ? lastBackup.title : `${backups.filter((b) => b.level !== 'error').length} backup riusciti, ultimo ${lastBackup.title.replace(/^Backup completato\s*/, '')}`}`);

    // Download e libreria
    const done = ev.filter((e) => e.source === 'download' && e.title.startsWith('Download completato: ')).map((e) => e.title.slice('Download completato: '.length));
    if (done.length) lines.push(`⬇️ Download completati: ${done.length} — ${list(done)}`);
    const added = ev.filter((e) => e.source === 'media' && /^Disponibile in Jellyfin/.test(e.title)).map((e) => e.title.replace(/^[^:]+:\s*/, ''));
    if (added.length) lines.push(`🎬 Nuovi in libreria: ${added.length} — ${list(added)}`);
    if (this.media) {
      const items = await this.media.items(500).catch(() => null);
      const pending = items?.filter((i) => ['review', 'conflict', 'ready'].includes(i.status)).length ?? 0;
      if (pending) lines.push(`🔎 Da rivedere nel motore media: ${pending}`);
    }

    // Container
    const containers = await this.agent.json<{ name: string; state: string; health: string | null }[]>('GET', '/v1/containers').catch(() => null);
    if (containers) {
      const running = containers.filter((c) => c.state === 'running');
      const bad = running.filter((c) => c.health === 'unhealthy').map((c) => c.name);
      const stopped = containers.filter((c) => c.state !== 'running').map((c) => c.name);
      lines.push(`🐳 Container: ${running.length}/${containers.length} attivi${bad.length ? ` · unhealthy: ${list(bad)}` : ''}${stopped.length ? ` · fermi: ${list(stopped)}` : ''}`);
    }
    const dockerIssues = ev.filter((e) => e.source === 'docker' && e.level !== 'info');
    if (dockerIssues.length) lines.push(`   ${dockerIssues.length} eventi Docker da guardare: ${list(distinct(dockerIssues.map((e) => e.title)))}`);
    if (kind === 'weekly') {
      const top = this.metrics.containers('7d', 'cpu', 3).ranking.slice(0, 3);
      if (top.length) lines.push(`🏆 Più impegnativi (CPU media): ${top.map((r) => `${r.name} ${r.cpuAvg.toLocaleString('it-IT')}%`).join(', ')}`);
      const ram = this.metrics.containers('7d', 'mem', 3).ranking.slice(0, 3);
      if (ram.length) lines.push(`🧠 RAM media: ${ram.map((r) => `${r.name} ${bytes(r.memAvg)}`).join(', ')}`);
    }

    const upd = this.updates?.summary();
    if (upd) lines.push(upd);

    // Integrazioni non raggiungibili ora
    const off = this.integrations.list().filter((i) => i.enabled && ['offline', 'error', 'unauthorized'].includes(i.status ?? '')).map((i) => i.name);
    if (off.length) lines.push(`🔌 Da controllare: ${list(off)}`);

    // Avvisi ed errori del periodo (esclusi quelli già riassunti sopra)
    const issues = ev.filter((e) => e.level !== 'info' && e.source !== 'docker' && e.source !== 'backup');
    const errors = issues.filter((e) => e.level === 'error').length;
    if (issues.length) lines.push(`⚠️ ${issues.length} avvisi${errors ? ` (${errors} errori)` : ''}: ${list(distinct(issues.map((e) => e.title)))}`);
    else lines.push('✅ Nessun avviso nel periodo');

    const host = sys?.hostname ?? 'GIGI OS';
    const title = kind === 'daily' ? `Buongiorno da ${host}: le ultime 24 ore` : `${host}: la settimana in breve`;
    let body = lines.join('\n');
    if (body.length > MAX_CHARS) body = `${body.slice(0, MAX_CHARS - 1)}…`;
    return { title, body };
  }

  /** Invia su tutti i canali configurati; restituisce gli esiti. Il «già inviato» si registra prima, così un errore non provoca ripetizioni. */
  async send(kind: DigestKind) {
    const s = this.settings();
    if (!s.channels.length) throw Object.assign(new Error('Nessun canale scelto per il digest'), { statusCode: 409 });
    const msg = await this.compose(kind);
    const results: { channel: string; ok: boolean; error?: string }[] = [];
    for (const ch of s.channels) {
      try {
        await this.automations.deliver(ch, msg.title, msg.body, 'info', kind === 'daily' ? 'Digest giornaliero' : 'Digest settimanale');
        results.push({ channel: ch, ok: true });
      } catch (e) {
        results.push({ channel: ch, ok: false, error: (e as Error).message });
      }
    }
    return results;
  }

  async tick(warn: (m: string, e?: object) => void) {
    const s = this.settings();
    const now = this.now();
    for (const kind of ['weekly', 'daily'] as const) {
      if (!isDue(kind, s, now, this.lastSent(kind)) || !s.channels.length) continue;
      setSetting(this.db, `digest.last.${kind}`, String(now.getTime()));
      // Il lunedì il settimanale sostituisce il giornaliero alla stessa ora: un messaggio solo
      if (kind === 'weekly' && s.daily.enabled && s.daily.time === s.weekly.time) setSetting(this.db, 'digest.last.daily', String(now.getTime()));
      await this.send(kind).catch((e) => warn('digest non inviato', { kind, err: (e as Error).message }));
    }
  }

  start(warn: (m: string, e?: object) => void) {
    setTimeout(() => void this.tick(warn), 20_000).unref();
    setInterval(() => void this.tick(warn), 60_000).unref();
  }
}

const distinct = (xs: string[]) => [...new Set(xs)];
const hm = (ts: number) => new Date(ts).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });

export function registerDigest(app: FastifyInstance, d: Digest, audit: Audit, admin: object) {
  app.get('/api/v1/digest', admin, async () => ({ settings: d.settings(), lastSent: { daily: d.lastSent('daily'), weekly: d.lastSent('weekly') } }));
  app.put('/api/v1/digest', admin, async (req) => {
    const s = d.setSettings(digestSchema.parse(req.body));
    audit.log(req, 'digest.settings', 'ok', null, s);
    return s;
  });
  app.get('/api/v1/digest/preview', admin, async (req) => d.compose(z.enum(['daily', 'weekly']).parse((req.query as { kind?: string }).kind ?? 'daily')));
  app.post('/api/v1/digest/send', { ...admin, config: { rateLimit: { max: 6, timeWindow: '10 minutes' } } }, async (req) => {
    const kind = z.object({ kind: z.enum(['daily', 'weekly']) }).parse(req.body).kind;
    const r = await d.send(kind);
    audit.log(req, 'digest.send', r.every((x) => x.ok) ? 'ok' : 'error', kind, r);
    return r;
  });
}
