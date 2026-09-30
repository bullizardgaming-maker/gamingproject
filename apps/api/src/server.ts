import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { ZodError } from 'zod';
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

export function requestMeta(req: FastifyRequest): RequestMeta {
  const country = req.headers['cf-ipcountry'] ?? req.headers['x-geo-country'];
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

export async function buildApp(ctx: Ctx, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true, bodyLimit: 12 * 1024 * 1024 });

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
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) =>
    done(null, Object.fromEntries(new URLSearchParams(body as string))),
  );

  await app.register(cookie);
  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-site' } });
  await app.register(cors, {
    origin: [ctx.cfg.PUBLIC_WEB_URL],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Device-Fingerprint'],
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  });
  await app.register(rateLimit, { max: ctx.cfg.NODE_ENV === 'test' ? 100_000 : 300, timeWindow: '1 minute' });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  // Session auth (optional on every route; handlers call me()/requireRole()).
  app.addHook('onRequest', async (req) => {
    req.staffMfaRequired = staffMfaRequired;
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ') && !header.startsWith('Bearer mk_')) {
      req.user = await userFromToken(ctx, header.slice(7));
    }
  });

  app.setErrorHandler((err: any, req, reply: FastifyReply) => {
    if (err instanceof AppError) return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'validation_error', message: 'Invalid request', details: err.issues } });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: { code: err.code ?? 'bad_request', message: err.message } });
    req.log.error(err);
    ctx.log.error({ err: err.message, stack: err.stack }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'internal', message: 'Internal server error' } });
  });

  app.get('/healthz', async () => {
    await ctx.db.query('SELECT 1');
    return { ok: true };
  });

  await app.register(async (v1) => {
    await publicRoutes(v1, ctx);
    await orderRoutes(v1, ctx);
    await sellerRoutes(v1, ctx);
    await merchantRoutes(v1, ctx);
    await integrationRoutes(v1, ctx);
    await adminRoutes(v1, ctx);
    registerGateway(v1, ctx);
  }, { prefix: '/v1' });

  return app;
}
