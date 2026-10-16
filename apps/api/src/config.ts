import { readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const env = process.env;

function list(v: string | undefined, def: string) {
  return (v ?? def).split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Rete LAN dell'interfaccia che ha l'IP di ascolto (es. 192.168.1.20 con netmask /24 → 192.168.1.0/24): è il valore
 * predefinito delle destinazioni consentite ai connettori quando GIGI_ALLOWED_TARGETS non è impostata.
 */
export function lanOf(ip: string | undefined, ifaces = os.networkInterfaces()): string[] {
  if (!ip) return [];
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) {
      if (a.address !== ip || a.family !== 'IPv4' || !a.cidr) continue;
      const bits = Number(a.cidr.split('/')[1]);
      const n = a.address.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      const net = (n & mask) >>> 0;
      return [`${[24, 16, 8, 0].map((sh) => (net >>> sh) & 255).join('.')}/${bits}`];
    }
  }
  return [];
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
  allowedTargets: list(env.GIGI_ALLOWED_TARGETS, ['127.0.0.0/8', '::1/128', ...lanOf(env.GIGI_BIND)].join(',')),
  sessionIdleHours: Number(env.GIGI_SESSION_IDLE_HOURS ?? 12),
  sessionMaxDays: Number(env.GIGI_SESSION_MAX_DAYS ?? 7),
  healthIntervalMs: Number(env.GIGI_HEALTH_INTERVAL_MS ?? 60000),
  auditRetentionDays: Number(env.GIGI_AUDIT_RETENTION_DAYS ?? 180),
  /** Versione in uso (stessa delle immagini) e repo GitHub «owner/nome» da cui leggere le release (D-032). */
  version: env.GIGI_VERSION ?? '0.0.0',
  releaseRepo: /^[\w.-]+\/[\w.-]+$/.test(env.GIGI_RELEASE_REPO ?? '') ? env.GIGI_RELEASE_REPO! : null,
  // Stesso formato dell'agent («Etichetta=/percorso» oppure «/percorso»)
  stackRoots: list(env.GIGI_STACK_ROOTS, '/opt/stacks').map((s) => s.slice(s.indexOf('=') + 1)),
  /** Giorni di storico delle metriche (D-027). */
  metricsDays: Math.min(Math.max(Number(env.GIGI_METRICS_DAYS ?? 30) || 30, 1), 365),
  logLevel: env.GIGI_LOG_LEVEL ?? 'warn',
};

export function tlsOptions(): { cert: Buffer; key: Buffer } | null {
  if (!config.tlsCert || !config.tlsKey) return null;
  if (!existsSync(config.tlsCert) || !existsSync(config.tlsKey)) return null;
  return { cert: readFileSync(config.tlsCert), key: readFileSync(config.tlsKey) };
}
