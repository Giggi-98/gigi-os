// Costruzione dell'app Fastify: sicurezza trasversale (sessione, CSRF, header) + registrazione route.
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { AgentClient } from './agent.js';
import { AgentError } from './agent.js';
import { ConnectorError } from './connectors/types.js';
import type { DB } from './db.js';
import type { Events } from './events.js';
import type { Integrations } from './integrations.js';
import type { MediaBridge } from './media.js';
import type { Automations } from './automations.js';
import type { Backups } from './backup.js';
import type { Network } from './network.js';
import type { Metrics } from './metrics.js';
import type { Mfa } from './mfa.js';
import type { Launcher } from './launcher.js';
import { registerRoutes } from './routes.js';
import { Audit, COOKIE, LoginLimiter, Sessions } from './security.js';
import { TargetError } from './ssrf.js';

export type Deps = {
  db: DB;
  agent: AgentClient;
  integrations: Integrations;
  events: Events;
  sessions: Sessions;
  limiter: LoginLimiter;
  audit: Audit;
  secureCookies: boolean;
  setupToken: () => string | null;
  consumeSetupToken: () => void;
  webDir?: string;
  logger?: boolean | object;
  trustProxy?: boolean;
  https?: { cert: Buffer; key: Buffer } | null;
  media?: MediaBridge;
  filesSocket?: string;
  automations?: Automations;
  backups?: Backups;
  network?: Network;
  metrics?: Metrics;
  /** Verifica in due passaggi; assente nei test che non la riguardano. */
  mfa?: Mfa;
  launcher?: Launcher;
};

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const CSRF_EXEMPT = new Set(['/api/v1/auth/login', '/api/v1/auth/login/mfa', '/api/v1/auth/setup']);

export async function buildApp(deps: Deps): Promise<FastifyInstance> {
  const app = Fastify({
    ...(deps.https ? { https: deps.https } : {}),
    logger: deps.logger ?? false,
    trustProxy: deps.trustProxy ?? false,
    bodyLimit: 256 * 1024,
  });

  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute', allowList: [] });

  app.decorateRequest('user', null);

  app.addHook('onRequest', async (req, reply) => {
    req.user = deps.sessions.resolve(req.cookies[COOKIE]);
    if (!req.url.startsWith('/api/')) return;
    if (MUTATING.has(req.method)) {
      // Origin, se presente, deve coincidere con l'host servito (difesa CSRF aggiuntiva)
      const origin = req.headers.origin;
      if (origin && origin !== 'null') {
        try {
          if (new URL(origin).host !== req.headers.host) return reply.code(403).send({ error: 'Origine non consentita' });
        } catch {
          return reply.code(403).send({ error: 'Origine non valida' });
        }
      }
      const pathOnly = req.url.split('?')[0];
      if (!CSRF_EXEMPT.has(pathOnly)) {
        if (!req.user) return reply.code(401).send({ error: 'Autenticazione richiesta' });
        if (req.headers['x-csrf-token'] !== req.user.csrf) return reply.code(403).send({ error: 'Token CSRF mancante o non valido' });
      }
    }
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    // Una route può impostare una CSP più restrittiva (es. icone di terzi in sandbox) o una cache esplicita: non si sovrascrivono.
    if (!reply.hasHeader('Content-Security-Policy'))
      reply.header(
        'Content-Security-Policy',
        "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
    if (req.url.startsWith('/api/') && !reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    if (err instanceof ConnectorError) return reply.code(err.httpStatus).send({ error: err.message, status: err.status });
    if (err instanceof TargetError) return reply.code(400).send({ error: err.message, status: 'error' });
    if (err instanceof AgentError) return reply.code(err.status >= 500 ? 502 : err.status).send({ error: err.message });
    if ((err as { name?: string }).name === 'ZodError') {
      return reply.code(400).send({ error: 'Dati non validi', issues: (err as unknown as { issues: unknown }).issues });
    }
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    req.log.error({ err: err.message }, 'unhandled');
    return reply.code(500).send({ error: 'Errore interno' });
  });

  await registerRoutes(app, deps);

  if (deps.webDir && existsSync(path.join(deps.webDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: deps.webDir, wildcard: false, maxAge: '1h', index: false });
    const sendIndex = (_req: FastifyRequest, reply: FastifyReply) => reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    app.get('/', sendIndex);
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Endpoint inesistente' });
      if (req.method === 'GET' && !path.extname(req.url.split('?')[0])) return sendIndex(req, reply);
      return reply.code(404).send('Not found');
    });
  }

  return app;
}
