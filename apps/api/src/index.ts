import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AgentClient } from './agent.js';
import { buildApp } from './app.js';
import { config, tlsOptions } from './config.js';
import { openDb } from './db.js';
import { Events, followDockerEvents } from './events.js';
import { Integrations } from './integrations.js';
import { MediaBridge } from './media.js';
import { Automations, watchDownloads } from './automations.js';
import { Backups } from './backup.js';
import { getSetting, setSetting } from './db.js';
import { Audit, LoginLimiter, Sessions } from './security.js';
import { buildBlockList } from './ssrf.js';
import { Vault } from './vault.js';

const log = (level: string, msg: string, extra: object = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));

async function main() {
  const db = openDb(config.dataDir);
  const vault = Vault.fromFile(config.masterKeyFile);
  const agent = new AgentClient(config.agentSocket);
  const events = new Events(db);
  const integrations = new Integrations(db, vault, buildBlockList(config.allowedTargets), events);
  const sessions = new Sessions(db, config.sessionIdleHours * 3600_000, config.sessionMaxDays * 86400_000);
  const limiter = new LoginLimiter(db);
  const audit = new Audit(db);
  const automations = new Automations(db, vault, integrations, buildBlockList(config.allowedTargets), buildBlockList, (m, e) => log('warn', m, e ?? {}));
  automations.seedRules();
  events.onAdd = (e) => automations.onEvent(e);
  const backups = new Backups(db, config.dataDir, config.backupDir, config.backupExtra, config.masterKeyFile, events);
  backups.schedule((m, e) => log('warn', m, e ?? {}));
  const media = new MediaBridge(new AgentClient(config.mediaSocket, 'Motore media'), agent, integrations, events);

  // Codice di setup monouso: serve solo finché non esiste alcun utente.
  const tokenFile = path.join(config.dataDir, 'setup-token');
  let setupToken: string | null = null;
  const hasUsers = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n > 0;
  if (!hasUsers) {
    setupToken = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : randomBytes(9).toString('base64url');
    writeFileSync(tokenFile, setupToken, { mode: 0o600 });
    log('warn', `SETUP RICHIESTO — codice di setup monouso: ${setupToken}`);
  } else if (existsSync(tokenFile)) rmSync(tokenFile);

  const tls = tlsOptions();
  const app = await buildApp({
    db,
    agent,
    integrations,
    events,
    sessions,
    limiter,
    audit,
    secureCookies: !!tls,
    setupToken: () => setupToken,
    consumeSetupToken: () => {
      setupToken = null;
      rmSync(tokenFile, { force: true });
    },
    webDir: config.webDir,
    logger: { level: config.logLevel },
    https: tls,
    media,
    filesSocket: config.filesSocket,
    automations,
    backups,
  });

  followDockerEvents(agent, events, (m, e) => log('warn', m, e ?? {}));

  // Manutenzione periodica: health integrazioni, disco, pulizia.
  const disks = async () => {
    try {
      const s = await agent.json<{ disks: { label: string; total: number; free: number; ok: boolean }[] }>('GET', '/v1/system');
      for (const dk of s.disks.filter((x) => x.ok && x.total > 0)) {
        const used = 1 - dk.free / dk.total;
        if (used > 0.9) events.add(used > 0.95 ? 'error' : 'warning', 'sistema', `Disco «${dk.label}» al ${Math.round(used * 100)}%`, null, `disk:${dk.label}`);
      }
    } catch {}
    try {
      const svc = await agent.json<{ name: string; active: string }[]>('GET', '/v1/systemd/services');
      for (const u of svc.filter((x) => x.active === 'failed')) {
        events.add('warning', 'sistema', `Servizio ${u.name} in errore`, 'Dettagli nella pagina Sistema → Servizi', `systemd:${u.name}:${new Date().toISOString().slice(0, 10)}`);
      }
    } catch {}
  };
  setInterval(() => void integrations.checkAll(), config.healthIntervalMs).unref();
  setInterval(() => void media.scan('pianificazione').catch((e) => log('warn', 'scansione media non riuscita', { err: (e as Error).message })), config.mediaScanMs).unref();
  setInterval(() => void disks(), 5 * 60_000).unref();
  const downloads = watchDownloads(
    integrations,
    events,
    () => JSON.parse(getSetting(db, 'downloads.seen') ?? '[]') as string[],
    (h) => setSetting(db, 'downloads.seen', JSON.stringify(h)),
  );
  setInterval(() => void downloads().catch(() => undefined), 60_000).unref();
  setInterval(() => {
    sessions.purge();
    limiter.purge();
    audit.purge(config.auditRetentionDays);
    events.purge();
  }, 3600_000).unref();
  setTimeout(() => {
    void integrations.checkAll();
    void disks();
  }, 3000).unref();

  await app.listen({ host: config.host, port: config.port });
  log('info', 'GIGI OS API in ascolto', { host: config.host, port: config.port, tls: !!tls });

  const stop = async () => {
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((e) => {
  log('error', 'avvio fallito', { err: (e as Error).message });
  process.exit(1);
});
