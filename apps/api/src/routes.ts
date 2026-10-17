import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Deps } from './app.js';
import { connectors, AUTO_SEED } from './connectors/index.js';
import { jellyfinImage } from './connectors/jellyfin.js';
import { ConnectorError } from './connectors/types.js';
import { integrationInput } from './integrations.js';
import { registerFiles } from './files.js';
import { registerAutomations } from './automations.js';
import { registerBackups } from './backup.js';
import { registerStacks } from './stacks.js';
import { registerNetwork } from './network.js';
import { registerMetrics } from './metrics.js';
import { registerLauncher } from './launcher.js';
import { registerTelegram } from './telegram.js';
import { registerDigest } from './digest.js';
import { registerUpdates } from './updates.js';
import { registerWorkflows } from './workflows/routes.js';
import { atLeast, COOKIE, DUMMY_HASH, hashPassword, newId, passwordProblems, verifyPassword, type Role, type SessionUser } from './security.js';
import { MFA_REQUIRED, TRUST_COOKIE, TRUST_DAYS } from './mfa.js';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const UUID = /^[0-9a-f-]{36}$/;

type Authed = FastifyRequest & { user: SessionUser };

/** Azioni dei connettori consentite agli operatori (D-028); tutto il resto è solo admin. */
const OPERATOR_ACTIONS: Record<string, ReadonlySet<string>> = {
  qbittorrent: new Set(['control', 'setCategory', 'shareLimits', 'add', 'searchStart', 'searchResults', 'searchStop', 'delete']),
  armony: new Set(['command']),
};
export function operatorMay(type: string, action: string, body: Record<string, unknown>) {
  if (!OPERATOR_ACTIONS[type]?.has(action)) return false;
  // L'operatore rimuove solo il torrent: mai i file scaricati.
  if (type === 'qbittorrent' && action === 'delete' && body.deleteFiles !== false) return false;
  return true;
}

export async function registerRoutes(app: FastifyInstance, d: Deps) {
  const { db, agent, integrations, events, sessions, limiter, audit } = d;

  const { mfa } = d;
  /** Admin e operatori senza verifica in due passaggi possono solo configurarla (D-029). */
  const mfaPending = (u: SessionUser) => !!mfa && MFA_REQUIRED.has(u.role) && !u.mfa;
  const DENIED: Record<Role, string> = {
    viewer: 'Autenticazione richiesta',
    operator: 'Permesso riservato a operatori e amministratori',
    admin: 'Permesso riservato agli amministratori',
  };
  const auth =
    (role?: Role, opts: { duringMfaSetup?: boolean } = {}) =>
    async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (!req.user) return void reply.code(401).send({ error: 'Autenticazione richiesta' });
      if (!opts.duringMfaSetup && mfaPending(req.user)) {
        return void reply.code(403).send({ error: 'Configura la verifica in due passaggi per continuare', code: 'mfa_setup_required' });
      }
      if (role && !atLeast(req.user.role, role)) {
        audit.log(req, 'access.denied', 'denied', req.routeOptions.url ?? req.url);
        return void reply.code(403).send({ error: DENIED[role] });
      }
    };
  const viewer = { preHandler: auth() };
  const operator = { preHandler: auth('operator') };
  const admin = { preHandler: auth('admin') };
  const enrolling = { preHandler: auth(undefined, { duringMfaSetup: true }) };
  const isAdmin = (req: FastifyRequest) => !!req.user && atLeast(req.user.role, 'admin');

  const userOut = (u: Pick<SessionUser, 'id' | 'username' | 'role' | 'mfa'>, csrf: string) => ({
    id: u.id,
    username: u.username,
    role: u.role,
    csrf,
    mfa: { enabled: u.mfa, required: !!mfa && MFA_REQUIRED.has(u.role), setupRequired: mfaPending(u as SessionUser) },
  });

  const setCookie = (reply: FastifyReply, token: string) =>
    reply.setCookie(COOKIE, token, {
      httpOnly: true,
      secure: d.secureCookies,
      sameSite: 'strict',
      path: '/',
      maxAge: 7 * 86400,
    });

  const userCount = () => (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  const adminCount = () => (db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get() as { n: number }).n;

  // ───────────── Autenticazione ─────────────
  app.get('/api/v1/auth/state', async (req) => ({
    setupRequired: userCount() === 0,
    user: req.user ? userOut(req.user, req.user.csrf) : null,
  }));

  const credentials = z.object({ username: z.string().trim().min(3).max(40).regex(/^[a-zA-Z0-9._-]+$/), password: z.string().min(1).max(256) });

  app.post(
    '/api/v1/auth/setup',
    { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
    async (req, reply) => {
      if (userCount() > 0) return reply.code(409).send({ error: 'Setup già completato' });
      const body = credentials.extend({ setupToken: z.string().min(1).max(200) }).parse(req.body);
      const expected = d.setupToken();
      const ok =
        !!expected &&
        body.setupToken.length === expected.length &&
        timingSafeEqual(Buffer.from(body.setupToken), Buffer.from(expected));
      if (!ok) {
        audit.log(req, 'auth.setup', 'denied', body.username, { reason: 'setup token errato' });
        return reply.code(403).send({ error: 'Codice di setup non valido (vedi i log di gigi-api)' });
      }
      const problem = passwordProblems(body.password, body.username);
      if (problem) return reply.code(400).send({ error: problem });
      const id = newId();
      const now = Date.now();
      db.prepare('INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (?,?,?,?,?,?)').run(
        id,
        body.username,
        await hashPassword(body.password),
        'admin',
        now,
        now,
      );
      d.consumeSetupToken();
      integrations.seed(AUTO_SEED);
      void integrations.checkAll();
      const s = sessions.create(id, req.ip, req.headers['user-agent'] ?? '');
      setCookie(reply, s.token);
      req.user = { id, username: body.username, role: 'admin', csrf: s.csrf, tokenHash: '', mfa: false };
      audit.log(req, 'auth.setup', 'ok', body.username);
      return { user: userOut(req.user, s.csrf) };
    },
  );

  app.post(
    '/api/v1/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = credentials.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'Credenziali non valide' });
      const { username, password } = body.data;
      const keys = [`ip:${req.ip}`, `user:${username.toLowerCase()}`];
      if (limiter.blocked(keys)) {
        audit.log(req, 'auth.login', 'denied', username, { reason: 'troppi tentativi' });
        return reply.code(429).send({ error: 'Troppi tentativi falliti. Riprova tra qualche minuto.' });
      }
      const u = db.prepare('SELECT id, username, password_hash, role, disabled FROM users WHERE username = ?').get(username) as
        | { id: string; username: string; password_hash: string; role: Role; disabled: number }
        | undefined;
      const valid = await verifyPassword(password, u?.password_hash ?? DUMMY_HASH);
      if (!u || !valid || u.disabled) {
        limiter.fail(keys);
        audit.log(req, 'auth.login', 'denied', username);
        return reply.code(401).send({ error: 'Utente o password errati' });
      }
      // Con la verifica in due passaggi la sessione nasce solo dopo il codice (POST /auth/login/mfa),
      // salvo un dispositivo attendibile di questo utente non ancora scaduto (D-036).
      if (mfa?.enabled(u.id)) {
        if (mfa.checkDevice(u.id, req.cookies[TRUST_COOKIE])) {
          limiter.clear([`user:${username.toLowerCase()}`]);
          return startSession(req, reply, u, 'trusted');
        }
        audit.log(req, 'auth.login.password', 'ok', u.username);
        return { mfaRequired: true, ticket: mfa.ticket(u.id), trustDays: mfa.trustDays() };
      }
      limiter.clear([`user:${username.toLowerCase()}`]);
      return startSession(req, reply, u, null);
    },
  );

  const startSession = (req: FastifyRequest, reply: FastifyReply, u: { id: string; username: string; role: Role }, method: 'totp' | 'recovery' | 'trusted' | null) => {
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), u.id);
    const s = sessions.create(u.id, req.ip, req.headers['user-agent'] ?? '');
    setCookie(reply, s.token);
    req.user = { id: u.id, username: u.username, role: u.role, csrf: s.csrf, tokenHash: '', mfa: method !== null || !!mfa?.enabled(u.id) };
    audit.log(req, 'auth.login', 'ok', u.username, method ? { mfa: method } : undefined);
    return { user: userOut(req.user, s.csrf), ...(method === 'recovery' ? { recoveryLeft: mfa!.recoveryLeft(u.id) } : {}) };
  };

  app.post(
    '/api/v1/auth/login/mfa',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (!mfa) return reply.code(404).send({ error: 'Non disponibile' });
      const body = z.object({ ticket: z.string().min(10).max(100), code: z.string().trim().min(6).max(20), remember: z.boolean().optional() }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'Codice non valido' });
      const userId = mfa.useTicket(body.data.ticket);
      if (!userId) return reply.code(401).send({ error: 'Accesso scaduto: inserisci di nuovo nome utente e password', code: 'ticket_expired' });
      const u = db.prepare('SELECT id, username, role, disabled FROM users WHERE id = ?').get(userId) as
        | { id: string; username: string; role: Role; disabled: number }
        | undefined;
      if (!u || u.disabled) return reply.code(401).send({ error: 'Utente non valido', code: 'ticket_expired' });
      const keys = [`ip:${req.ip}`, `user:${u.username.toLowerCase()}`];
      if (limiter.blocked(keys)) {
        mfa.dropTicket(body.data.ticket);
        audit.log(req, 'auth.login.mfa', 'denied', u.username, { reason: 'troppi tentativi' });
        return reply.code(429).send({ error: 'Troppi tentativi falliti. Riprova tra qualche minuto.' });
      }
      const method = mfa.verify(u.id, body.data.code);
      if (!method) {
        limiter.fail(keys);
        audit.log(req, 'auth.login.mfa', 'denied', u.username);
        return reply.code(401).send({ error: 'Codice non valido o già usato' });
      }
      mfa.dropTicket(body.data.ticket);
      limiter.clear([`user:${u.username.toLowerCase()}`]);
      if (body.data.remember) {
        const dev = mfa.trustDevice(u.id, req.headers['user-agent'] ?? '', req.ip);
        if (dev) {
          // Inviato solo alle route di autenticazione: nessun'altra richiesta lo porta con sé
          reply.setCookie(TRUST_COOKIE, dev.token, { httpOnly: true, secure: d.secureCookies, sameSite: 'strict', path: '/api/v1/auth', maxAge: dev.maxAgeSec });
          audit.log(req, 'mfa.device.trust', 'ok', u.username, { giorni: mfa.trustDays() });
        }
      }
      return startSession(req, reply, u, method);
    },
  );

  // ───────────── Verifica in due passaggi (D-029) ─────────────
  if (mfa) {
    const strict = (max: number) => ({ ...enrolling, config: { rateLimit: { max, timeWindow: '15 minutes' } } });
    const passwordOk = async (userId: string, password: string) => {
      const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as { password_hash: string } | undefined;
      return !!row && (await verifyPassword(password, row.password_hash));
    };

    app.get('/api/v1/auth/mfa', enrolling, async (req) => {
      const r = req as Authed;
      return { enabled: r.user.mfa, required: MFA_REQUIRED.has(r.user.role), recoveryLeft: mfa.recoveryLeft(r.user.id) };
    });

    app.post('/api/v1/auth/mfa/begin', strict(10), async (req, reply) => {
      const r = req as Authed;
      const body = z.object({ password: z.string().min(1).max(256) }).parse(req.body);
      if (!(await passwordOk(r.user.id, body.password))) {
        audit.log(req, 'mfa.begin', 'denied', r.user.username, { reason: 'password errata' });
        return reply.code(403).send({ error: 'Password errata' });
      }
      return mfa.begin(r.user.id, r.user.username);
    });

    app.post('/api/v1/auth/mfa/confirm', strict(10), async (req, reply) => {
      const r = req as Authed;
      const body = z.object({ code: z.string().trim().max(20) }).parse(req.body);
      const codes = mfa.confirm(r.user.id, body.code);
      if (!codes) {
        audit.log(req, 'mfa.enable', 'denied', r.user.username);
        return reply.code(400).send({ error: 'Codice non valido: controlla che l’ora del telefono sia corretta e riprova' });
      }
      sessions.destroyForUser(r.user.id, r.user.tokenHash);
      mfa.forgetDevices(r.user.id);
      audit.log(req, 'mfa.enable', 'ok', r.user.username);
      events.add('info', 'sicurezza', `Verifica in due passaggi attivata per ${r.user.username}`);
      return { recoveryCodes: codes };
    });

    app.post('/api/v1/auth/mfa/recovery', strict(10), async (req, reply) => {
      const r = req as Authed;
      const body = z.object({ code: z.string().trim().max(20) }).parse(req.body);
      if (!r.user.mfa || mfa.verify(r.user.id, body.code) !== 'totp') {
        audit.log(req, 'mfa.recovery', 'denied', r.user.username);
        return reply.code(400).send({ error: 'Serve un codice valido dell’app di autenticazione' });
      }
      audit.log(req, 'mfa.recovery', 'ok', r.user.username);
      return { recoveryCodes: mfa.regenerateRecovery(r.user.id) };
    });

    app.post('/api/v1/auth/mfa/disable', strict(10), async (req, reply) => {
      const r = req as Authed;
      const body = z.object({ password: z.string().min(1).max(256), code: z.string().trim().max(20) }).parse(req.body);
      if (!r.user.mfa || !(await passwordOk(r.user.id, body.password)) || !mfa.verify(r.user.id, body.code)) {
        audit.log(req, 'mfa.disable', 'denied', r.user.username);
        return reply.code(403).send({ error: 'Password o codice non validi' });
      }
      mfa.disable(r.user.id);
      audit.log(req, 'mfa.disable', 'ok', r.user.username);
      events.add('warning', 'sicurezza', `Verifica in due passaggi disattivata per ${r.user.username}`);
      return { ok: true, setupRequired: MFA_REQUIRED.has(r.user.role) };
    });

    // Dispositivi attendibili (D-036)
    app.get('/api/v1/auth/devices', enrolling, async (req) => {
      const r = req as Authed;
      return { trustDays: mfa.trustDays(), devices: mfa.devices(r.user.id, req.cookies[TRUST_COOKIE]) };
    });
    app.delete('/api/v1/auth/devices/:id', enrolling, async (req, reply) => {
      const r = req as Authed;
      const { id } = req.params as { id: string };
      if (!UUID.test(id) || !mfa.forgetDevice(r.user.id, id)) return reply.code(404).send({ error: 'Dispositivo non trovato' });
      audit.log(req, 'mfa.device.forget', 'ok', r.user.username);
      return { ok: true };
    });
    app.delete('/api/v1/auth/devices', enrolling, async (req, reply) => {
      const r = req as Authed;
      const n = mfa.forgetDevices(r.user.id);
      reply.clearCookie(TRUST_COOKIE, { path: '/api/v1/auth' });
      audit.log(req, 'mfa.device.forget', 'ok', r.user.username, { tutti: n });
      return { ok: true, removed: n };
    });
    app.get('/api/v1/security/mfa-policy', viewer, async () => ({ trustDays: mfa.trustDays(), options: TRUST_DAYS }));
    app.put('/api/v1/security/mfa-policy', admin, async (req) => {
      const { trustDays } = z.object({ trustDays: z.number().int() }).parse(req.body);
      mfa.setTrustDays(trustDays);
      audit.log(req, 'mfa.policy', 'ok', null, { trustDays });
      events.add(trustDays ? 'info' : 'warning', 'sicurezza', trustDays ? `Dispositivi attendibili: ${trustDays} giorni` : 'Dispositivi attendibili disattivati');
      return { trustDays: mfa.trustDays() };
    });

    app.delete('/api/v1/users/:id/mfa', admin, async (req, reply) => {
      const r = req as Authed;
      const { id } = req.params as { id: string };
      if (!UUID.test(id)) return reply.code(400).send({ error: 'id non valido' });
      if (id === r.user.id) return reply.code(409).send({ error: 'Per la tua verifica in due passaggi usa «Disattiva» nella tua scheda' });
      const u = db.prepare('SELECT username FROM users WHERE id = ?').get(id) as { username: string } | undefined;
      if (!u) return reply.code(404).send({ error: 'Utente non trovato' });
      mfa.disable(id);
      sessions.destroyForUser(id);
      audit.log(req, 'mfa.reset', 'ok', u.username);
      events.add('warning', 'sicurezza', `Verifica in due passaggi azzerata per ${u.username} da ${r.user.username}`);
      return { ok: true };
    });
  }

  app.post('/api/v1/auth/logout', enrolling, async (req, reply) => {
    const r = req as Authed;
    sessions.destroy(r.user.tokenHash);
    audit.log(req, 'auth.logout', 'ok', r.user.username);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post('/api/v1/auth/password', viewer, async (req, reply) => {
    const r = req as Authed;
    const body = z.object({ current: z.string().max(256), next: z.string().max(256) }).parse(req.body);
    const u = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(r.user.id) as { password_hash: string };
    if (!(await verifyPassword(body.current, u.password_hash))) {
      audit.log(req, 'auth.password', 'denied', r.user.username);
      return reply.code(403).send({ error: 'Password attuale errata' });
    }
    const problem = passwordProblems(body.next, r.user.username);
    if (problem) return reply.code(400).send({ error: problem });
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(await hashPassword(body.next), Date.now(), r.user.id);
    sessions.destroyForUser(r.user.id, r.user.tokenHash);
    mfa?.forgetDevices(r.user.id);
    audit.log(req, 'auth.password', 'ok', r.user.username);
    return { ok: true };
  });

  app.get('/api/v1/auth/sessions', viewer, async (req) => {
    const r = req as Authed;
    return (
      db
        .prepare('SELECT token_hash, created_at, last_seen, ip, user_agent FROM sessions WHERE user_id = ? ORDER BY last_seen DESC')
        .all(r.user.id) as { token_hash: string; created_at: number; last_seen: number; ip: string; user_agent: string }[]
    ).map((s) => ({
      id: s.token_hash.slice(0, 16),
      current: s.token_hash === r.user.tokenHash,
      createdAt: s.created_at,
      lastSeen: s.last_seen,
      ip: s.ip,
      userAgent: s.user_agent,
    }));
  });

  app.post('/api/v1/auth/sessions/revoke-others', viewer, async (req) => {
    const r = req as Authed;
    sessions.destroyForUser(r.user.id, r.user.tokenHash);
    audit.log(req, 'auth.sessions.revoke', 'ok', r.user.username);
    return { ok: true };
  });

  // ───────────── Utenti (admin) ─────────────
  app.get('/api/v1/users', admin, async () =>
    (
      db
        .prepare(
          `SELECT u.id, u.username, u.role, u.disabled, u.created_at, u.last_login_at, COALESCE(m.enabled, 0) AS mfa
           FROM users u LEFT JOIN user_mfa m ON m.user_id = u.id ORDER BY u.created_at`,
        )
        .all() as { id: string; username: string; role: Role; disabled: number; created_at: number; last_login_at: number | null; mfa: number }[]
    ).map((u) => ({
      id: u.id,
      username: u.username,
      role: u.role,
      disabled: !!u.disabled,
      createdAt: u.created_at,
      lastLoginAt: u.last_login_at,
      mfa: !!u.mfa,
      mfaRequired: MFA_REQUIRED.has(u.role),
    })),
  );

  app.post('/api/v1/users', admin, async (req, reply) => {
    const body = credentials.extend({ role: z.enum(['admin', 'operator', 'viewer']) }).parse(req.body);
    const problem = passwordProblems(body.password, body.username);
    if (problem) return reply.code(400).send({ error: problem });
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(body.username)) return reply.code(409).send({ error: 'Nome utente già esistente' });
    const id = newId();
    const now = Date.now();
    db.prepare('INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (?,?,?,?,?,?)').run(
      id,
      body.username,
      await hashPassword(body.password),
      body.role,
      now,
      now,
    );
    audit.log(req, 'user.create', 'ok', body.username, { role: body.role });
    return { id };
  });

  app.patch('/api/v1/users/:id', admin, async (req, reply) => {
    const r = req as Authed;
    const { id } = req.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id non valido' });
    const body = z
      .object({ role: z.enum(['admin', 'operator', 'viewer']).optional(), disabled: z.boolean().optional(), password: z.string().max(256).optional() })
      .parse(req.body);
    const u = db.prepare('SELECT id, username, role, disabled FROM users WHERE id = ?').get(id) as
      | { id: string; username: string; role: Role; disabled: number }
      | undefined;
    if (!u) return reply.code(404).send({ error: 'Utente non trovato' });
    const losingAdmin = u.role === 'admin' && !u.disabled && ((body.role !== undefined && body.role !== 'admin') || body.disabled === true);
    if (losingAdmin && adminCount() <= 1) return reply.code(409).send({ error: "Deve restare almeno un amministratore attivo" });
    if (id === r.user.id && (body.disabled || (body.role !== undefined && body.role !== 'admin'))) return reply.code(409).send({ error: 'Non puoi disabilitare o declassare te stesso' });
    if (body.password !== undefined) {
      const problem = passwordProblems(body.password, u.username);
      if (problem) return reply.code(400).send({ error: problem });
      db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(await hashPassword(body.password), Date.now(), id);
      sessions.destroyForUser(id);
      mfa?.forgetDevices(id);
    }
    if (body.role) db.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?').run(body.role, Date.now(), id);
    if (body.disabled !== undefined) {
      db.prepare('UPDATE users SET disabled = ?, updated_at = ? WHERE id = ?').run(body.disabled ? 1 : 0, Date.now(), id);
      if (body.disabled) {
        sessions.destroyForUser(id);
        mfa?.forgetDevices(id);
      }
    }
    audit.log(req, 'user.update', 'ok', u.username, { role: body.role, disabled: body.disabled, passwordReset: body.password !== undefined });
    return { ok: true };
  });

  app.delete('/api/v1/users/:id', admin, async (req, reply) => {
    const r = req as Authed;
    const { id } = req.params as { id: string };
    if (id === r.user.id) return reply.code(409).send({ error: 'Non puoi eliminare te stesso' });
    const u = db.prepare('SELECT username, role FROM users WHERE id = ?').get(id) as { username: string; role: Role } | undefined;
    if (!u) return reply.code(404).send({ error: 'Utente non trovato' });
    if (u.role === 'admin' && adminCount() <= 1) return reply.code(409).send({ error: 'Deve restare almeno un amministratore' });
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    audit.log(req, 'user.delete', 'ok', u.username);
    return { ok: true };
  });

  app.get('/api/v1/audit', admin, async (req) => {
    const q = req.query as { limit?: string; before?: string };
    const limit = Math.min(Number(q.limit ?? 100) || 100, 500);
    const before = Number(q.before ?? Number.MAX_SAFE_INTEGER);
    return db.prepare('SELECT * FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?').all(before, limit);
  });

  // ───────────── Sistema e Docker (via agent) ─────────────
  app.get('/api/v1/system', viewer, async () => agent.json('GET', '/v1/system'));
  app.get('/api/v1/system/history', viewer, async (req) => {
    const minutes = Math.min(Number((req.query as { minutes?: string }).minutes ?? 60) || 60, 60);
    return agent.json('GET', `/v1/system/history?since=${Date.now() - minutes * 60_000}`);
  });
  app.get('/api/v1/systemd/services', viewer, async () => agent.json('GET', '/v1/systemd/services'));
  app.get('/api/v1/systemd/services/:name', viewer, async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!/^[a-zA-Z0-9@._:-]{1,200}\.service$/.test(name)) return reply.code(400).send({ error: 'nome non valido' });
    return agent.json('GET', `/v1/systemd/services/${encodeURIComponent(name)}`);
  });
  app.get('/api/v1/systemd/services/:name/journal', admin, async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!/^[a-zA-Z0-9@._:\\-]{1,200}\.service$/.test(name)) return reply.code(400).send({ error: 'nome non valido' });
    const lines = Math.min(Number((req.query as { lines?: string }).lines ?? 200) || 200, 1000);
    return agent.json('GET', `/v1/systemd/services/${encodeURIComponent(name)}/journal?lines=${lines}`, 30_000);
  });
  app.get('/api/v1/journal/errors', admin, async (req) => {
    const hours = Math.min(Number((req.query as { hours?: string }).hours ?? 24) || 24, 168);
    return agent.json('GET', `/v1/journal/errors?hours=${hours}`, 30_000);
  });
  app.get('/api/v1/docker/info', viewer, async () => agent.json('GET', '/v1/docker/info'));
  app.get('/api/v1/docker/containers', viewer, async () => agent.json('GET', '/v1/containers'));
  app.get('/api/v1/docker/images', viewer, async () => agent.json('GET', '/v1/images'));
  app.get('/api/v1/docker/volumes', viewer, async () => agent.json('GET', '/v1/volumes'));
  app.get('/api/v1/docker/networks', viewer, async () => agent.json('GET', '/v1/networks'));

  app.get('/api/v1/docker/containers/:id', viewer, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!ID.test(id)) return reply.code(400).send({ error: 'id non valido' });
    const data = await agent.json<Record<string, unknown>>('GET', `/v1/containers/${encodeURIComponent(id)}`);
    // Variabili d'ambiente, comandi ed etichette (già oscurati) solo agli admin
    if (req.user?.role !== 'admin') {
      data.env = null;
      data.cmd = null;
      data.entrypoint = null;
      data.labels = null;
    }
    return data;
  });

  // Log in streaming via Server-Sent Events (stessa sessione/cookie, nessun token in URL). Solo admin.
  // Log (già oscurati dall'agent) anche agli operatori: servono per capire se e perché riavviare (D-028).
  app.get('/api/v1/docker/containers/:id/logs', operator, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!ID.test(id)) return reply.code(400).send({ error: 'id non valido' });
    const q = req.query as { tail?: string; follow?: string };
    const tail = Math.min(Number(q.tail ?? 300) || 300, 5000);
    const follow = q.follow === '1';
    const stream = await agent.stream(`/v1/containers/${encodeURIComponent(id)}/logs?tail=${tail}&follow=${follow ? 1 : 0}`);
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-content-type-options': 'nosniff',
    });
    let buf = '';
    stream.on('data', (c: Buffer) => {
      buf += c.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line) reply.raw.write(`data: ${line}\n\n`);
      }
    });
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 20000);
    const end = () => {
      clearInterval(ping);
      reply.raw.write('event: end\ndata: {}\n\n');
      reply.raw.end();
    };
    stream.on('end', end);
    stream.on('error', end);
    req.raw.on('close', () => {
      clearInterval(ping);
      stream.destroy();
    });
  });

  app.post('/api/v1/docker/containers/:id/actions', operator, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!ID.test(id)) return reply.code(400).send({ error: 'id non valido' });
    const body = z.object({ action: z.enum(['start', 'stop', 'restart']), confirm: z.string().max(128).optional() }).parse(req.body);
    // Gli operatori avviano e riavviano; fermare un servizio resta agli admin (D-028).
    if (body.action === 'stop' && !isAdmin(req)) {
      audit.log(req, 'docker.stop', 'denied', id, { reason: 'ruolo operatore' });
      return reply.code(403).send({ error: 'Fermare un container è riservato agli amministratori' });
    }
    const c = await agent.json<{ name: string; controllable: boolean }>('GET', `/v1/containers/${encodeURIComponent(id)}`);
    if (!c.controllable) {
      audit.log(req, `docker.${body.action}`, 'denied', c.name, { reason: 'non controllabile' });
      return reply.code(403).send({ error: `Il container ${c.name} è protetto` });
    }
    if (body.action !== 'start' && body.confirm !== c.name) {
      return reply.code(400).send({ error: 'Conferma richiesta: digita il nome esatto del container' });
    }
    try {
      const r = await agent.json('POST', `/v1/containers/${encodeURIComponent(id)}/${body.action}`, 60000);
      audit.log(req, `docker.${body.action}`, 'ok', c.name);
      events.add('info', 'docker', `${c.name}: ${body.action} richiesto da ${(req as Authed).user.username}`);
      return r;
    } catch (e) {
      audit.log(req, `docker.${body.action}`, 'error', c.name, { err: (e as Error).message });
      throw e;
    }
  });

  // ───────────── Integrazioni ─────────────
  app.get('/api/v1/integrations/types', viewer, async () =>
    Object.values(connectors).map((c) => ({
      type: c.type,
      label: c.label,
      description: c.description,
      defaultUrl: c.defaultUrl,
      defaultWebUrl: c.defaultUrl ? integrations.lanUrl(c.type, c.defaultUrl) : null,
      defaultName: c.defaultName,
      defaultContainer: c.defaultContainer ?? null,
      auth: c.auth,
      configFields: c.configFields ?? [],
      capabilities: c.capabilities,
      resources: Object.keys(c.resources),
      adminResources: c.adminResources ?? [],
      actions: Object.keys(c.actions ?? {}),
    })),
  );
  app.get('/api/v1/integrations', viewer, async () => integrations.list());

  app.post('/api/v1/integrations', admin, async (req) => {
    const body = integrationInput.parse(req.body);
    const id = integrations.create(body);
    audit.log(req, 'integration.create', 'ok', `${body.type}:${body.name}`);
    await integrations.check(id).catch(() => undefined);
    return integrations.get(id);
  });

  app.post('/api/v1/integrations/test', admin, async (req) => {
    const body = integrationInput.extend({ id: z.string().regex(UUID).optional() }).parse(req.body);
    const r = await integrations.testDraft(body, body.id);
    audit.log(req, 'integration.test', 'ok', `${body.type}:${body.name}`, { status: r.status });
    return r;
  });

  app.put('/api/v1/integrations/:id', admin, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id non valido' });
    const body = integrationInput.parse(req.body);
    integrations.update(id, body);
    audit.log(req, 'integration.update', 'ok', `${body.type}:${body.name}`, { secretRotated: !!body.secret && Object.values(body.secret).some(Boolean) });
    await integrations.check(id).catch(() => undefined);
    return integrations.get(id);
  });

  app.delete('/api/v1/integrations/:id', admin, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id non valido' });
    const i = integrations.get(id);
    integrations.remove(id);
    audit.log(req, 'integration.delete', 'ok', `${i.type}:${i.name}`);
    return { ok: true };
  });

  app.post('/api/v1/integrations/:id/check', viewer, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id non valido' });
    await integrations.check(id);
    return integrations.get(id);
  });

  app.get('/api/v1/integrations/:id/resources/:name', viewer, async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string };
    if (!UUID.test(id) || !/^[a-z]{1,30}$/.test(name)) return reply.code(400).send({ error: 'parametri non validi' });
    if (integrations.isAdminResource(id, name) && req.user?.role !== 'admin') {
      audit.log(req, 'integration.resource', 'denied', `${id}:${name}`);
      return reply.code(403).send({ error: 'Dati riservati agli amministratori' });
    }
    return integrations.resource(id, name, new URLSearchParams(req.query as Record<string, string>));
  });

  app.post('/api/v1/integrations/:id/actions/:name', { ...operator, bodyLimit: 6 * 1024 * 1024 }, async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string };
    if (!UUID.test(id) || !/^[a-zA-Z]{1,30}$/.test(name)) return reply.code(400).send({ error: 'parametri non validi' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Nell'audit non finisce il contenuto dei file caricati
    const auditBody = typeof body.torrentBase64 === 'string' ? { ...body, torrentBase64: `<${Math.round((body.torrentBase64 as string).length * 0.75 / 1024)} KB>` } : body;
    const target = integrations.get(id);
    if (!isAdmin(req) && !operatorMay(target.type, name, body)) {
      audit.log(req, `integration.action.${name}`, 'denied', target.name, { reason: 'ruolo operatore' });
      return reply.code(403).send({ error: 'Azione riservata agli amministratori' });
    }
    // Protezione: niente eliminazione dei file di torrent che il motore media non ha ancora importato
    if (target.type === 'qbittorrent' && name === 'delete' && body.deleteFiles === true && body.force !== true && d.media) {
      const pending = await d.media.pendingFor(Array.isArray(body.hashes) ? (body.hashes as string[]) : []).catch(() => null);
      if (pending === null) return reply.code(409).send({ error: 'Motore media non raggiungibile: impossibile verificare se i file sono già in libreria', code: 'media_unknown' });
      if (pending.length) {
        audit.log(req, 'integration.action.delete', 'denied', target.name, { motivo: 'file non ancora importati', file: pending });
        return reply.code(409).send({ error: `${pending.length} file non sono ancora nella libreria: eliminandoli andrebbero persi`, code: 'not_imported', files: pending });
      }
    }
    try {
      const r = await integrations.action(id, name, body);
      if (!name.startsWith('search')) audit.log(req, `integration.action.${name}`, 'ok', r.integration, auditBody);
      return r;
    } catch (e) {
      audit.log(req, `integration.action.${name}`, 'error', id, { body: auditBody, err: (e as Error).message });
      throw e;
    }
  });

  app.get('/api/v1/integrations/:id/jellyfin/image/:itemId', viewer, async (req, reply) => {
    const { id, itemId } = req.params as { id: string; itemId: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id non valido' });
    const { row, ctx } = integrations.contextFor(id);
    if (row.type !== 'jellyfin') throw new ConnectorError('Non è un\'integrazione Jellyfin', 'error', 400);
    const img = await jellyfinImage(ctx, itemId);
    if (!/^image\/(jpeg|png|webp|gif)$/.test(img.type)) return reply.code(502).send({ error: 'Tipo immagine non atteso' });
    return reply.header('Cache-Control', 'private, max-age=3600').type(img.type).send(img.body);
  });

  // ───────────── Dashboard ─────────────
  app.get('/api/v1/overview', viewer, async () => {
    const [system, containers] = await Promise.allSettled([
      agent.json<Record<string, unknown>>('GET', '/v1/system'),
      agent.json<{ name: string; state: string; health: string | null; restartCount: number }[]>('GET', '/v1/containers'),
    ]);
    const list = containers.status === 'fulfilled' ? containers.value : [];
    return {
      system: system.status === 'fulfilled' ? system.value : null,
      systemError: system.status === 'rejected' ? (system.reason as Error).message : null,
      containers: containers.status === 'fulfilled' ? {
        total: list.length,
        running: list.filter((c) => c.state === 'running').length,
        stopped: list.filter((c) => c.state !== 'running').length,
        unhealthy: list.filter((c) => c.health === 'unhealthy').map((c) => c.name),
        restarting: list.filter((c) => c.state === 'restarting').map((c) => c.name),
        list,
      } : null,
      containersError: containers.status === 'rejected' ? (containers.reason as Error).message : null,
      integrations: integrations.list(),
      events: events.list(15),
    };
  });

  app.get('/api/v1/events', viewer, async (req) => {
    const q = req.query as { limit?: string; level?: 'info' | 'warning' | 'error' };
    return events.list(Math.min(Number(q.limit ?? 50) || 50, 500), q.level);
  });

  const layoutSchema = z.object({
    version: z.number().int().min(1).max(100),
    widgets: z
      .array(
        z.object({
          i: z.string().min(1).max(60).regex(/^[a-z0-9:_-]+$/i),
          type: z.string().min(1).max(40),
          x: z.number().int().min(0).max(48),
          y: z.number().int().min(0).max(500),
          w: z.number().int().min(1).max(48),
          h: z.number().int().min(1).max(40),
          options: z.record(z.union([z.string().max(200), z.number(), z.boolean()])).optional(),
        }),
      )
      .max(40),
  });

  app.get('/api/v1/layout', viewer, async (req) => {
    const r = db.prepare('SELECT layout FROM layouts WHERE user_id = ?').get((req as Authed).user.id) as { layout: string } | undefined;
    return r ? JSON.parse(r.layout) : null;
  });
  app.put('/api/v1/layout', viewer, async (req) => {
    const body = layoutSchema.parse(req.body);
    db.prepare(
      'INSERT INTO layouts (user_id, layout, updated_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET layout = excluded.layout, updated_at = excluded.updated_at',
    ).run((req as Authed).user.id, JSON.stringify(body), Date.now());
    return { ok: true };
  });
  app.delete('/api/v1/layout', viewer, async (req) => {
    db.prepare('DELETE FROM layouts WHERE user_id = ?').run((req as Authed).user.id);
    return { ok: true };
  });

  d.media?.register(app, audit, viewer, admin, operator);
  if (d.filesSocket) {
    const m = d.media;
    registerFiles(app, d.filesSocket, audit, admin, m ? { removed: (p) => m.libraryRemoved(p), restored: () => m.libraryRescan() } : undefined);
  }
  if (d.automations) registerAutomations(app, d.automations, events, audit, viewer, admin);
  if (d.backups) registerBackups(app, d.backups, audit, admin);
  registerStacks(app, agent, audit, events, viewer, admin);
  if (d.network) registerNetwork(app, d.network, audit, viewer, admin);
  if (d.metrics) registerMetrics(app, d.metrics, viewer);
  if (d.launcher) registerLauncher(app, d.launcher, audit, viewer, admin);
  if (d.bot) registerTelegram(app, d.bot, audit, viewer, admin);
  if (d.digest) registerDigest(app, d.digest, audit, admin);
  if (d.updates) registerUpdates(app, d.updates, audit, viewer, admin);
  if (d.workflows) registerWorkflows(app, d.workflows, audit, admin, operator);

  app.get('/api/v1/health', async () => ({ ok: true }));
}
