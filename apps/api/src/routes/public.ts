import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { many } from '../db.js';
import { SELLER_TIERS } from '../domain/commission.js';
import { getOffer, listOffers } from '../domain/offers.js';
import { beginSetup, disable, enable, remainingRecoveryCodes } from '../domain/mfa.js';
import { completeMfaLogin, confirmVerificationCode, issueToken, login, register, sendVerificationCode, startKyc } from '../domain/users.js';
import { me, requestMeta } from '../server.js';

const Credentials = z.object({ email: z.string().email().max(254), password: z.string().min(10).max(200) });

export async function publicRoutes(app: FastifyInstance, ctx: Ctx) {
  const strict = { config: { rateLimit: { max: ctx.cfg.NODE_ENV === 'test' ? 10_000 : 10, timeWindow: '1 minute' } } };

  // --- Auth -----------------------------------------------------------------
  app.post('/auth/register', strict, async (req, reply) => {
    const body = Credentials.extend({ displayName: z.string().trim().min(2).max(40) }).parse(req.body);
    const m = requestMeta(req);
    const res = await register(ctx, { ...body, ip: m.ip, device: m.device });
    return reply.status(201).send(res);
  });

  app.post('/auth/login', strict, async (req) => {
    const body = Credentials.parse(req.body);
    const m = requestMeta(req);
    return login(ctx, { ...body, ip: m.ip, device: m.device });
  });

  app.post('/auth/mfa', strict, async (req) => {
    const body = z.object({ mfaToken: z.string(), code: z.string().trim().min(6).max(20) }).parse(req.body);
    return completeMfaLogin(ctx, body.mfaToken, body.code);
  });

  app.get('/me', async (req) => ({ user: me(req) }));

  // --- Two-factor login -------------------------------------------------------------
  app.post('/me/2fa/setup', strict, async (req) => beginSetup(ctx, me(req)));
  app.post('/me/2fa/enable', strict, async (req) => {
    const { code } = z.object({ code: z.string().trim() }).parse(req.body);
    const user = me(req);
    const res = await enable(ctx, user.id, code);
    // Upgrade the current session so the user doesn't have to sign in again.
    return { ...res, token: await issueToken(ctx, user.id, { mfa: true }) };
  });
  app.post('/me/2fa/disable', strict, async (req) => {
    const { code } = z.object({ code: z.string().trim() }).parse(req.body);
    const user = me(req);
    await disable(ctx, user.id, code);
    return { token: await issueToken(ctx, user.id) };
  });
  app.get('/me/2fa', async (req) => {
    const user = me(req);
    return { enabled: user.totp_enabled, sessionVerified: !!user.session_mfa, recoveryCodesLeft: await remainingRecoveryCodes(ctx, user.id) };
  });

  // --- Tier 1 verification ------------------------------------------------------
  app.post('/verify/:channel/send', strict, async (req) => {
    const { channel } = z.object({ channel: z.enum(['email', 'sms']) }).parse(req.params);
    const { phone } = z.object({ phone: z.string().optional() }).parse(req.body ?? {});
    return sendVerificationCode(ctx, me(req), channel, phone);
  });

  app.post('/verify/:channel/confirm', strict, async (req) => {
    const { channel } = z.object({ channel: z.enum(['email', 'sms']) }).parse(req.params);
    const { code } = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);
    return { user: await confirmVerificationCode(ctx, me(req), channel, code) };
  });

  // --- Tier 2 eKYC --------------------------------------------------------------
  app.post('/kyc/start', async (req) => {
    const { level } = z.object({ level: z.enum(['tier2_individual', 'tier2_business']).default('tier2_individual') }).parse(req.body ?? {});
    return startKyc(ctx, me(req), level);
  });

  // --- Catalog ------------------------------------------------------------------
  app.get('/categories', async () => many(ctx.db, 'SELECT * FROM categories ORDER BY name'));

  app.get('/tiers', async () =>
    SELLER_TIERS.map((t) => ({ ...t, accountRate: t.accountRateBps / 100, otherRate: t.otherRateBps / 100 })),
  );

  app.get('/offers', async (req) => {
    const q = z
      .object({
        category: z.string().optional(),
        game: z.string().optional(),
        q: z.string().max(100).optional(),
        seller: z.string().uuid().optional(),
        limit: z.coerce.number().int().positive().max(100).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .parse(req.query);
    return listOffers(ctx.db, { ...q, sellerId: q.seller });
  });

  app.get('/offers/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return getOffer(ctx.db, id);
  });
}
