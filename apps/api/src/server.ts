import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { ZodError } from 'zod';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { Logger as PinoLogger } from 'pino';
import { safeEqual } from './lib/crypto.js';
import { captureException, createMetrics } from './observability.js';
import type { Ctx } from './context.js';
import { AppError, forbidden, unauthorized } from './lib/errors.js';
import { authenticateApiKey } from './domain/apikeys.js';
import { userFromToken, type User } from './domain/users.js';
import { publicRoutes } from './routes/public.js';
import { orderRoutes } from './routes/orders.js';
import { sellerRoutes } from './routes/seller.js';
import { merchantRoutes } from './routes/merchant.js';
import { integrationRoutes } from './routes/integrations.js';
import { adminRoutes } from './routes/admin.js';
import { registerGateway } from './ws/gateway.js';
import { sandboxRoutes } from './routes/sandbox.js';
import { buildOpenApi } from './openapi.js';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
    apiScopes: string[] | null;
    staffMfaRequired: boolean;
    rawBody?: Buffer;
  }
}

export interface RequestMeta {
  ip: string;
  ipCountry?: string;
  device?: string;
}

let geoHeader: string | undefined;

export function requestMeta(req: FastifyRequest): RequestMeta {
  // Only the edge's own header is believed; a client-sent one would let buyers fake their country.
  const country = geoHeader ? req.headers[geoHeader] : undefined;
  const device = req.headers['x-device-fingerprint'];
  return {
    ip: req.ip,
    ipCountry: typeof country === 'string' ? country.toUpperCase() : undefined,
    device: typeof device === 'string' ? device.slice(0, 128) : undefined,
  };
}

/** Resolve the authenticated user from a session JWT. */
export function me(req: FastifyRequest): User {
  if (!req.user) throw unauthorized();
  return req.user;
}

export function requireRole(req: FastifyRequest, ...roles: Array<User['role']>): User {
  const user = me(req);
  if (!roles.includes(user.role)) throw forbidden('insufficient_role', 'Insufficient permissions');
  if (req.staffMfaRequired && !user.session_mfa) {
    throw forbidden('mfa_required', 'Staff actions need two-factor login. Turn it on in Account, then sign in again.');
  }
  return user;
}

/** Merchant API: authenticate with an API key and require a scope. */
export function requireScope(ctx: Ctx) {
  return (scope: string) => async (req: FastifyRequest) => {
    const header = req.headers.authorization ?? '';
    const key = header.startsWith('Bearer ') ? header.slice(7) : '';
    const { user, scopes } = await authenticateApiKey(ctx, key);
    if (!scopes.includes(scope)) throw forbidden('missing_scope', `API key lacks scope ${scope}`);
    req.user = user;
    req.apiScopes = scopes;
  };
}

export function parseTrustProxy(v: string): boolean | number | string[] {
  if (v === 'false' || v === '') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

export async function buildApp(ctx: Ctx, opts: { logger?: PinoLogger } = {}): Promise<FastifyInstance> {
  geoHeader = ctx.cfg.GEO_COUNTRY_HEADER;
  const app = Fastify({
    ...(opts.logger ? { loggerInstance: opts.logger } : { logger: false }),
    trustProxy: parseTrustProxy(ctx.cfg.TRUST_PROXY) as boolean, // hop counts are supported at runtime; the types omit them
    bodyLimit: 12 * 1024 * 1024,
    // Caller-supplied request ids are kept only if they are plain tokens (no log forging).
    genReqId: (req) => {
      const id = req.headers['x-request-id'];
      return typeof id === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(id) ? id : randomUUID();
    },
  }) as unknown as FastifyInstance;

  app.decorateRequest('user', null);
  app.decorateRequest('apiScopes', null);
  app.decorateRequest('staffMfaRequired', false);
  const staffMfaRequired = (ctx.cfg.STAFF_MFA_REQUIRED ?? (ctx.cfg.NODE_ENV === 'production' ? 'true' : 'false')) === 'true';

  // Keep the raw body: webhook signatures (PSP, KYC, indexer) are computed over exact bytes.
  const jsonParser = (req: FastifyRequest, body: Buffer, done: (err: Error | null, v?: unknown) => void) => {
    req.rawBody = body;
    if (!body.length) return done(null, {});
    try {
      done(null, JSON.parse(body.toString('utf8')));
    } catch {
      done(new AppError(400, 'invalid_json', 'Malformed JSON body'));
    }
  };
  app.addContentTypeParser(['application/json', 'application/csp-report', 'application/reports+json'], { parseAs: 'buffer' }, jsonParser as any);
  app.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, body, done) => done(null, body));
  // Chat evidence uploads arrive as raw image bytes; the handler sniffs the real type.
  app.addContentTypeParser(['image/png', 'image/jpeg', 'image/webp', 'application/octet-stream'], { parseAs: 'buffer', bodyLimit: 8 * 1024 * 1024 }, (_req, body, done) =>
    done(null, body),
  );
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) =>
    done(null, Object.fromEntries(new URLSearchParams(body as string))),
  );

  await app.register(cookie);
  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-site' } });
  await app.register(cors, {
    origin: [ctx.cfg.PUBLIC_WEB_URL],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Device-Fingerprint'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });
  // With Redis the counters are shared, so limits hold across every API node instead of per process.
  // If Redis is briefly unreachable requests are let through (skipOnError) rather than failing the site.
  const limiterRedis = ctx.cfg.REDIS_URL ? new Redis(ctx.cfg.REDIS_URL, { connectTimeout: 1_000, maxRetriesPerRequest: 1, enableOfflineQueue: false }) : undefined;
  limiterRedis?.on('error', () => {});
  if (limiterRedis) app.addHook('onClose', async () => void limiterRedis.disconnect());
  await app.register(rateLimit, {
    max: ctx.cfg.RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
    ...(limiterRedis ? { redis: limiterRedis, nameSpace: 'bz-rl:', skipOnError: true } : {}),
  });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  // Session auth (optional on every route; handlers call me()/requireRole()).
  app.addHook('onRequest', async (req) => {
    req.staffMfaRequired = staffMfaRequired;
    const header = req.headers.authorization;
    // /metrics uses its own scrape token, and mk_ keys are merchant API keys.
    if (header?.startsWith('Bearer ') && !header.startsWith('Bearer mk_') && req.url !== '/metrics') {
      req.user = await userFromToken(ctx, header.slice(7));
    }
  });

  // Request ids are echoed so users/support can quote them and logs can be correlated.
  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Request-Id', req.id);
  });

  const metrics = createMetrics(ctx);
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url ?? 'unmatched';
    metrics.httpDuration.observe({ method: req.method, route, status: String(reply.statusCode) }, reply.elapsedTime / 1000);
    if (reply.statusCode >= 500) metrics.httpErrors.inc({ route });
  });

  app.get('/metrics', async (req, reply) => {
    const token = ctx.cfg.METRICS_TOKEN;
    if (!token && ctx.cfg.NODE_ENV === 'production') return reply.status(404).send();
    if (token && !safeEqual(req.headers.authorization ?? '', `Bearer ${token}`)) return reply.status(401).send();
    reply.header('Content-Type', metrics.registry.contentType);
    return metrics.registry.metrics();
  });

  app.get('/readyz', async (_req, reply) => {
    const checks: Record<string, boolean> = {};
    checks.database = await ctx.db.query('SELECT 1').then(() => true, () => false);
    checks.pubsub = await ctx.pubsub.ping().catch(() => false);
    const ok = Object.values(checks).every(Boolean);
    return reply.status(ok ? 200 : 503).send({ ok, checks });
  });

  app.setErrorHandler((err: any, req, reply: FastifyReply) => {
    if (err instanceof AppError) return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'validation_error', message: 'Invalid request', details: err.issues } });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: { code: err.code ?? 'bad_request', message: err.message } });
    req.log.error({ err }, 'unhandled error');
    captureException(err, { requestId: req.id, route: req.routeOptions?.url });
    return reply.status(500).send({ error: { code: 'internal', message: 'Internal server error', requestId: req.id } });
  });

  app.get('/healthz', async () => {
    await ctx.db.query('SELECT 1');
    return { ok: true };
  });

  // Seller API docs: JSON at /v1/openapi.json, browsable at /v1/docs.
  const openapi = buildOpenApi({ serverUrl: ctx.apiBaseUrl, sandbox: ctx.cfg.SANDBOX_MODE });
  await app.register(swagger, { mode: 'static', specification: { document: openapi as any } });
  await app.register(swaggerUi, { routePrefix: '/v1/docs', uiConfig: { docExpansion: 'list', defaultModelsExpandDepth: 0 } });
  app.get('/v1/openapi.json', async () => openapi);

  await app.register(async (v1) => {
    await publicRoutes(v1, ctx);
    await orderRoutes(v1, ctx);
    await sellerRoutes(v1, ctx);
    await merchantRoutes(v1, ctx);
    await integrationRoutes(v1, ctx);
    await adminRoutes(v1, ctx);
    if (ctx.cfg.SANDBOX_MODE) await sandboxRoutes(v1, ctx);
    registerGateway(v1, ctx);
  }, { prefix: '/v1' });

  return app;
}
