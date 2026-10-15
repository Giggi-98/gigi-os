import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const env = process.env;

function list(v: string | undefined, def: string) {
  return (v ?? def).split(',').map((s) => s.trim()).filter(Boolean);
}

export const config = {
  host: env.GIGI_BIND ?? '127.0.0.1',
  port: Number(env.GIGI_PORT ?? 8470),
  dataDir: env.GIGI_DATA_DIR ?? path.resolve('data'),
  webDir: env.GIGI_WEB_DIR ?? path.resolve('apps/web/dist'),
  agentSocket: env.GIGI_AGENT_SOCKET ?? '/run/gigi/agent.sock',
  masterKeyFile: env.GIGI_MASTER_KEY_FILE ?? path.resolve('secrets/master.key'),
  tlsCert: env.GIGI_TLS_CERT ?? '',
  tlsKey: env.GIGI_TLS_KEY ?? '',
  /** Destinazioni consentite per i connettori (difesa SSRF). */
  allowedTargets: list(env.GIGI_ALLOWED_TARGETS, '127.0.0.0/8,::1/128,192.168.222.0/24'),
  sessionIdleHours: Number(env.GIGI_SESSION_IDLE_HOURS ?? 12),
  sessionMaxDays: Number(env.GIGI_SESSION_MAX_DAYS ?? 7),
  healthIntervalMs: Number(env.GIGI_HEALTH_INTERVAL_MS ?? 60000),
  auditRetentionDays: Number(env.GIGI_AUDIT_RETENTION_DAYS ?? 180),
  logLevel: env.GIGI_LOG_LEVEL ?? 'warn',
};

export function tlsOptions(): { cert: Buffer; key: Buffer } | null {
  if (!config.tlsCert || !config.tlsKey) return null;
  if (!existsSync(config.tlsCert) || !existsSync(config.tlsKey)) return null;
  return { cert: readFileSync(config.tlsCert), key: readFileSync(config.tlsKey) };
}
