// Gestione integrazioni: CRUD, vault, test connessione, health periodico, lettura risorse con cache breve.
import type { BlockList } from 'node:net';
import { z } from 'zod';
import { connectors } from './connectors/index.js';
import { forgetSession } from './connectors/qbittorrent.js';
import { ConnectorError, type ConnectorContext, type Status, type TestResult } from './connectors/types.js';
import type { DB } from './db.js';
import type { Events } from './events.js';
import { newId } from './security.js';
import { safeFetch, TargetError, validateUrl } from './ssrf.js';
import type { Vault } from './vault.js';

type Row = {
  id: string;
  type: string;
  name: string;
  base_url: string;
  auth_type: string;
  secret_enc: string | null;
  config: string;
  enabled: number;
  created_at: number;
  updated_at: number;
  last_status: Status | null;
  last_message: string | null;
  last_checked: number | null;
  last_latency: number | null;
};

export const integrationInput = z.object({
  type: z.string().min(1).max(40),
  name: z.string().trim().min(1).max(60),
  baseUrl: z.string().trim().min(1).max(300),
  auth: z.string().min(1).max(40),
  secret: z.record(z.string().max(2000)).optional(),
  config: z.record(z.string().max(300)).optional(),
  enabled: z.boolean().optional(),
});
export type IntegrationInput = z.infer<typeof integrationInput>;

export class Integrations {
  private cache = new Map<string, { t: number; data: unknown }>();

  constructor(
    private db: DB,
    private vault: Vault,
    private allowed: BlockList,
    private events: Events,
  ) {}

  private rows(): Row[] {
    return this.db.prepare('SELECT * FROM integrations ORDER BY created_at').all() as Row[];
  }

  private row(id: string): Row {
    const r = this.db.prepare('SELECT * FROM integrations WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new ConnectorError('Integrazione non trovata', 'error', 404);
    return r;
  }

  /** Vista pubblica: MAI segreti, solo quali campi sono valorizzati. */
  view(r: Row) {
    const def = connectors[r.type];
    let secretKeys: string[] = [];
    if (r.secret_enc) {
      try {
        secretKeys = Object.keys(JSON.parse(this.vault.decrypt(r.secret_enc, r.id)));
      } catch {
        secretKeys = ['?'];
      }
    }
    const cfg = JSON.parse(r.config) as Record<string, string>;
    return {
      id: r.id,
      type: r.type,
      typeLabel: def?.label ?? r.type,
      name: r.name,
      baseUrl: r.base_url,
      webUrl: cfg.webUrl || def?.defaultWebUrl || r.base_url,
      auth: r.auth_type,
      secretFields: secretKeys,
      config: cfg,
      enabled: !!r.enabled,
      capabilities: def?.capabilities ?? [],
      status: r.enabled ? (r.last_status ?? null) : 'disabled',
      message: r.last_message,
      lastChecked: r.last_checked,
      latency: r.last_latency,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  list() {
    return this.rows().map((r) => this.view(r));
  }

  get(id: string) {
    return this.view(this.row(id));
  }

  private validate(input: IntegrationInput, existingSecret?: Record<string, string>) {
    const def = connectors[input.type];
    if (!def) throw new ConnectorError('Tipo di integrazione sconosciuto', 'error', 400);
    const method = def.auth.find((a) => a.id === input.auth);
    if (!method) throw new ConnectorError('Metodo di autenticazione non supportato', 'error', 400);
    const u = validateUrl(input.baseUrl);
    const baseUrl = u.origin + u.pathname.replace(/\/+$/, '');
    const secret: Record<string, string> = {};
    for (const f of method.fields) {
      const v = input.secret?.[f.key] || existingSecret?.[f.key] || '';
      if (f.required && !v) throw new ConnectorError(`Campo obbligatorio: ${f.label}`, 'error', 400);
      if (v) secret[f.key] = v;
    }
    const allowedCfg = new Set([...(def.configFields ?? []).map((f) => f.key), 'container', 'webUrl']);
    const config: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.config ?? {})) if (allowedCfg.has(k) && v) config[k] = v;
    if (config.webUrl) validateUrl(config.webUrl);
    if (!('container' in config) && def.defaultContainer) config.container = def.defaultContainer;
    return { def, baseUrl, secret, config };
  }

  create(input: IntegrationInput) {
    const { baseUrl, secret, config } = this.validate(input);
    const id = newId();
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO integrations (id, type, name, base_url, auth_type, secret_enc, config, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        input.type,
        input.name,
        baseUrl,
        input.auth,
        Object.keys(secret).length ? this.vault.encrypt(JSON.stringify(secret), id) : null,
        JSON.stringify(config),
        input.enabled === false ? 0 : 1,
        now,
        now,
      );
    return id;
  }

  update(id: string, input: IntegrationInput) {
    const r = this.row(id);
    if (r.type !== input.type) throw new ConnectorError('Il tipo non può essere cambiato', 'error', 400);
    const existing = r.secret_enc && r.auth_type === input.auth ? (JSON.parse(this.vault.decrypt(r.secret_enc, id)) as Record<string, string>) : undefined;
    const { baseUrl, secret, config } = this.validate(input, existing);
    this.db
      .prepare('UPDATE integrations SET name=?, base_url=?, auth_type=?, secret_enc=?, config=?, enabled=?, updated_at=? WHERE id=?')
      .run(
        input.name,
        baseUrl,
        input.auth,
        Object.keys(secret).length ? this.vault.encrypt(JSON.stringify(secret), id) : null,
        JSON.stringify(config),
        input.enabled === false ? 0 : 1,
        Date.now(),
        id,
      );
    forgetSession(id);
    this.invalidate(id);
  }

  remove(id: string) {
    this.row(id);
    this.db.prepare('DELETE FROM integrations WHERE id = ?').run(id);
    forgetSession(id);
    this.invalidate(id);
  }

  private invalidate(id: string) {
    for (const k of this.cache.keys()) if (k.startsWith(`${id}:`)) this.cache.delete(k);
  }

  private ctx(r: Row): ConnectorContext {
    const secret = r.secret_enc ? (JSON.parse(this.vault.decrypt(r.secret_enc, r.id)) as Record<string, string>) : {};
    return {
      id: r.id,
      baseUrl: r.base_url,
      auth: r.auth_type,
      secret,
      config: JSON.parse(r.config),
      http: (p, init) => safeFetch(this.allowed, r.base_url + p, init),
    };
  }

  private static toResult(e: unknown): TestResult {
    if (e instanceof ConnectorError) return { status: e.status, message: e.message };
    if (e instanceof TargetError) {
      return { status: e.code === 'forbidden_target' || e.code === 'bad_url' ? 'error' : 'offline', message: e.message };
    }
    return { status: 'error', message: (e as Error).message ?? 'Errore' };
  }

  async runTest(ctx: ConnectorContext, type: string): Promise<TestResult & { latency: number }> {
    const def = connectors[type];
    const t = Date.now();
    try {
      const r = await def.test(ctx);
      return { ...r, latency: Date.now() - t };
    } catch (e) {
      return { ...Integrations.toResult(e), latency: Date.now() - t };
    }
  }

  /** Test di una configurazione non ancora salvata (wizard). */
  async testDraft(input: IntegrationInput, existingId?: string) {
    const existing = existingId ? this.row(existingId) : null;
    const existingSecret =
      existing?.secret_enc && existing.auth_type === input.auth
        ? (JSON.parse(this.vault.decrypt(existing.secret_enc, existing.id)) as Record<string, string>)
        : undefined;
    const { baseUrl, secret, config } = this.validate(input, existingSecret);
    const id = existingId ?? `draft-${newId()}`;
    const ctx: ConnectorContext = {
      id,
      baseUrl,
      auth: input.auth,
      secret,
      config,
      http: (p, init) => safeFetch(this.allowed, baseUrl + p, init),
    };
    if (!existingId) forgetSession(id);
    return this.runTest(ctx, input.type);
  }

  async check(id: string) {
    const r = this.row(id);
    const res = await this.runTest(this.ctx(r), r.type);
    const prev = r.last_status;
    this.db
      .prepare('UPDATE integrations SET last_status=?, last_message=?, last_checked=?, last_latency=? WHERE id=?')
      .run(res.status, res.message, Date.now(), res.latency, id);
    if (prev && prev !== res.status) {
      const bad = ['offline', 'unhealthy', 'unauthorized', 'error'].includes(res.status);
      this.events.add(bad ? 'warning' : 'info', 'integrazioni', `${r.name}: ${statusLabel(res.status)}`, res.message, `int:${id}:${res.status}`);
    }
    return res;
  }

  async checkAll() {
    for (const r of this.rows().filter((r) => r.enabled)) {
      await this.check(r.id).catch(() => undefined);
    }
  }

  async resource(id: string, name: string, params: URLSearchParams, ttlMs = 10_000) {
    const r = this.row(id);
    if (!r.enabled) throw new ConnectorError('Integrazione disabilitata', 'error', 409);
    const def = connectors[r.type];
    const fn = def?.resources[name];
    if (!fn) throw new ConnectorError('Risorsa non supportata da questa integrazione', 'unsupported', 404);
    const key = `${id}:${name}:${params.toString()}`;
    const c = this.cache.get(key);
    if (c && Date.now() - c.t < ttlMs) return c.data;
    try {
      const data = await fn(this.ctx(r), params);
      this.cache.set(key, { t: Date.now(), data });
      return data;
    } catch (e) {
      const res = Integrations.toResult(e);
      throw new ConnectorError(res.message, res.status, e instanceof ConnectorError ? e.httpStatus : 502);
    }
  }

  isAdminResource(id: string, name: string) {
    const r = this.row(id);
    return (connectors[r.type]?.adminResources ?? []).includes(name);
  }

  async action(id: string, name: string, body: unknown) {
    const r = this.row(id);
    if (!r.enabled) throw new ConnectorError('Integrazione disabilitata', 'error', 409);
    const fn = connectors[r.type]?.actions?.[name];
    if (!fn) throw new ConnectorError('Azione non supportata da questa integrazione', 'unsupported', 404);
    try {
      const out = await fn(this.ctx(r), body);
      this.invalidate(id);
      return { integration: r.name, result: out };
    } catch (e) {
      const res = Integrations.toResult(e);
      throw new ConnectorError(res.message, res.status, e instanceof ConnectorError ? e.httpStatus : 502);
    }
  }

  contextFor(id: string) {
    const r = this.row(id);
    return { row: r, ctx: this.ctx(r) };
  }

  seed(types: string[]) {
    const existing = new Set(this.rows().map((r) => r.type));
    for (const t of types) {
      const def = connectors[t];
      if (!def || existing.has(t)) continue;
      const open = def.auth.find((a) => a.fields.every((f) => !f.required));
      if (!open) continue;
      this.create({ type: t, name: def.defaultName, baseUrl: def.defaultUrl, auth: open.id });
    }
  }
}

export function statusLabel(s: Status | string) {
  return (
    {
      online: 'online',
      unhealthy: 'non in salute',
      offline: 'offline',
      unauthorized: 'accesso negato',
      unconfigured: 'non configurato',
      unsupported: 'non supportato',
      error: 'errore',
    } as Record<string, string>
  )[s] ?? s;
}
