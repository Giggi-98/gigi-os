// Bot Telegram interattivo (D-031): long polling di getUpdates (solo richieste in uscita, nessuna porta), comandi per gli
// account collegati a un utente GIGI OS con i permessi del suo ruolo, pulsanti con token monouso lato server e doppia
// conferma per gli import. Ogni azione passa dallo stesso codice dell'interfaccia e va nell'audit a nome dell'utente.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { AgentClient } from './agent.js';
import type { Automations, TelegramChat } from './automations.js';
import { getSetting, setSetting, type DB } from './db.js';
import { bytes, forecastLine, type Digest } from './digest.js';
import type { Events } from './events.js';
import type { Integrations } from './integrations.js';
import { MEDIA_ID, type MediaBridge, type MediaItem } from './media.js';
import type { Metrics } from './metrics.js';
import { atLeast, type Audit, type Role } from './security.js';

const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // senza 0/O/1/I: il codice si digita sul telefono
const ROLE_NAME: Record<Role, string> = { admin: 'amministratore', operator: 'operatore', viewer: 'sola lettura' };

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type From = { id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string };
type Chat = { id: number; type: string; title?: string; first_name?: string; last_name?: string; username?: string };
type Update = {
  update_id: number;
  message?: { message_id: number; from?: From; chat: Chat; date: number; text?: string };
  callback_query?: { id: string; from: From; data?: string; message?: { message_id: number; chat: Chat } };
};
type Button = { text: string; data: string };
export type Reply = { text: string; keyboard?: Button[][] };
type Who = { ok: true; tgId: string; userId: string; username: string; role: Role } | { ok: false; reason: string };
type Kind = 'tstop' | 'tstart' | 'mask' | 'mimport' | 'mignore' | 'cancel';
type Pending = { tgId: string; kind: Kind; payload: Record<string, string>; exp: number };
type Torrent = { hash: string; name: string; progress: number; dlspeed: number; eta: number; complete: boolean; stopped: boolean; state: string };

export type BotSettings = { channelId: string | null; enabled: boolean };
export type BotDeps = {
  db: DB;
  automations: Pick<Automations, 'telegramToken' | 'telegramCall' | 'channels'> & { telegramChatsFromBot: Automations['telegramChatsFromBot'] };
  audit: Audit;
  events: Pick<Events, 'add'>;
  integrations: Pick<Integrations, 'list' | 'resource' | 'action'>;
  agent: Pick<AgentClient, 'json'>;
  metrics: Pick<Metrics, 'disks'> | null;
  media: Pick<MediaBridge, 'items' | 'item' | 'act'> | null;
  digest: Pick<Digest, 'compose'> | null;
  /** Ruoli con 2FA obbligatoria e stato della 2FA dell'utente (D-029): il bot non scavalca l'obbligo. */
  mfa: { required: (r: Role) => boolean; enabled: (userId: string) => boolean } | null;
  warn: (m: string, e?: object) => void;
  now?: () => number;
};

const keyboard = (k?: Button[][]) => (k?.length ? { inline_keyboard: k.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) } : undefined);
const nameOf = (f: From) => [f.first_name, f.last_name].filter(Boolean).join(' ') || (f.username ? `@${f.username}` : String(f.id));
const rows = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const eta = (s: number) => (s <= 0 || s >= 8640000 ? '∞' : s < 3600 ? `${Math.max(1, Math.round(s / 60))} min` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`);
const shortDest = (p: string) => p.split('/').filter(Boolean).slice(-2).join('/');
const uptime = (s: number) => (s >= 86400 ? `${Math.floor(s / 86400)} g ${Math.floor((s % 86400) / 3600)} h` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`);

export class TelegramBot {
  private codes = new Map<string, { userId: string; exp: number }>();
  private pending = new Map<string, Pending>();
  private rate = new Map<string, number[]>();
  private failedLinks = new Map<string, number[]>();
  private nagged = new Map<string, number>();
  private chats = new Map<string, TelegramChat>();
  private me: { token: string; username: string } | null = null;
  private stopped = false;
  status: { state: 'spento' | 'attivo' | 'errore'; bot: string | null; lastOk: number | null; lastError: string | null } = { state: 'spento', bot: null, lastOk: null, lastError: null };

  constructor(private d: BotDeps) {
    d.automations.telegramChatsFromBot = (token) =>
      this.status.state === 'attivo' && this.token() === token ? [...this.chats.values()].sort((a, b) => b.lastSeen - a.lastSeen) : null;
  }

  private now() {
    return this.d.now?.() ?? Date.now();
  }

  settings(): BotSettings {
    try {
      const s = JSON.parse(getSetting(this.d.db, 'telegram.bot') ?? 'null') as BotSettings | null;
      return { channelId: s?.channelId ?? null, enabled: !!s?.enabled };
    } catch {
      return { channelId: null, enabled: false };
    }
  }

  setSettings(s: BotSettings) {
    if (s.channelId && !this.d.automations.channels().some((c) => c.id === s.channelId && c.type === 'telegram'))
      throw Object.assign(new Error('Scegli un canale Telegram esistente'), { statusCode: 400 });
    setSetting(this.d.db, 'telegram.bot', JSON.stringify(s));
    this.me = null;
    if (!s.enabled) this.status = { state: 'spento', bot: this.status.bot, lastOk: this.status.lastOk, lastError: null };
    return s;
  }

  private token() {
    const s = this.settings();
    return s.enabled && s.channelId ? this.d.automations.telegramToken(s.channelId) : null;
  }

  private call<T>(method: string, body?: object, timeoutMs?: number) {
    const t = this.token();
    if (!t) throw new Error('Bot non attivo');
    return this.d.automations.telegramCall<T>(t, method, body, timeoutMs);
  }

  /** Un giro di getUpdates (long polling). Restituisce il numero di aggiornamenti gestiti. */
  async tick(timeoutSec = 25): Promise<number> {
    const token = this.token();
    if (!token) {
      this.status.state = 'spento';
      return 0;
    }
    if (this.me?.token !== token) this.me = { token, username: (await this.call<{ username: string }>('getMe')).username };
    const offset = Number(getSetting(this.d.db, 'telegram.offset') ?? 0);
    const updates = await this.call<Update[]>('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] }, (timeoutSec + 10) * 1000);
    this.status = { state: 'attivo', bot: `@${this.me.username}`, lastOk: this.now(), lastError: null };
    for (const u of updates) {
      // L'offset avanza prima di gestire: un aggiornamento non viene mai rielaborato dopo un errore o un riavvio
      setSetting(this.d.db, 'telegram.offset', String(u.update_id + 1));
      try {
        await this.handle(u);
      } catch (e) {
        this.d.warn('bot Telegram: aggiornamento non gestito', { err: (e as Error).message });
      }
    }
    return updates.length;
  }

  start() {
    void (async () => {
      let backoff = 5000;
      while (!this.stopped) {
        if (!this.token()) {
          if (this.status.state !== 'spento') this.status.state = 'spento';
          await sleep(5000);
          continue;
        }
        try {
          await this.tick(25);
          backoff = 5000;
        } catch (e) {
          this.status = { ...this.status, state: 'errore', lastError: (e as Error).message.slice(0, 200) };
          this.d.warn('bot Telegram: errore', { err: this.status.lastError });
          await sleep(backoff);
          backoff = Math.min(backoff * 2, 300_000);
        }
      }
    })();
  }

  stop() {
    this.stopped = true;
  }

  // ───────── collegamento ─────────
  createCode(userId: string) {
    for (const [c, v] of this.codes) if (v.userId === userId || v.exp < this.now()) this.codes.delete(c);
    const bytesR = randomBytes(8);
    const code = Array.from(bytesR, (b) => B32[b % B32.length]).join('');
    const exp = this.now() + 10 * 60_000;
    this.codes.set(code, { userId, exp });
    return { code, expiresAt: exp, bot: this.status.bot };
  }

  links(userId?: string) {
    const sql = `SELECT l.tg_user_id AS tgUserId, l.tg_name AS name, l.created_at AS createdAt, l.last_used_at AS lastUsedAt, u.username
                 FROM telegram_links l JOIN users u ON u.id = l.user_id ${userId ? 'WHERE l.user_id = ?' : ''} ORDER BY l.created_at`;
    return (userId ? this.d.db.prepare(sql).all(userId) : this.d.db.prepare(sql).all()) as { tgUserId: string; name: string | null; createdAt: number; lastUsedAt: number | null; username: string }[];
  }

  unlink(tgUserId: string) {
    return this.d.db.prepare('DELETE FROM telegram_links WHERE tg_user_id = ?').run(tgUserId).changes > 0;
  }

  linkOwner(tgUserId: string) {
    return (this.d.db.prepare('SELECT user_id FROM telegram_links WHERE tg_user_id = ?').get(tgUserId) as { user_id: string } | undefined)?.user_id ?? null;
  }

  private whoIs(tgId: string): Who {
    const r = this.d.db
      .prepare('SELECT u.id, u.username, u.role, u.disabled FROM telegram_links l JOIN users u ON u.id = l.user_id WHERE l.tg_user_id = ?')
      .get(tgId) as { id: string; username: string; role: Role; disabled: number } | undefined;
    if (!r) return { ok: false, reason: 'Questo account Telegram non è collegato a GIGI OS.\nIn GIGI OS: Sicurezza → Il mio account → Telegram → «Collega», poi invia qui /collega CODICE.' };
    if (r.disabled) return { ok: false, reason: 'L’utente GIGI OS collegato è disabilitato.' };
    if (this.d.mfa?.required(r.role) && !this.d.mfa.enabled(r.id)) return { ok: false, reason: 'Prima configura la verifica in due passaggi in GIGI OS.' };
    return { ok: true, tgId, userId: r.id, username: r.username, role: r.role };
  }

  private fakeReq(who: { userId: string; username: string }) {
    return { user: { id: who.userId, username: who.username }, ip: 'telegram' } as unknown as FastifyRequest;
  }

  private link(tgId: string, chatId: string, name: string, raw: string): Reply {
    const now = this.now();
    const fails = (this.failedLinks.get(tgId) ?? []).filter((t) => t > now - 15 * 60_000);
    if (fails.length >= 5) return { text: 'Troppi tentativi. Riprova tra 15 minuti.' };
    const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const entry = this.codes.get(code);
    if (!entry || entry.exp < now) {
      this.failedLinks.set(tgId, [...fails, now]);
      return { text: 'Codice non valido o scaduto. Generane uno nuovo in GIGI OS (vale 10 minuti).' };
    }
    this.codes.delete(code);
    const u = this.d.db.prepare('SELECT id, username, role, disabled FROM users WHERE id = ?').get(entry.userId) as { id: string; username: string; role: Role; disabled: number } | undefined;
    if (!u || u.disabled) return { text: 'Utente non valido.' };
    if (this.d.mfa?.required(u.role) && !this.d.mfa.enabled(u.id)) return { text: 'Prima configura la verifica in due passaggi in GIGI OS.' };
    this.d.db
      .prepare('INSERT INTO telegram_links (tg_user_id, user_id, chat_id, tg_name, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (tg_user_id) DO UPDATE SET user_id = excluded.user_id, chat_id = excluded.chat_id, tg_name = excluded.tg_name, created_at = excluded.created_at')
      .run(tgId, u.id, chatId, name.slice(0, 80), now);
    this.d.audit.log(this.fakeReq({ userId: u.id, username: u.username }), 'telegram.link', 'ok', name, { tgUserId: tgId });
    this.d.events.add('info', 'sicurezza', `Telegram collegato per ${u.username}`, name);
    return { text: `✅ Collegato a <b>${esc(u.username)}</b> (${ROLE_NAME[u.role]}).\nScrivi /aiuto per i comandi.` };
  }

  // ───────── aggiornamenti ─────────
  private allow(tgId: string) {
    const now = this.now();
    const list = (this.rate.get(tgId) ?? []).filter((t) => t > now - 60_000);
    list.push(now);
    this.rate.set(tgId, list);
    return list.length <= 20;
  }

  async handle(u: Update) {
    if (u.callback_query) return this.onCallback(u.callback_query);
    const m = u.message;
    if (!m) return;
    const c = m.chat;
    this.chats.set(String(c.id), {
      id: String(c.id),
      type: c.type === 'private' ? 'privata' : c.type === 'channel' ? 'canale' : 'gruppo',
      name: c.title ?? ([c.first_name, c.last_name].filter(Boolean).join(' ') || (c.username ? `@${c.username}` : String(c.id))),
      lastSeen: m.date * 1000,
    });
    if (c.type !== 'private' || !m.from || m.from.is_bot || !m.text) return;
    const tgId = String(m.from.id);
    if (!this.allow(tgId)) return;
    const [first, ...args] = m.text.trim().split(/\s+/);
    const cmd = first.toLowerCase().replace(/@.*$/, '');
    const send = (r: Reply) => this.send(c.id, r);
    if (cmd === '/collega') return send(this.link(tgId, String(c.id), nameOf(m.from), args.join('')));
    const who = this.whoIs(tgId);
    if (cmd === '/start' || cmd === '/aiuto' || cmd === '/help') return send(this.help(who));
    if (!who.ok) {
      // Account non collegati: una sola risposta ogni 10 minuti, il resto si ignora
      const last = this.nagged.get(tgId) ?? 0;
      if (this.now() - last < 10 * 60_000) return;
      this.nagged.set(tgId, this.now());
      return send({ text: who.reason });
    }
    this.d.db.prepare('UPDATE telegram_links SET last_used_at = ? WHERE tg_user_id = ?').run(this.now(), tgId);
    // Un servizio irraggiungibile non deve lasciare l'utente senza risposta
    try {
      await this.command(cmd, who, send);
    } catch (e) {
      this.d.warn('bot Telegram: comando non riuscito', { cmd, err: (e as Error).message });
      await send({ text: `⚠️ ${esc(cmd)} non riuscito: ${esc((e as Error).message.slice(0, 200))}` });
    }
  }

  private async command(cmd: string, who: Extract<Who, { ok: true }>, send: (r: Reply) => Promise<void>) {
    switch (cmd) {
      case '/stato':
        return send(await this.stato());
      case '/download':
        return send(await this.downloads(who));
      case '/media':
        return send(await this.mediaList(who));
      case '/digest': {
        if (!this.d.digest) return send({ text: 'Digest non disponibile.' });
        const dg = await this.d.digest.compose('daily');
        return send({ text: `<b>${esc(dg.title)}</b>\n${esc(dg.body)}` });
      }
      case '/scollega':
        this.unlink(who.tgId);
        this.d.audit.log(this.fakeReq(who), 'telegram.unlink', 'ok', who.username, { tgUserId: who.tgId });
        return send({ text: 'Account scollegato. Per ricollegarlo genera un nuovo codice in GIGI OS.' });
      default:
        return send({ text: 'Comando sconosciuto. Scrivi /aiuto.' });
    }
  }

  help(who: Who): Reply {
    if (!who.ok) return { text: `<b>GIGI OS</b>\n${esc(who.reason)}` };
    const op = atLeast(who.role, 'operator');
    return {
      text: [
        `<b>GIGI OS</b> · ${esc(who.username)} (${ROLE_NAME[who.role]})`,
        '/stato — risorse, dischi, container',
        `/download — download in corso${op ? ' (con pausa e ripresa)' : ''}`,
        `/media — contenuti da rivedere${op ? ' (importa o ignora)' : ''}`,
        '/digest — riepilogo delle ultime 24 ore',
        '/scollega — scollega questo account',
      ].join('\n'),
    };
  }

  private async send(chatId: number | string, r: Reply) {
    await this.call('sendMessage', { chat_id: chatId, text: r.text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: keyboard(r.keyboard) });
  }

  private async edit(chatId: number, messageId: number, r: Reply) {
    await this.call('editMessageText', { chat_id: chatId, message_id: messageId, text: r.text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: keyboard(r.keyboard) }).catch((e: Error) => {
      // «message is not modified»: il contenuto non è cambiato, non è un errore
      if (!/not modified/i.test(e.message)) throw e;
    });
  }

  private tok(who: { tgId: string }, kind: Kind, payload: Record<string, string>) {
    const now = this.now();
    if (this.pending.size > 1000) for (const [k, v] of this.pending) if (v.exp < now) this.pending.delete(k);
    const t = randomBytes(16).toString('base64url');
    this.pending.set(t, { tgId: who.tgId, kind, payload, exp: now + 3600_000 });
    return t;
  }

  // ───────── comandi ─────────
  async stato(): Promise<Reply> {
    const [sys, containers] = await Promise.all([
      this.d.agent
        .json<{ hostname: string; uptime: number; cpu: { usage: number }; memory: { used: number; total: number }; cpuTemp: number | null; disks: { label: string; total: number; free: number; used: number; ok: boolean }[] }>('GET', '/v1/system')
        .catch(() => null),
      this.d.agent.json<{ name: string; state: string; health: string | null }[]>('GET', '/v1/containers').catch(() => null),
    ]);
    if (!sys) return { text: '⚠️ Stato del sistema non disponibile (agent non raggiungibile).' };
    const lines = [
      `<b>🖥 ${esc(sys.hostname)}</b>`,
      `CPU ${Math.round(sys.cpu.usage)}% · RAM ${Math.round((sys.memory.used / sys.memory.total) * 100)}%${sys.cpuTemp !== null ? ` · ${Math.round(sys.cpuTemp)} °C` : ''} · acceso da ${uptime(sys.uptime)}`,
    ];
    const trend = new Map((this.d.metrics?.disks() ?? []).map((x) => [x.label, x.forecast]));
    for (const dk of sys.disks.filter((x) => x.ok && x.total > 0)) {
      const f = trend.get(dk.label);
      lines.push(`💾 ${esc(dk.label)}: ${Math.round((dk.used / dk.total) * 100)}% · ${bytes(dk.free)} liberi${f ? ` · ${forecastLine(f)}` : ''}`);
    }
    if (containers) {
      const running = containers.filter((x) => x.state === 'running');
      lines.push(`🐳 ${running.length}/${containers.length} container attivi`);
      const bad = running.filter((x) => x.health === 'unhealthy').map((x) => x.name);
      const stopped = containers.filter((x) => x.state !== 'running').map((x) => x.name);
      if (bad.length) lines.push(`⚠️ unhealthy: ${esc(bad.join(', '))}`);
      if (stopped.length) lines.push(`⏹ fermi: ${esc(stopped.join(', '))}`);
    }
    const off = this.d.integrations.list().filter((i) => i.enabled && ['offline', 'error', 'unauthorized'].includes(i.status ?? '')).map((i) => i.name);
    if (off.length) lines.push(`🔌 Da controllare: ${esc(off.join(', '))}`);
    return { text: lines.join('\n') };
  }

  private qb() {
    return this.d.integrations.list().find((i) => i.type === 'qbittorrent' && i.enabled) ?? null;
  }

  async downloads(who: { tgId: string; role: Role }): Promise<Reply> {
    const qb = this.qb();
    if (!qb) return { text: 'qBittorrent non è collegato a GIGI OS.' };
    const all = (await this.d.integrations.resource(qb.id, 'torrents', new URLSearchParams(), 0)) as Torrent[];
    const active = all.filter((t) => !t.complete).sort((a, b) => b.progress - a.progress).slice(0, 8);
    const seeding = all.filter((t) => t.complete && !t.stopped).length;
    if (!active.length) return { text: `⬇️ Nessun download in corso.\n${seeding} torrent in seeding, ${all.filter((t) => t.complete).length} completati.` };
    const lines = active.map((t, i) => `${i + 1}. ${t.stopped ? '⏸' : '▶️'} <b>${Math.floor(t.progress * 100)}%</b>${t.stopped ? '' : ` · ${bytes(t.dlspeed)}/s · ${eta(t.eta)}`} — ${esc(trunc(t.name, 48))}`);
    lines.push(`\n${seeding} in seeding · ${all.length} torrent in totale`);
    const kb = atLeast(who.role, 'operator')
      ? rows(
          active.map((t, i) => ({ text: `${t.stopped ? '▶️' : '⏸'} ${i + 1}`, data: this.tok(who, t.stopped ? 'tstart' : 'tstop', { hash: t.hash, name: t.name }) })),
          4,
        )
      : undefined;
    return { text: `<b>⬇️ Download in corso</b>\n${lines.join('\n')}`, keyboard: kb };
  }

  async mediaList(who: { tgId: string; role: Role }): Promise<Reply> {
    if (!this.d.media) return { text: 'Motore media non disponibile.' };
    const order: Record<string, number> = { ready: 0, review: 1, conflict: 2 };
    const items = (await this.d.media.items(500)).filter((i) => i.status in order).sort((a, b) => order[a.status] - order[b.status] || (b.confidence ?? 0) - (a.confidence ?? 0));
    if (!items.length) return { text: '🎬 Niente da rivedere: il motore media è in pari.' };
    const shown = items.slice(0, 6);
    const label: Record<string, string> = { ready: 'pronto', review: 'da rivedere', conflict: 'conflitto' };
    const lines = shown.map(
      (i, n) => `${n + 1}. <b>${esc(trunc(i.fileName, 60))}</b>\n    ${i.plan ? `→ ${esc(shortDest(i.plan.dest))}` : 'nessuna destinazione proposta'}${i.confidence !== null ? ` · ${i.confidence}%` : ''} · ${label[i.status]}`,
    );
    if (items.length > shown.length) lines.push(`… e altri ${items.length - shown.length} in GIGI OS`);
    const kb: Button[][] = [];
    if (atLeast(who.role, 'operator'))
      shown.forEach((i, n) => {
        const row: Button[] = [];
        if (i.plan && (i.status === 'ready' || i.status === 'review')) row.push({ text: `📥 Importa ${n + 1}`, data: this.tok(who, 'mask', { id: i.id }) });
        row.push({ text: `🙈 Ignora ${n + 1}`, data: this.tok(who, 'mignore', { id: i.id }) });
        kb.push(row);
      });
    return { text: `<b>🎬 Da rivedere</b> (${items.length})\n${lines.join('\n')}`, keyboard: kb };
  }

  private async onCallback(q: NonNullable<Update['callback_query']>) {
    const answer = (text: string) => this.call('answerCallbackQuery', { callback_query_id: q.id, text: text.slice(0, 190) }).catch(() => undefined);
    const tgId = String(q.from.id);
    const p = q.data ? this.pending.get(q.data) : undefined;
    if (!p || p.exp < this.now() || p.tgId !== tgId || !q.message) return answer('Pulsante scaduto: ripeti il comando.');
    this.pending.delete(q.data!);
    const who = this.whoIs(tgId);
    const msg = q.message;
    if (p.kind === 'cancel') {
      await answer('Annullato');
      return this.edit(msg.chat.id, msg.message_id, { text: 'Annullato.' });
    }
    if (!who.ok || !atLeast(who.role, 'operator')) {
      if (who.ok) this.d.audit.log(this.fakeReq(who), `telegram.${p.kind}`, 'denied', null, { reason: 'ruolo' });
      return answer(who.ok ? 'Serve il ruolo operatore o amministratore.' : who.reason);
    }
    const req = this.fakeReq(who);
    try {
      if (p.kind === 'tstop' || p.kind === 'tstart') {
        const qb = this.qb();
        if (!qb) return answer('qBittorrent non è collegato.');
        const op = p.kind === 'tstop' ? 'stop' : 'start';
        await this.d.integrations.action(qb.id, 'control', { op, hashes: [p.payload.hash] });
        this.d.audit.log(req, 'integration.action.control', 'ok', qb.name, { op, hashes: [p.payload.hash], via: 'telegram' });
        await answer(`${op === 'stop' ? '⏸ Fermato' : '▶️ Avviato'}: ${p.payload.name}`);
        return this.edit(msg.chat.id, msg.message_id, await this.downloads(who));
      }
      if (!this.d.media || !MEDIA_ID.test(p.payload.id)) return answer('Motore media non disponibile.');
      const item: MediaItem = await this.d.media.item(p.payload.id);
      if (p.kind === 'mignore') {
        await this.d.media.act('ignore', item.id, who.username);
        this.d.audit.log(req, 'media.ignore', 'ok', item.fileName, { via: 'telegram' });
        await answer(`🙈 Ignorato: ${item.fileName}`);
        return this.edit(msg.chat.id, msg.message_id, await this.mediaList(who));
      }
      const importable = !!item.plan && (item.status === 'ready' || item.status === 'review');
      if (!importable) {
        await answer('Non più importabile: è cambiato nel frattempo.');
        return this.edit(msg.chat.id, msg.message_id, await this.mediaList(who));
      }
      if (p.kind === 'mask') {
        await answer('Conferma richiesta');
        return this.edit(msg.chat.id, msg.message_id, {
          text: `<b>Importare questo file?</b>\n${esc(item.fileName)}\n→ <code>${esc(item.plan!.dest)}</code>\nConfidenza ${item.confidence ?? '?'}%${item.status === 'review' ? ' · <b>sotto la soglia: controlla la destinazione</b>' : ''}\nHardlink: la sorgente resta in seeding.`,
          keyboard: [[{ text: '✅ Conferma import', data: this.tok(who, 'mimport', { id: item.id }) }, { text: '✖️ Annulla', data: this.tok(who, 'cancel', {}) }]],
        });
      }
      // mimport: seconda conferma ricevuta
      const r = await this.d.media.act('import', item.id, who.username);
      this.d.audit.log(req, 'media.import', 'ok', r.fileName, { destinazione: r.plan?.dest, via: 'telegram' });
      await answer('📥 Importato');
      return this.edit(msg.chat.id, msg.message_id, { text: `✅ Importato: <b>${esc(r.fileName)}</b>\n→ <code>${esc(r.plan?.dest ?? '')}</code>\nJellyfin viene avvisato; lo vedrai anche in Apollo dopo l’indicizzazione.` });
    } catch (e) {
      this.d.audit.log(req, `telegram.${p.kind}`, 'error', null, { err: (e as Error).message });
      await answer('Operazione non riuscita');
      return this.edit(msg.chat.id, msg.message_id, { text: `❌ Non riuscito: ${esc((e as Error).message.slice(0, 300))}` });
    }
  }
}

export function registerTelegram(app: FastifyInstance, bot: TelegramBot, audit: Audit, viewer: object, admin: object) {
  type U = { id: string; username: string; role: Role };
  const me = (req: FastifyRequest) => req.user as U;

  app.get('/api/v1/telegram/me', viewer, async (req) => ({
    available: bot.settings().enabled && bot.status.state === 'attivo',
    bot: bot.status.bot,
    links: bot.links(me(req).id),
  }));

  app.post('/api/v1/telegram/link-code', { ...viewer, config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (req, reply) => {
    if (!bot.settings().enabled || bot.status.state !== 'attivo') return reply.code(409).send({ error: 'Il bot Telegram non è attivo: un amministratore deve abilitarlo in Automazioni → Bot e digest' });
    audit.log(req, 'telegram.code', 'ok', me(req).username);
    return bot.createCode(me(req).id);
  });

  app.delete('/api/v1/telegram/links/:tg', viewer, async (req, reply) => {
    const { tg } = req.params as { tg: string };
    if (!/^\d{1,20}$/.test(tg)) return reply.code(400).send({ error: 'id non valido' });
    const owner = bot.linkOwner(tg);
    if (!owner) return reply.code(404).send({ error: 'Collegamento non trovato' });
    if (owner !== me(req).id && !atLeast(me(req).role, 'admin')) return reply.code(403).send({ error: 'Puoi scollegare solo i tuoi account' });
    bot.unlink(tg);
    audit.log(req, 'telegram.unlink', 'ok', tg);
    return { ok: true };
  });

  app.get('/api/v1/telegram/bot', admin, async () => ({ settings: bot.settings(), status: bot.status, links: bot.links() }));
  app.put('/api/v1/telegram/bot', admin, async (req) => {
    const s = bot.setSettings(z.object({ channelId: z.string().uuid().nullable(), enabled: z.boolean() }).parse(req.body));
    audit.log(req, 'telegram.bot', 'ok', null, s);
    return s;
  });
}
