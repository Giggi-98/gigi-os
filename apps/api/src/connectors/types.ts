import type { SafeResponse } from '../ssrf.js';

export type Status = 'online' | 'unhealthy' | 'offline' | 'unauthorized' | 'unconfigured' | 'unsupported' | 'error';

export type SecretField = { key: string; label: string; type: 'password' | 'text'; required: boolean; help?: string };

export type AuthMethod = {
  id: string;
  label: string;
  fields: SecretField[];
};

export type ConfigField = { key: string; label: string; placeholder?: string; help?: string };

export type HttpFn = (path: string, init?: RequestInit & { timeoutMs?: number; maxBytes?: number }) => Promise<SafeResponse>;

export type ConnectorContext = {
  id: string;
  baseUrl: string;
  auth: string;
  secret: Record<string, string>;
  config: Record<string, string>;
  http: HttpFn;
};

export type TestResult = {
  status: Status;
  message: string;
  version?: string | null;
  details?: Record<string, unknown>;
};

export type ConnectorDef = {
  type: string;
  label: string;
  description: string;
  defaultUrl: string;
  defaultName: string;
  /** container Docker associato di default, per collegare stato container e integrazione */
  defaultContainer?: string;
  /** URL da aprire nel browser, se diverso dal base URL interno */
  defaultWebUrl?: string;
  auth: AuthMethod[];
  configFields?: ConfigField[];
  capabilities: string[];
  test(ctx: ConnectorContext): Promise<TestResult>;
  resources: Record<string, (ctx: ConnectorContext, params: URLSearchParams) => Promise<unknown>>;
};

export class ConnectorError extends Error {
  constructor(message: string, public status: Status, public httpStatus = 502) {
    super(message);
  }
}

export function json<T>(r: SafeResponse): T {
  try {
    return JSON.parse(r.body.toString('utf8')) as T;
  } catch {
    throw new ConnectorError('Risposta non JSON dal servizio', 'error');
  }
}

export function expectOk(r: SafeResponse, what: string) {
  if (r.status === 401 || r.status === 403) throw new ConnectorError(`${what}: accesso negato (${r.status})`, 'unauthorized', 502);
  if (r.status >= 400) throw new ConnectorError(`${what}: HTTP ${r.status}`, 'error');
  return r;
}
