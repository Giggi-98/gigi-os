// Automazioni: regole evento → notifica su canali (Home Assistant, ntfy, Telegram, webhook).
// I segreti dei canali sono cifrati nel vault. Ogni invio ha timeout e viene registrato nello storico.
import { lookup } from 'node:dns/promises';
import type { BlockList } from 'node:net';
import { isIP } from 'node:net';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getSetting, setSetting, type DB } from './db.js';
import type { Events, Level } from './events.js';
import type { Integrations } from './integrations.js';
import { newId, type Audit } from './security.js';
import { safeFetch, validateUrl, TargetError } from './ssrf.js';
import type { Vault } from './vault.js';

export const SOURCES = ['docker', 'sistema', 'rete', 'integrazioni', 'media', 'download', 'backup', 'sicurezza', 'aggiornamenti', 'automazioni'] as const;
const LEVELS: Level[] = ['info', 'warning', 'error'];

type ChannelRow = { id: string; type: string; name: string; config: string; secret_enc: string | null; enabled: number; created_at: number; updated_at: number };
type RuleRow = {
  id: string;
  name: string;
  enabled: number;
  sources: string;
  min_level: Level;
  match_text: string | null;
  channels: string;
  throttle_min: number;
  quiet_from: string | null;
  quiet_to: string | null;
};
export type EventLike = { level: Level; source: string; title: string; details?: string | null };

const PRIVATE = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '169.254.0.0/16', '100.64.0.0/10', '0.0.0.0/8', '::1/128', 'fc00::/7', 'fe80::/10'];

/** Destinazioni di notifica: Internet pubblico consentito; indirizzi privati solo se nelle reti LAN autorizzate. */
export async function notifyFetch(allowedLan: BlockList, privateList: BlockList, url: string, init: RequestInit & { timeoutMs?: number }) {
  const u = validateUrl(url);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
  for (const a of addrs) {
    const fam = a.family === 6 ? 'ipv6' : 'ipv4';
    if (privateList.check(a.address, fam) && !allowedLan.check(a.address, fam)) throw new TargetError(`Destinazione ${a.address} non consentita`, 'forbidden_target');
  }
  const res = await fetch(u, { ...init, redirect: 'manual', signal: AbortSignal.timeout(init.timeoutMs ?? 10_000) });
  const text = await res.text();
  if (text.length > 2 * 1024 * 1024) throw new Error('Risposta troppo grande');
  // Solo il messaggio d'errore viene accorciato: il corpo completo serve a chi deve interpretarlo (es. JSON di Telegram)
  if (!res.ok) throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
  return text;
}

const channelSchema = z.object({
  type: z.enum(['homeassistant', 'ntfy', 'telegram', 'webhook']),
  name: z.string().trim().min(1).max(60),
  enabled: z.boolean().optional(),
  config: z.record(z.string().max(500)).default({}),
  secret: z.record(z.string().max(500)).optional(),
});
const ruleSchema = z.object({
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean().optional(),
  sources: z.array(z.enum(SOURCES)).max(SOURCES.length),
  minLevel: z.enum(['info', 'warning', 'error']),
  matchText: z.string().trim().max(100).nullable().optional(),
  channels: z.array(z.string().uuid()).max(10),
  throttleMin: z.number().int().min(0).max(1440),
  quietFrom: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  quietTo: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
});

const SECRET_KEYS: Record<string, string[]> = { homeassistant: [], ntfy: ['token'], telegram: ['botToken'], webhook: ['authHeader'] };

export type TelegramChat = { id: string; type: string; name: string; lastSeen: number };

export class Automations {
  private privateList: BlockList;
  /** Indirizzo delle API di Telegram (sostituibile nei test con un server locale). */
  telegramBase = 'https://api.telegram.org';
  /** Con il bot interattivo attivo su quel token, getUpdates è suo: il rilevamento del Chat ID usa le chat che ha già visto. */
  telegramChatsFromBot: ((token: string) => TelegramChat[] | null) | null = null;

  constructor(
    private db: DB,
    private vault: Vault,
    private integrations: Integrations,
    private allowedLan: BlockList,
    makeBlockList: (c: string[]) => BlockList,
    private log: (msg: string, extra?: object) => void,
  ) {
    this.privateList = makeBlockList(PRIVATE);
  }

  /**
   * Richiesta in uscita dei flussi (D-041): Internet pubblico e reti LAN autorizzate, niente redirect, risposta
   * restituita anche con stato d'errore (lo interpreta il blocco).
   */
  async fetchOut(url: string, init: RequestInit & { timeoutMs?: number }) {
    const u = validateUrl(url);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
    for (const a of addrs) {
      const fam = a.family === 6 ? 'ipv6' : 'ipv4';
      if (this.privateList.check(a.address, fam) && !this.allowedLan.check(a.address, fam)) throw new TargetError(`Destinazione ${a.address} non consentita`, 'forbidden_target');
    }
    const res = await fetch(u, { ...init, redirect: 'manual', signal: AbortSignal.timeout(init.timeoutMs ?? 15_000) });
    const text = await res.text();
    if (text.length > 4 * 1024 * 1024) throw new Error('Risposta troppo grande');
    return { status: res.status, text, type: res.headers.get('content-type') };
  }

  // ───────── canali ─────────
  channelView(r: ChannelRow) {
    let secretFields: string[] = [];
    if (r.secret_enc) {
      try {
        secretFields = Object.keys(JSON.parse(this.vault.decrypt(r.secret_enc, `channel:${r.id}`)));
      } catch {}
    }
    return { id: r.id, type: r.type, name: r.name, config: JSON.parse(r.config) as Record<string, string>, secretFields, enabled: !!r.enabled };
  }
  channels() {
    return (this.db.prepare('SELECT * FROM notify_channels ORDER BY created_at').all() as ChannelRow[]).map((r) => this.channelView(r));
  }
  private channelRow(id: string) {
    const r = this.db.prepare('SELECT * FROM notify_channels WHERE id = ?').get(id) as ChannelRow | undefined;
    if (!r) throw Object.assign(new Error('Canale non trovato'), { statusCode: 404 });
    return r;
  }
  private validateChannel(input: z.infer<typeof channelSchema>, existing?: Record<string, string>) {
    const c = input.config;
    const secret: Record<string, string> = {};
    for (const k of SECRET_KEYS[input.type]) {
      const v = input.secret?.[k] || existing?.[k];
      if (v) secret[k] = v;
    }
    const config: Record<string, string> = {};
    if (input.type === 'homeassistant') {
      if (!/^notify\.[a-z0-9_]+$/.test(c.service ?? '')) throw Object.assign(new Error('Servizio HA non valido (es. notify.mobile_app_telefono)'), { statusCode: 400 });
      config.service = c.service;
    } else if (input.type === 'ntfy') {
      validateUrl(c.server || 'https://ntfy.sh');
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(c.topic ?? '')) throw Object.assign(new Error('Topic ntfy non valido'), { statusCode: 400 });
      config.server = (c.server || 'https://ntfy.sh').replace(/\/+$/, '');
      config.topic = c.topic;
    } else if (input.type === 'telegram') {
      if (!/^-?\d{1,20}$/.test(c.chatId ?? '')) throw Object.assign(new Error('Chat ID Telegram non valido'), { statusCode: 400 });
      if (!secret.botToken || !/^\d+:[A-Za-z0-9_-]{20,}$/.test(secret.botToken)) throw Object.assign(new Error('Token del bot Telegram non valido'), { statusCode: 400 });
      config.chatId = c.chatId;
    } else {
      validateUrl(c.url ?? '');
      config.url = c.url;
    }
    return { config, secret };
  }
  createChannel(input: z.infer<typeof channelSchema>) {
    const { config, secret } = this.validateChannel(input);
    const id = newId();
    const now = Date.now();
    this.db
      .prepare('INSERT INTO notify_channels (id, type, name, config, secret_enc, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, input.type, input.name, JSON.stringify(config), Object.keys(secret).length ? this.vault.encrypt(JSON.stringify(secret), `channel:${id}`) : null, input.enabled === false ? 0 : 1, now, now);
    return id;
  }
  updateChannel(id: string, input: z.infer<typeof channelSchema>) {
    const r = this.channelRow(id);
    if (r.type !== input.type) throw Object.assign(new Error('Il tipo non può cambiare'), { statusCode: 400 });
    const existing = r.secret_enc ? (JSON.parse(this.vault.decrypt(r.secret_enc, `channel:${id}`)) as Record<string, string>) : undefined;
    const { config, secret } = this.validateChannel(input, existing);
    this.db
      .prepare('UPDATE notify_channels SET name=?, config=?, secret_enc=?, enabled=?, updated_at=? WHERE id=?')
      .run(input.name, JSON.stringify(config), Object.keys(secret).length ? this.vault.encrypt(JSON.stringify(secret), `channel:${id}`) : null, input.enabled === false ? 0 : 1, Date.now(), id);
  }
  deleteChannel(id: string) {
    this.channelRow(id);
    this.db.prepare('DELETE FROM notify_channels WHERE id = ?').run(id);
    this.pruneDanglingChannels();
  }

  /** Toglie dalle regole i riferimenti a canali che non esistono più. Ritorna il numero di regole corrette. */
  pruneDanglingChannels() {
    const known = new Set((this.db.prepare('SELECT id FROM notify_channels').all() as { id: string }[]).map((r) => r.id));
    let fixed = 0;
    for (const r of this.db.prepare('SELECT id, channels FROM automation_rules').all() as { id: string; channels: string }[]) {
      const list = JSON.parse(r.channels) as string[];
      const clean = list.filter((c) => known.has(c));
      if (clean.length !== list.length) {
        this.db.prepare('UPDATE automation_rules SET channels = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(clean), Date.now(), r.id);
        fixed++;
      }
    }
    return fixed;
  }

  /** Token del bot di un canale Telegram (resta nel processo: mai restituito al browser). */
  telegramToken(channelId: string): string | null {
    const r = this.db.prepare("SELECT * FROM notify_channels WHERE id = ? AND type = 'telegram'").get(channelId) as ChannelRow | undefined;
    if (!r?.secret_enc) return null;
    return (JSON.parse(this.vault.decrypt(r.secret_enc, `channel:${r.id}`)) as Record<string, string>).botToken ?? null;
  }

  /** Chiamata alle API del bot; il token non compare mai nei messaggi d'errore. */
  async telegramCall<T = unknown>(token: string, method: string, body?: object, timeoutMs?: number): Promise<T> {
    try {
      const txt = await notifyFetch(this.allowedLan, this.privateList, `${this.telegramBase}/bot${token}/${method}`, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        timeoutMs,
      });
      const j = JSON.parse(txt) as { ok: boolean; result: T; description?: string };
      if (!j.ok) throw new Error(j.description ?? 'risposta non valida');
      return j.result;
    } catch (e) {
      throw new Error((e as Error).message.replaceAll(token, '•••'));
    }
  }

  /** Invio con registrazione nello storico notifiche (usato da digest e bot, fuori dalle regole). */
  async deliver(channelId: string, title: string, body: string, level: Level, label: string) {
    try {
      await this.send(channelId, title, body, level);
      this.record(null, channelId, title, 'sent', undefined, label);
    } catch (e) {
      this.record(null, channelId, title, 'failed', (e as Error).message.slice(0, 300), label);
      throw e;
    }
  }

  async send(channelId: string, title: string, body: string, level: Level) {
    const r = this.channelRow(channelId);
    const cfg = JSON.parse(r.config) as Record<string, string>;
    const secret = r.secret_enc ? (JSON.parse(this.vault.decrypt(r.secret_enc, `channel:${r.id}`)) as Record<string, string>) : {};
    const icon = level === 'error' ? '🔴' : level === 'warning' ? '🟠' : '🟢';
    if (r.type === 'homeassistant') {
      const ha = this.integrations.list().find((i) => i.type === 'homeassistant' && i.enabled);
      if (!ha) throw new Error('Integrazione Home Assistant non configurata');
      const { row, ctx } = this.integrations.contextFor(ha.id);
      const res = await safeFetch(this.allowedLan, `${row.base_url}/api/services/${cfg.service.replace('.', '/')}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ctx.secret.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: `GIGI OS · ${title}`, message: body || title, data: { tag: 'gigi-os', group: 'gigi-os' } }),
      });
      if (res.status >= 400) throw new Error(`Home Assistant: HTTP ${res.status}`);
    } else if (r.type === 'ntfy') {
      // Pubblicazione JSON: supporta UTF-8 in titolo e messaggio (gli header HTTP no)
      await notifyFetch(this.allowedLan, this.privateList, cfg.server, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(secret.token ? { Authorization: `Bearer ${secret.token}` } : {}) },
        body: JSON.stringify({
          topic: cfg.topic,
          title: `GIGI OS · ${title}`,
          message: body || title,
          priority: level === 'error' ? 5 : level === 'warning' ? 4 : 3,
          tags: [level === 'error' ? 'rotating_light' : level === 'warning' ? 'warning' : 'white_check_mark'],
        }),
      });
    } else if (r.type === 'telegram') {
      await notifyFetch(this.allowedLan, this.privateList, `${this.telegramBase}/bot${secret.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: cfg.chatId, text: `${icon} GIGI OS · ${title}${body ? `\n${body}` : ''}`, disable_web_page_preview: true }),
      }).catch((e: Error) => {
        // Non far mai trapelare il token del bot negli errori
        throw new Error(e.message.replaceAll(secret.botToken, '•••'));
      });
    } else {
      await notifyFetch(this.allowedLan, this.privateList, cfg.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(secret.authHeader ? { Authorization: secret.authHeader } : {}) },
        body: JSON.stringify({ source: 'gigi-os', level, title, details: body || null, ts: new Date().toISOString() }),
      });
    }
  }

  // ───────── regole ─────────
  ruleView(r: RuleRow) {
    return {
      id: r.id,
      name: r.name,
      enabled: !!r.enabled,
      sources: JSON.parse(r.sources) as string[],
      minLevel: r.min_level,
      matchText: r.match_text,
      channels: JSON.parse(r.channels) as string[],
      throttleMin: r.throttle_min,
      quietFrom: r.quiet_from,
      quietTo: r.quiet_to,
    };
  }
  rules() {
    return (this.db.prepare('SELECT * FROM automation_rules ORDER BY created_at').all() as RuleRow[]).map((r) => this.ruleView(r));
  }
  saveRule(input: z.infer<typeof ruleSchema>, id?: string) {
    // Canali eliminati nel frattempo: si scartano invece di bloccare il salvataggio della regola
    const known = new Set(this.channels().map((c) => c.id));
    input = { ...input, channels: input.channels.filter((c) => known.has(c)) };
    const now = Date.now();
    const vals = [
      input.name,
      input.enabled === false ? 0 : 1,
      JSON.stringify(input.sources),
      input.minLevel,
      input.matchText || null,
      JSON.stringify(input.channels),
      input.throttleMin,
      input.quietFrom || null,
      input.quietTo || null,
    ];
    if (id) {
      const r = this.db.prepare('UPDATE automation_rules SET name=?, enabled=?, sources=?, min_level=?, match_text=?, channels=?, throttle_min=?, quiet_from=?, quiet_to=?, updated_at=? WHERE id=?').run(...vals, now, id);
      if (!r.changes) throw Object.assign(new Error('Regola non trovata'), { statusCode: 404 });
      return id;
    }
    const nid = newId();
    this.db
      .prepare('INSERT INTO automation_rules (name, enabled, sources, min_level, match_text, channels, throttle_min, quiet_from, quiet_to, created_at, updated_at, id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(...vals, now, now, nid);
    return nid;
  }
  deleteRule(id: string) {
    this.db.prepare('DELETE FROM automation_rules WHERE id = ?').run(id);
  }

  private inQuiet(from: string | null, to: string | null, d = new Date()) {
    if (!from || !to) return false;
    const m = d.getHours() * 60 + d.getMinutes();
    const [fh, fm] = from.split(':').map(Number);
    const [th, tm] = to.split(':').map(Number);
    const a = fh * 60 + fm;
    const b = th * 60 + tm;
    return a <= b ? m >= a && m < b : m >= a || m < b;
  }

  private record(rule: RuleRow | null, channel: string | null, title: string, status: 'sent' | 'failed' | 'throttled' | 'quiet', error?: string, label?: string) {
    this.db
      .prepare('INSERT INTO notifications (ts, rule_id, rule_name, channel, title, status, error) VALUES (?,?,?,?,?,?,?)')
      .run(Date.now(), rule?.id ?? null, rule?.name ?? label ?? null, channel, title, status, error ?? null);
  }

  /** Chiamato a ogni nuovo evento: valuta le regole e invia (in background, non blocca chi ha generato l'evento). */
  onEvent(e: EventLike) {
    const rules = this.db.prepare('SELECT * FROM automation_rules WHERE enabled = 1').all() as RuleRow[];
    for (const r of rules) {
      const sources = JSON.parse(r.sources) as string[];
      if (sources.length && !sources.includes(e.source)) continue;
      if (LEVELS.indexOf(e.level) < LEVELS.indexOf(r.min_level)) continue;
      if (r.match_text && !`${e.title} ${e.details ?? ''}`.toLowerCase().includes(r.match_text.toLowerCase())) continue;
      if (this.inQuiet(r.quiet_from, r.quiet_to) && e.level !== 'error') {
        this.record(r, null, e.title, 'quiet');
        continue;
      }
      if (r.throttle_min > 0) {
        const recent = this.db
          .prepare("SELECT 1 FROM notifications WHERE rule_id = ? AND title = ? AND status = 'sent' AND ts > ?")
          .get(r.id, e.title, Date.now() - r.throttle_min * 60_000);
        if (recent) {
          this.record(r, null, e.title, 'throttled');
          continue;
        }
      }
      for (const ch of JSON.parse(r.channels) as string[]) {
        void this.send(ch, e.title, e.details ?? '', e.level)
          .then(() => this.record(r, ch, e.title, 'sent'))
          .catch((err: Error) => {
            this.record(r, ch, e.title, 'failed', err.message.slice(0, 300));
            this.log('notifica non inviata', { rule: r.name, err: err.message });
          });
      }
    }
  }

  /**
   * Rilevamento del Chat ID Telegram: legge le conversazioni recenti del bot (getUpdates).
   * L'utente deve aver scritto almeno un messaggio al bot (anche /start).
   */
  async telegramDetect(botToken: string | undefined, channelId?: string) {
    let token = botToken?.trim();
    if (!token && channelId) {
      const r = this.channelRow(channelId);
      token = r.secret_enc ? (JSON.parse(this.vault.decrypt(r.secret_enc, `channel:${r.id}`)) as Record<string, string>).botToken : undefined;
    }
    if (!token || !/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw Object.assign(new Error('Token del bot non valido (formato 123456:ABC…)'), { statusCode: 400 });
    const call = async (method: string) => {
      try {
        const txt = await notifyFetch(this.allowedLan, this.privateList, `${this.telegramBase}/bot${token}/${method}`, { method: 'GET' });
        return JSON.parse(txt) as { ok: boolean; result: unknown; description?: string };
      } catch (e) {
        const msg = (e as Error).message.replaceAll(token!, '•••');
        throw Object.assign(new Error(/401|404|Unauthorized|Not Found/i.test(msg) ? 'Token rifiutato da Telegram: controlla di averlo copiato per intero da @BotFather' : /409|webhook/i.test(msg) ? 'Il bot ha un webhook attivo: getUpdates non è disponibile' : `Telegram: ${msg}`), { statusCode: 502 });
      }
    };
    const me = (await call('getMe')).result as { username: string; first_name: string };
    const fromBot = this.telegramChatsFromBot?.(token);
    if (fromBot) return { bot: `@${me.username}`, botName: me.first_name, chats: fromBot };
    const updates = (await call('getUpdates?limit=100&allowed_updates=%5B%22message%22%2C%22channel_post%22%2C%22my_chat_member%22%5D')).result as {
      message?: { chat: Chat; date: number };
      channel_post?: { chat: Chat; date: number };
      my_chat_member?: { chat: Chat; date: number };
    }[];
    type Chat = { id: number; type: string; title?: string; first_name?: string; last_name?: string; username?: string };
    const chats = new Map<number, { id: string; type: string; name: string; lastSeen: number }>();
    for (const u of updates) {
      const x = u.message ?? u.channel_post ?? u.my_chat_member;
      if (!x) continue;
      const c = x.chat;
      const name = c.title ?? ([c.first_name, c.last_name].filter(Boolean).join(' ') || (c.username ? `@${c.username}` : String(c.id)));
      chats.set(c.id, { id: String(c.id), type: c.type === 'private' ? 'privata' : c.type === 'channel' ? 'canale' : 'gruppo', name, lastSeen: x.date * 1000 });
    }
    return { bot: `@${me.username}`, botName: me.first_name, chats: [...chats.values()].sort((a, b) => b.lastSeen - a.lastSeen) };
  }

  history(limit = 100) {
    return this.db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT ?').all(Math.min(limit, 500));
  }

  /**
   * Regole suggerite arrivate con versioni successive: create una volta sola, disattivate. Se l'utente le elimina
   * non ricompaiono (flag in settings).
   */
  ensurePresets() {
    const presets: [string, string, (typeof SOURCES)[number][], Level, string | null, number][] = [['updates', 'Aggiornamenti disponibili', ['aggiornamenti'], 'info', null, 1440]];
    for (const [flag, name, sources, minLevel, matchText, throttleMin] of presets) {
      const key = `rules.preset.${flag}`;
      if (getSetting(this.db, key)) continue;
      if (!this.rules().some((r) => r.name === name)) this.saveRule({ name, sources, minLevel, matchText, channels: [], throttleMin, enabled: false });
      setSetting(this.db, key, '1');
    }
  }

  /** Regole suggerite, create disattivate e senza canale finché l'utente non le collega. */
  seedRules() {
    this.pruneDanglingChannels();
    if ((this.db.prepare('SELECT COUNT(*) AS n FROM automation_rules').get() as { n: number }).n > 0) return;
    const presets: [string, string[], Level, string | null, number][] = [
      ['Problemi ai container', ['docker'], 'warning', null, 30],
      ['Disco quasi pieno', ['sistema'], 'warning', 'disco', 360],
      ['Servizio offline o accesso negato', ['integrazioni'], 'warning', null, 60],
      ['Download completato', ['download'], 'info', null, 0],
      ['Nuovo contenuto in libreria', ['media'], 'info', 'disponibile in jellyfin', 0],
      ['Contenuti da rivedere', ['media'], 'info', 'da rivedere', 120],
      ['Backup non riuscito', ['backup'], 'error', null, 60],
    ];
    for (const [name, sources, minLevel, matchText, throttleMin] of presets) {
      this.saveRule({ name, sources: sources as (typeof SOURCES)[number][], minLevel, matchText, channels: [], throttleMin, enabled: false });
    }
  }
}

/** Rileva i download appena completati in qBittorrent e genera l'evento «download». */
export function watchDownloads(integrations: Integrations, events: Events, getSeen: () => string[], setSeen: (h: string[]) => void) {
  let seen: Set<string> | null = null;
  return async () => {
    const qb = integrations.list().find((i) => i.type === 'qbittorrent' && i.enabled && i.status === 'online');
    if (!qb) return;
    const list = (await integrations.resource(qb.id, 'torrents', new URLSearchParams(), 0)) as { hash: string; name: string; complete: boolean; size: number; category: string }[];
    const done = list.filter((t) => t.complete);
    if (seen === null) {
      const stored = getSeen();
      // Primo avvio: tutto ciò che è già completo è "visto", nessuna notifica retroattiva
      seen = new Set(stored.length ? stored : done.map((t) => t.hash));
      if (!stored.length) setSeen([...seen]);
    }
    let changed = false;
    for (const t of done) {
      if (seen.has(t.hash)) continue;
      seen.add(t.hash);
      changed = true;
      events.add('info', 'download', `Download completato: ${t.name}`, t.category ? `Categoria ${t.category}` : null, `dl:${t.hash}`);
    }
    if (changed) setSeen([...seen].slice(-2000));
  };
}

export function registerAutomations(app: FastifyInstance, a: Automations, events: Events, audit: Audit, viewer: object, admin: object) {
  app.get('/api/v1/automations/channels', admin, async () => a.channels());
  app.post('/api/v1/automations/channels', admin, async (req) => {
    const b = channelSchema.parse(req.body);
    const id = a.createChannel(b);
    audit.log(req, 'automation.channel.create', 'ok', `${b.type}:${b.name}`);
    return a.channels().find((c) => c.id === id);
  });
  app.put('/api/v1/automations/channels/:id', admin, async (req) => {
    const { id } = req.params as { id: string };
    const b = channelSchema.parse(req.body);
    a.updateChannel(z.string().uuid().parse(id), b);
    audit.log(req, 'automation.channel.update', 'ok', `${b.type}:${b.name}`);
    return a.channels().find((c) => c.id === id);
  });
  app.delete('/api/v1/automations/channels/:id', admin, async (req) => {
    const { id } = req.params as { id: string };
    a.deleteChannel(z.string().uuid().parse(id));
    audit.log(req, 'automation.channel.delete', 'ok', id);
    return { ok: true };
  });
  app.post('/api/v1/automations/channels/:id/test', admin, async (req: FastifyRequest, reply) => {
    const { id } = req.params as { id: string };
    try {
      await a.send(z.string().uuid().parse(id), 'Notifica di prova', 'Se la vedi, il canale funziona.', 'info');
      audit.log(req, 'automation.channel.test', 'ok', id);
      return { ok: true };
    } catch (e) {
      audit.log(req, 'automation.channel.test', 'error', id, { err: (e as Error).message });
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  app.post('/api/v1/automations/telegram/detect', admin, async (req, reply) => {
    const b = z.object({ botToken: z.string().max(200).optional(), channelId: z.string().uuid().optional() }).parse(req.body ?? {});
    try {
      return await a.telegramDetect(b.botToken, b.channelId);
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      // Messaggi già ripuliti dal token: si mostrano così come sono anche per gli errori di rete (502)
      return reply.code(err.statusCode ?? 502).send({ error: err.message });
    }
  });

  app.get('/api/v1/automations/rules', viewer, async () => a.rules());
  app.post('/api/v1/automations/rules', admin, async (req) => {
    const b = ruleSchema.parse(req.body);
    const id = a.saveRule(b);
    audit.log(req, 'automation.rule.create', 'ok', b.name);
    return a.rules().find((r) => r.id === id);
  });
  app.put('/api/v1/automations/rules/:id', admin, async (req) => {
    const { id } = req.params as { id: string };
    const b = ruleSchema.parse(req.body);
    a.saveRule(b, z.string().uuid().parse(id));
    audit.log(req, 'automation.rule.update', 'ok', b.name, { enabled: b.enabled });
    return a.rules().find((r) => r.id === id);
  });
  app.delete('/api/v1/automations/rules/:id', admin, async (req) => {
    const { id } = req.params as { id: string };
    a.deleteRule(z.string().uuid().parse(id));
    audit.log(req, 'automation.rule.delete', 'ok', id);
    return { ok: true };
  });
  app.get('/api/v1/automations/history', viewer, async (req) => a.history(Number((req.query as { limit?: string }).limit ?? 100) || 100));
  app.get('/api/v1/automations/sources', viewer, async () => SOURCES);
  void events;
}
