import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { ZodError } from 'zod';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { Logger as PinoLogger } from 'pino';
import { safeEqual, sha256 } from './lib/crypto.js';
import { captureException, createMetrics } from './observability.js';
import type { Ctx } from './context.js';
import { AppError, forbidden, unauthorized } from './lib/errors.js';
import { userFromToken, type User } from './domain/users.js';
import { hasPermission, type Permission } from './domain/permissions.js';
import { publicRoutes } from './routes/public.js';
import { orderRoutes } from './routes/orders.js';
import { sellerRoutes } from './routes/seller.js';
import { requestRoutes } from './routes/requests.js';
import { integrationRoutes } from './routes/integrations.js';
import { adminRoutes } from './routes/admin.js';
import { registerGateway } from './ws/gateway.js';
import { touchPresence } from './domain/presence.js';
import { sandboxRoutes } from './routes/sandbox.js';
import { MAX_VIDEO_BYTES } from './domain/attachments.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
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

/** Staff routes: the signed-in user must hold `permission` through one of their roles, with a 2FA session. */
export function requirePermission(req: FastifyRequest, permission: Permission): User {
  const user = me(req);
  if (!hasPermission(user, permission)) throw forbidden('insufficient_permission', `Missing permission ${permission}`);
  if (req.staffMfaRequired && !user.session_mfa) {
    throw forbidden('mfa_required', 'Staff actions need two-factor login. Turn it on in Account, then sign in again.');
  }
  return user;
}

export function parseTrustProxy(v: string): boolean | number | string[] {
  if (v === 'false' || v === '') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

/** Health checks Render (and uptime monitors) call directly on the origin, without Cloudflare's header. */
const ORIGIN_AUTH_EXEMPT = new Set(['/readyz', '/healthz']);

/**
 * Round 23a, behind Cloudflare: with ORIGIN_SHARED_SECRET set, only requests carrying X-Origin-Auth = the secret
 * (added by a Cloudflare Transform Rule) are served, so nobody can reach the origin around Cloudflare's WAF and
 * rate limits; the client IP is then CF-Connecting-IP. `req.ip` is replaced on the request itself, so every use of
 * it (rate limits, fraud signals, referral ip_subnet, audit log, buyer_ip, sessions, captcha) sees the real client.
 * Without the secret nothing changes: the IP comes from TRUST_PROXY / X-Forwarded-For.
 */
export function originGuard(secret: string | undefined) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!secret) return;
    const path = req.url.split('?')[0]!;
    if (ORIGIN_AUTH_EXEMPT.has(path)) return;
    const given = req.headers['x-origin-auth'];
    // Compared as SHA-256 digests: constant time, and the secret's length doesn't leak either.
    if (typeof given !== 'string' || !safeEqual(sha256(given), sha256(secret))) {
      return reply.status(403).send({ error: { code: 'origin_forbidden', message: 'Direct access to the origin is not allowed' } });
    }
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && isIP(cf.trim())) Object.defineProperty(req, 'ip', { value: cf.trim(), configurable: true, enumerable: true });
  };
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

  // First hook of all: before rate limits, auth and every route (WebSocket upgrades included).
  app.addHook('onRequest', originGuard(ctx.cfg.ORIGIN_SHARED_SECRET));

  app.decorateRequest('user', null);
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
  // Delivery proof videos (sniffed too): handed to the route as the raw request stream, never buffered (Round 23b).
  // The upload code counts the bytes and stops at MAX_VIDEO_BYTES.
  app.addContentTypeParser(['video/mp4', 'video/webm'], (_req, payload, done) => done(null, payload));
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
  app.addHook('onClose', async () => ctx.dbRead.end());
  await app.register(rateLimit, {
    max: ctx.cfg.RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
    ...(limiterRedis ? { redis: limiterRedis, nameSpace: 'bz-rl:', skipOnError: true } : {}),
  });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  // Session auth (optional on every route; handlers call me()/requirePermission()).
  app.addHook('onRequest', async (req) => {
    req.staffMfaRequired = staffMfaRequired;
    const header = req.headers.authorization;
    // /metrics uses its own scrape token.
    if (header?.startsWith('Bearer ') && req.url !== '/metrics') {
      req.user = await userFromToken(ctx, header.slice(7));
      if (req.user) touchPresence(ctx, req.user.id);
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
    // Only the database decides readiness. Redis down degrades live updates and shared rate limits
    // but every node can still serve; failing readiness on it would take the whole fleet out.
    // Likewise a lagging or down replica: reads fall back to the primary.
    const ok = checks.database;
    const replica = ctx.cfg.DATABASE_READ_URL ? { inUse: ctx.dbRead.usingReplica, lagSeconds: ctx.dbRead.lagSeconds } : undefined;
    return reply.status(ok ? 200 : 503).send({ ok, checks, ...(replica ? { replica } : {}) });
  });

  app.setErrorHandler((err: any, req, reply: FastifyReply) => {
    if (err instanceof AppError) return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'validation_error', message: 'Invalid request', details: err.issues } });
    if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE' && String(req.headers['content-type'] ?? '').startsWith('video/')) {
      const maxMb = MAX_VIDEO_BYTES / 1_048_576;
      return reply.status(413).send({ error: { code: 'file_too_large', message: `Videos can be up to ${maxMb} MB`, details: { maxBytes: MAX_VIDEO_BYTES, maxMb, directUpload: !!ctx.storage.presignPut } } });
    }
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: { code: err.code ?? 'bad_request', message: err.message } });
    req.log.error({ err }, 'unhandled error');
    captureException(err, { requestId: req.id, route: req.routeOptions?.url });
    return reply.status(500).send({ error: { code: 'internal', message: 'Internal server error', requestId: req.id } });
  });

  app.get('/healthz', async () => {
    await ctx.db.query('SELECT 1');
    return { ok: true };
  });

  await app.register(async (v1) => {
    await publicRoutes(v1, ctx);
    await orderRoutes(v1, ctx);
    await sellerRoutes(v1, ctx);
    await requestRoutes(v1, ctx);
    await integrationRoutes(v1, ctx);
    await adminRoutes(v1, ctx);
    if (ctx.cfg.SANDBOX_MODE) await sandboxRoutes(v1, ctx);
    registerGateway(v1, ctx);
  }, { prefix: '/v1' });

  return app;
}
