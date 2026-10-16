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
  mediaSocket: env.GIGI_MEDIA_SOCKET ?? '/run/gigi/media.sock',
  filesSocket: env.GIGI_FILES_SOCKET ?? '/run/gigi/files.sock',
  backupDir: env.GIGI_BACKUP_DIR ?? path.resolve('backups'),
  backupExtra: list(env.GIGI_BACKUP_EXTRA, '').map((s) => { const [label, file] = s.split('='); return { label, file }; }).filter((x) => x.label && x.file),
  mediaScanMs: Number(env.GIGI_MEDIA_SCAN_MS ?? 120_000),
  masterKeyFile: env.GIGI_MASTER_KEY_FILE ?? path.resolve('secrets/master.key'),
  tlsCert: env.GIGI_TLS_CERT ?? '',
  tlsKey: env.GIGI_TLS_KEY ?? '',
  /** Destinazioni consentite per i connettori (difesa SSRF). */
  allowedTargets: list(env.GIGI_ALLOWED_TARGETS, '127.0.0.0/8,::1/128,192.168.222.0/24'),
  sessionIdleHours: Number(env.GIGI_SESSION_IDLE_HOURS ?? 12),
  sessionMaxDays: Number(env.GIGI_SESSION_MAX_DAYS ?? 7),
  healthIntervalMs: Number(env.GIGI_HEALTH_INTERVAL_MS ?? 60000),
  auditRetentionDays: Number(env.GIGI_AUDIT_RETENTION_DAYS ?? 180),
  /** Versione in uso (stessa delle immagini) e repo GitHub «owner/nome» da cui leggere le release (D-032). */
  version: env.GIGI_VERSION ?? '0.0.0',
  releaseRepo: /^[\w.-]+\/[\w.-]+$/.test(env.GIGI_RELEASE_REPO ?? '') ? env.GIGI_RELEASE_REPO! : null,
  stackRoots: list(env.GIGI_STACK_ROOTS, '/opt/stacks'),
  /** Giorni di storico delle metriche (D-027). */
  metricsDays: Math.min(Math.max(Number(env.GIGI_METRICS_DAYS ?? 30) || 30, 1), 365),
  logLevel: env.GIGI_LOG_LEVEL ?? 'warn',
};

export function tlsOptions(): { cert: Buffer; key: Buffer } | null {
  if (!config.tlsCert || !config.tlsKey) return null;
  if (!existsSync(config.tlsCert) || !existsSync(config.tlsKey)) return null;
  return { cert: readFileSync(config.tlsCert), key: readFileSync(config.tlsKey) };
}
