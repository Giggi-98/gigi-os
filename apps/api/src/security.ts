// Password (scrypt), sessioni opache con hash in DB, CSRF per sessione, RBAC e audit log.
import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from './db.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const N = 2 ** 15;
const R = 8;
const P = 1;
const MAXMEM = 64 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const got = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: MAXMEM,
  });
  return timingSafeEqual(expected, got);
}

/** Hash fittizio per uniformare i tempi quando l'utente non esiste. */
export const DUMMY_HASH =
  'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

export function passwordProblems(pw: string, username: string): string | null {
  if (pw.length < 12) return 'La password deve avere almeno 12 caratteri';
  if (pw.length > 256) return 'Password troppo lunga';
  if (pw.toLowerCase().includes(username.toLowerCase())) return 'La password non deve contenere il nome utente';
  return null;
}

export type Role = 'admin' | 'operator' | 'viewer';
/** Gerarchia dei ruoli (D-028): ogni livello include i permessi di quelli inferiori. */
export const ROLE_LEVEL: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };
export const atLeast = (role: Role, min: Role) => (ROLE_LEVEL[role] ?? -1) >= ROLE_LEVEL[min];
/** `mfa`: l'utente ha la verifica in due passaggi attiva. */
export type SessionUser = { id: string; username: string; role: Role; csrf: string; tokenHash: string; mfa: boolean };

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

export const COOKIE = 'gigi_session';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export class Sessions {
  constructor(private db: DB, private idleMs: number, private maxMs: number) {}

  create(userId: string, ip: string, ua: string) {
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(24).toString('base64url');
    const now = Date.now();
    this.db
      .prepare('INSERT INTO sessions (token_hash, user_id, csrf, created_at, last_seen, expires_at, ip, user_agent) VALUES (?,?,?,?,?,?,?,?)')
      .run(sha256(token), userId, csrf, now, now, now + this.maxMs, ip, ua.slice(0, 300));
    return { token, csrf };
  }

  resolve(token: string | undefined): SessionUser | null {
    if (!token || token.length > 100) return null;
    const th = sha256(token);
    const row = this.db
      .prepare(
        `SELECT s.token_hash, s.csrf, s.last_seen, s.expires_at, u.id, u.username, u.role, u.disabled, COALESCE(m.enabled, 0) AS mfa
         FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN user_mfa m ON m.user_id = u.id WHERE s.token_hash = ?`,
      )
      .get(th) as
      | { token_hash: string; csrf: string; last_seen: number; expires_at: number; id: string; username: string; role: Role; disabled: number; mfa: number }
      | undefined;
    if (!row) return null;
    const now = Date.now();
    if (row.disabled || row.expires_at < now || now - row.last_seen > this.idleMs) {
      this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(th);
      return null;
    }
    if (now - row.last_seen > 60_000) this.db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(now, th);
    return { id: row.id, username: row.username, role: row.role, csrf: row.csrf, tokenHash: th, mfa: !!row.mfa };
  }

  destroy(tokenHash: string) {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  destroyForUser(userId: string, exceptTokenHash?: string) {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, exceptTokenHash ?? '');
  }

  purge() {
    const now = Date.now();
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ? OR last_seen < ?').run(now, now - this.idleMs);
  }
}

/** Limitatore tentativi di login persistente (sopravvive ai riavvii). */
export class LoginLimiter {
  constructor(private db: DB, private max = 8, private windowMs = 15 * 60_000) {}

  blocked(keys: string[]): boolean {
    const since = Date.now() - this.windowMs;
    return keys.some(
      (k) => (this.db.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE key = ? AND ts > ?').get(k, since) as { n: number }).n >= this.max,
    );
  }

  fail(keys: string[]) {
    const now = Date.now();
    for (const k of keys) this.db.prepare('INSERT INTO login_attempts (key, ts) VALUES (?, ?)').run(k, now);
  }

  clear(keys: string[]) {
    for (const k of keys) this.db.prepare('DELETE FROM login_attempts WHERE key = ?').run(k);
  }

  purge() {
    this.db.prepare('DELETE FROM login_attempts WHERE ts < ?').run(Date.now() - this.windowMs);
  }
}

export class Audit {
  constructor(private db: DB) {}

  log(req: FastifyRequest | null, action: string, result: 'ok' | 'denied' | 'error', target?: string | null, details?: unknown) {
    this.db
      .prepare('INSERT INTO audit_log (ts, user_id, username, action, target, result, ip, details) VALUES (?,?,?,?,?,?,?,?)')
      .run(
        Date.now(),
        req?.user?.id ?? null,
        req?.user?.username ?? null,
        action,
        target ?? null,
        result,
        req?.ip ?? null,
        details === undefined ? null : JSON.stringify(details),
      );
  }

  purge(days: number) {
    this.db.prepare('DELETE FROM audit_log WHERE ts < ?').run(Date.now() - days * 86400_000);
  }
}

export function requireUser(req: FastifyRequest, reply: FastifyReply): req is FastifyRequest & { user: SessionUser } {
  if (!req.user) {
    void reply.code(401).send({ error: 'Autenticazione richiesta' });
    return false;
  }
  return true;
}

export function newId() {
  return randomUUID();
}
