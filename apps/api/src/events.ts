// Registro eventi (feed "eventi recenti" della dashboard) con deduplicazione e retention,
// alimentato dagli eventi Docker dell'agent e dai controlli periodici.
import { createInterface } from 'node:readline';
import type { AgentClient } from './agent.js';
import type { DB } from './db.js';

export type Level = 'info' | 'warning' | 'error';

export class Events {
  /** Agganciato dalle automazioni: riceve ogni evento effettivamente registrato (dopo la deduplicazione). */
  onAdd: ((e: { level: Level; source: string; title: string; details?: string | null }) => void) | null = null;

  constructor(private db: DB, private dedupWindowMs = 30 * 60_000) {}

  add(level: Level, source: string, title: string, details?: string | null, dedup?: string) {
    if (dedup) {
      const dup = this.db.prepare('SELECT 1 FROM events WHERE dedup = ? AND ts > ?').get(dedup, Date.now() - this.dedupWindowMs);
      if (dup) return;
    }
    this.db
      .prepare('INSERT INTO events (ts, level, source, title, details, dedup) VALUES (?,?,?,?,?,?)')
      .run(Date.now(), level, source, title, details ?? null, dedup ?? null);
    try {
      this.onAdd?.({ level, source, title, details });
    } catch {}
  }

  list(limit = 50, level?: Level) {
    const rows = level
      ? this.db.prepare('SELECT * FROM events WHERE level = ? ORDER BY ts DESC LIMIT ?').all(level, limit)
      : this.db.prepare('SELECT * FROM events ORDER BY ts DESC LIMIT ?').all(limit);
    return rows;
  }

  purge(days = 30) {
    this.db.prepare('DELETE FROM events WHERE ts < ?').run(Date.now() - days * 86400_000);
  }
}

const DOCKER_ACTIONS: Record<string, { level: Level; label: string }> = {
  die: { level: 'warning', label: 'si è arrestato' },
  oom: { level: 'error', label: 'terminato per memoria esaurita (OOM)' },
  'health_status: unhealthy': { level: 'error', label: 'è diventato unhealthy' },
  'health_status: healthy': { level: 'info', label: 'è tornato healthy' },
  start: { level: 'info', label: 'avviato' },
  restart: { level: 'info', label: 'riavviato' },
  destroy: { level: 'warning', label: 'rimosso' },
};

/** Si collega allo stream eventi dell'agent con riconnessione a backoff esponenziale. */
export function followDockerEvents(agent: AgentClient, events: Events, log: (msg: string, extra?: object) => void) {
  let delay = 1000;
  const connect = async () => {
    try {
      const s = await agent.stream('/v1/events');
      delay = 1000;
      const rl = createInterface({ input: s });
      rl.on('line', (line) => {
        try {
          const e = JSON.parse(line) as { action: string; name: string | null; exitCode: string | null; id: string };
          const meta = DOCKER_ACTIONS[e.action];
          if (!meta || !e.name) return;
          const exit = e.action === 'die' && e.exitCode && e.exitCode !== '0' ? ` (exit ${e.exitCode})` : '';
          const level = e.action === 'die' && e.exitCode && e.exitCode !== '0' ? 'error' : meta.level;
          events.add(level, 'docker', `${e.name} ${meta.label}${exit}`, null, `docker:${e.name}:${e.action}:${Math.floor(Date.now() / 5000)}`);
        } catch {}
      });
      s.on('close', () => setTimeout(connect, delay));
    } catch (e) {
      log('docker events: agent non disponibile, nuovo tentativo', { delay, err: (e as Error).message });
      setTimeout(connect, delay);
      delay = Math.min(delay * 2, 60_000);
    }
  };
  void connect();
}
