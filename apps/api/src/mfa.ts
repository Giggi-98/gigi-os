// Verifica in due passaggi (D-029): TOTP RFC 6238 (HMAC-SHA1, 6 cifre, 30 s) con node:crypto, nessuna dipendenza.
// Segreto cifrato nel vault, codice non riutilizzabile, codici di recupero monouso salvati come SHA-256.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DB } from './db.js';
import type { Role } from './security.js';
import type { Vault } from './vault.js';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_MS = 30_000;
export const ISSUER = 'GIGI OS';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('Carattere base32 non valido');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** HOTP (RFC 4226) con troncamento dinamico. */
export function hotp(key: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', key).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** Restituisce l'intervallo del codice valido (±1 per lo scarto d'orologio) e successivo a `lastStep`, altrimenti null. */
export function verifyTotp(secretB32: string, code: string, now: number, lastStep = 0): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const key = base32Decode(secretB32);
  const cur = Math.floor(now / STEP_MS);
  for (const step of [cur - 1, cur, cur + 1]) {
    if (step <= lastStep) continue;
    if (timingSafeEqual(Buffer.from(hotp(key, step)), Buffer.from(code))) return step;
  }
  return null;
}

export const otpauthUri = (secret: string, username: string) =>
  `otpauth://totp/${encodeURIComponent(`${ISSUER}:${username}`)}?secret=${secret}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=6&period=30`;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const normRecovery = (c: string) => c.toUpperCase().replace(/[^A-Z2-7]/g, '');

/** Ruoli per cui la verifica in due passaggi è obbligatoria (scelta dell'utente, 2026-10-16). */
export const MFA_REQUIRED: ReadonlySet<Role> = new Set(['admin', 'operator']);

type Row = { secret_enc: string; enabled: number; last_step: number; recovery: string };

export class Mfa {
  private tickets = new Map<string, { userId: string; exp: number; tries: number }>();

  constructor(
    private db: DB,
    private vault: Vault,
    private now = () => Date.now(),
  ) {}

  private row(userId: string) {
    return this.db.prepare('SELECT secret_enc, enabled, last_step, recovery FROM user_mfa WHERE user_id = ?').get(userId) as Row | undefined;
  }

  enabled(userId: string) {
    return !!this.row(userId)?.enabled;
  }

  /** Nuovo segreto in attesa di conferma (sostituisce un'eventuale configurazione non completata). */
  begin(userId: string, username: string) {
    if (this.enabled(userId)) throw Object.assign(new Error('La verifica in due passaggi è già attiva'), { statusCode: 409 });
    const secret = base32Encode(randomBytes(20));
    this.db
      .prepare(
        `INSERT INTO user_mfa (user_id, secret_enc, enabled, last_step, recovery, created_at) VALUES (?, ?, 0, 0, '[]', ?)
         ON CONFLICT (user_id) DO UPDATE SET secret_enc = excluded.secret_enc, enabled = 0, last_step = 0, recovery = '[]', created_at = excluded.created_at, enabled_at = NULL`,
      )
      .run(userId, this.vault.encrypt(secret, `mfa:${userId}`), this.now());
    return { secret, uri: otpauthUri(secret, username) };
  }

  /** Conferma con un codice dell'app: attiva e restituisce i codici di recupero (mostrati una sola volta). */
  confirm(userId: string, code: string): string[] | null {
    const r = this.row(userId);
    if (!r || r.enabled) return null;
    const step = verifyTotp(this.vault.decrypt(r.secret_enc, `mfa:${userId}`), code.trim(), this.now(), r.last_step);
    if (step === null) return null;
    const codes = this.newRecovery();
    this.db
      .prepare('UPDATE user_mfa SET enabled = 1, last_step = ?, recovery = ?, enabled_at = ? WHERE user_id = ?')
      .run(step, JSON.stringify(codes.map((c) => sha256(normRecovery(c)))), this.now(), userId);
    return codes;
  }

  /** Codice TOTP o di recupero. Restituisce il tipo usato, oppure null. */
  verify(userId: string, input: string): 'totp' | 'recovery' | null {
    const r = this.row(userId);
    if (!r?.enabled) return null;
    const code = input.trim();
    if (/^\d{6}$/.test(code)) {
      const step = verifyTotp(this.vault.decrypt(r.secret_enc, `mfa:${userId}`), code, this.now(), r.last_step);
      if (step === null) return null;
      this.db.prepare('UPDATE user_mfa SET last_step = ? WHERE user_id = ?').run(step, userId);
      return 'totp';
    }
    const n = normRecovery(code);
    if (n.length !== 8) return null;
    const left = JSON.parse(r.recovery) as string[];
    const h = sha256(n);
    if (!left.includes(h)) return null;
    this.db.prepare('UPDATE user_mfa SET recovery = ? WHERE user_id = ?').run(JSON.stringify(left.filter((x) => x !== h)), userId);
    return 'recovery';
  }

  recoveryLeft(userId: string) {
    const r = this.row(userId);
    return r?.enabled ? (JSON.parse(r.recovery) as string[]).length : 0;
  }

  regenerateRecovery(userId: string) {
    const codes = this.newRecovery();
    this.db.prepare('UPDATE user_mfa SET recovery = ? WHERE user_id = ? AND enabled = 1').run(JSON.stringify(codes.map((c) => sha256(normRecovery(c)))), userId);
    return codes;
  }

  disable(userId: string) {
    this.db.prepare('DELETE FROM user_mfa WHERE user_id = ?').run(userId);
  }

  private newRecovery() {
    return Array.from({ length: 10 }, () => {
      const c = base32Encode(randomBytes(5));
      return `${c.slice(0, 4)}-${c.slice(4, 8)}`;
    });
  }

  // Secondo passaggio del login: biglietto monouso in memoria, 5 minuti, al massimo 5 tentativi.
  ticket(userId: string) {
    const t = randomBytes(32).toString('base64url');
    const now = this.now();
    for (const [k, v] of this.tickets) if (v.exp < now) this.tickets.delete(k);
    this.tickets.set(t, { userId, exp: now + 5 * 60_000, tries: 0 });
    return t;
  }

  /** userId del biglietto se ancora valido; ogni chiamata consuma un tentativo. */
  useTicket(t: string): string | null {
    const v = this.tickets.get(t);
    if (!v || v.exp < this.now() || v.tries >= 5) {
      this.tickets.delete(t);
      return null;
    }
    v.tries++;
    return v.userId;
  }

  dropTicket(t: string) {
    this.tickets.delete(t);
  }
}
