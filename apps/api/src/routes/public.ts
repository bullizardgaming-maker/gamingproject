import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { many } from '../db.js';
import { SELLER_TIERS } from '../domain/commission.js';
import { getOffer } from '../domain/offers.js';
import { SORTS, searchOffers, suggestGames, withDisplayPrices } from '../domain/search.js';
import { currentRates, getRate } from '../domain/fx.js';
import { availableCredit, referralSummary } from '../domain/referrals.js';
import { userCredit } from '../domain/ledger.js';
import { beginSetup, disable, enable, remainingRecoveryCodes } from '../domain/mfa.js';
import { changePassword, requestPasswordReset, resetPassword, completeMfaLogin, confirmVerificationCode, login, register, sendVerificationCode, startKyc } from '../domain/users.js';
import { REFRESH_TTL_DAYS, issueAccessToken, listSessions, refreshSession, revokeByRefreshToken, revokeFamily, revokeOtherSessions, revokeSessionById } from '../domain/sessions.js';
import { enqueueEmail, getPreferences, setPreferences } from '../domain/notifications.js';
import { AppError, unauthorized } from '../lib/errors.js';
import { deleteAccount, exportData } from '../domain/privacy.js';
import { me, requestMeta } from '../server.js';

const Credentials = z.object({ email: z.string().email().max(254), password: z.string().min(10).max(200) });

export async function publicRoutes(app: FastifyInstance, ctx: Ctx) {
  const strict = { config: { rateLimit: { max: ctx.cfg.NODE_ENV === 'test' ? 10_000 : 10, timeWindow: '1 minute' } } };

  // --- Auth -----------------------------------------------------------------
  // Browsers get the refresh token as an httpOnly, SameSite=Strict cookie scoped to /v1/auth,
  // so page scripts can never read it. Native/mobile clients send `X-Token-Delivery: body`.
  const COOKIE = 'bz_rt';
  const secure = ctx.cfg.NODE_ENV === 'production';
  const deliver = (req: FastifyRequest, reply: FastifyReply, res: { refreshToken: string } & Record<string, unknown>) => {
    reply.setCookie(COOKIE, res.refreshToken, {
      httpOnly: true, secure, sameSite: 'strict', path: '/v1/auth', maxAge: REFRESH_TTL_DAYS * 86_400,
    });
    if (req.headers['x-token-delivery'] === 'body') return res;
    const { refreshToken: _omit, ...rest } = res;
    return rest;
  };
  const meta = (req: FastifyRequest) => {
    const m = requestMeta(req);
    return { ip: m.ip, device: m.device, userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined };
  };

  app.post('/auth/register', strict, async (req, reply) => {
    const body = Credentials.extend({ displayName: z.string().trim().min(2).max(40), referralCode: z.string().trim().max(20).optional() }).parse(req.body);
    const res = await register(ctx, { ...body, ...meta(req) });
    return reply.status(201).send(deliver(req, reply, res));
  });

  app.post('/auth/login', strict, async (req, reply) => {
    const body = Credentials.parse(req.body);
    const res = await login(ctx, { ...body, ...meta(req) });
    return 'refreshToken' in res ? deliver(req, reply, res) : res;
  });

  app.post('/auth/mfa', strict, async (req, reply) => {
    const body = z.object({ mfaToken: z.string(), code: z.string().trim().min(6).max(20) }).parse(req.body);
    return deliver(req, reply, await completeMfaLogin(ctx, body.mfaToken, body.code, meta(req)));
  });

  app.post('/auth/refresh', { config: { rateLimit: { max: ctx.cfg.NODE_ENV === 'test' ? 10_000 : 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { refreshToken } = z.object({ refreshToken: z.string().optional() }).parse(req.body ?? {});
    const token = refreshToken ?? req.cookies[COOKIE];
    if (!token) throw unauthorized('Sign in again');
    try {
      const s = await refreshSession(ctx, token, meta(req));
      return deliver(req, reply, { token: s.accessToken, refreshToken: s.refreshToken, expiresIn: s.expiresIn });
    } catch (err) {
      if (err instanceof AppError && err.status === 401) reply.clearCookie(COOKIE, { path: '/v1/auth' });
      throw err;
    }
  });

  app.post('/auth/logout', async (req, reply) => {
    const token = (req.body as any)?.refreshToken ?? req.cookies[COOKIE];
    if (token) await revokeByRefreshToken(ctx, token);
    else if (req.user?.session_family) await revokeFamily(ctx, req.user.id, req.user.session_family, 'signed_out');
    reply.clearCookie(COOKIE, { path: '/v1/auth' });
    return reply.status(204).send();
  });

  app.post('/auth/password/forgot', strict, async (req, reply) => {
    const { email } = z.object({ email: z.string().email().max(254) }).parse(req.body);
    await requestPasswordReset(ctx, email, requestMeta(req).ip);
    return reply.status(202).send({ message: 'If an account uses this email, a reset link is on its way.' });
  });

  app.post('/auth/password/reset', strict, async (req) => {
    const body = z.object({ token: z.string().min(20).max(200), newPassword: z.string().min(10).max(200) }).parse(req.body);
    return resetPassword(ctx, body.token, body.newPassword);
  });

  app.get('/me', async (req) => ({ user: me(req) }));

  app.post('/me/password', strict, async (req) => {
    const body = z.object({ currentPassword: z.string(), newPassword: z.string().min(10).max(200) }).parse(req.body);
    return changePassword(ctx, me(req), body.currentPassword, body.newPassword);
  });

  // --- Privacy (GDPR) ------------------------------------------------------------------
  app.get('/me/export', { config: { rateLimit: { max: ctx.cfg.NODE_ENV === 'test' ? 1_000 : 5, timeWindow: '1 hour' } } }, async (req, reply) => {
    reply.header('Content-Disposition', 'attachment; filename="bullizard-data.json"').header('Cache-Control', 'no-store');
    return exportData(ctx, me(req).id);
  });
  app.post('/me/delete', strict, async (req, reply) => {
    const body = z.object({ password: z.string(), code: z.string().trim().optional() }).parse(req.body);
    const res = await deleteAccount(ctx, me(req), body.password, body.code);
    reply.clearCookie(COOKIE, { path: '/v1/auth' });
    return res;
  });

  // --- Signed-in devices ---------------------------------------------------------------
  app.get('/me/sessions', async (req) => {
    const user = me(req);
    return listSessions(ctx, user.id, user.session_family);
  });
  app.delete('/me/sessions/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await revokeSessionById(ctx, me(req).id, id);
    return reply.status(204).send();
  });
  app.post('/me/sessions/revoke-others', async (req) => {
    const user = me(req);
    return { signedOutDevices: await revokeOtherSessions(ctx.db, user.id, user.session_family ?? null, 'revoked_by_user') };
  });

  // --- Email preferences ---------------------------------------------------------------
  app.get('/me/email-preferences', async (req) => getPreferences(ctx.db, me(req).id));
  app.patch('/me/email-preferences', async (req) => {
    const changes = z.record(z.string(), z.boolean()).parse(req.body);
    return setPreferences(ctx.db, me(req).id, changes);
  });

  // --- Two-factor login -------------------------------------------------------------
  // Turning 2FA on or off signs out every other device and sends a security email.
  app.post('/me/2fa/setup', strict, async (req) => beginSetup(ctx, me(req)));
  app.post('/me/2fa/enable', strict, async (req) => {
    const { code } = z.object({ code: z.string().trim() }).parse(req.body);
    const user = me(req);
    const res = await enable(ctx, user.id, code);
    // The current device proved the second factor, so its session becomes a two-factor session.
    await ctx.db.query('UPDATE sessions SET mfa = true WHERE family_id = $1', [user.session_family]);
    await revokeOtherSessions(ctx.db, user.id, user.session_family ?? null, 'mfa_enabled');
    await enqueueEmail(ctx.db, user.id, 'mfa_changed', { enabled: true });
    return { ...res, token: await issueAccessToken(ctx, user.id, user.session_id!) };
  });
  app.post('/me/2fa/disable', strict, async (req) => {
    const { code } = z.object({ code: z.string().trim() }).parse(req.body);
    const user = me(req);
    await disable(ctx, user.id, code);
    await ctx.db.query('UPDATE sessions SET mfa = false WHERE family_id = $1', [user.session_family]);
    await revokeOtherSessions(ctx.db, user.id, user.session_family ?? null, 'mfa_disabled');
    await enqueueEmail(ctx.db, user.id, 'mfa_changed', { enabled: false });
    return { token: await issueAccessToken(ctx, user.id, user.session_id!) };
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
    const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
    const q = z
      .object({
        q: z.string().max(100).optional(),
        category: z.string().max(40).optional(),
        game: z.string().max(80).optional(),
        minPrice: z.coerce.number().int().min(0).optional(),
        maxPrice: z.coerce.number().int().min(0).optional(),
        delivery: z.enum(['instant', 'manual']).optional(),
        ownerVerified: bool.optional(),
        minRating: z.coerce.number().min(1).max(5).optional(),
        inStock: bool.optional(),
        seller: z.string().uuid().optional(),
        sort: z.enum(SORTS).optional(),
        currency: z.string().length(3).toUpperCase().optional().describe('Show prices converted to this currency; price filters are in it too'),
        page: z.coerce.number().int().min(1).max(500).optional(),
        pageSize: z.coerce.number().int().min(1).max(60).optional(),
      })
      .parse(req.query);
    // Price filters are given in the display currency and compared in the settlement currency.
    const display = q.currency ?? ctx.cfg.SETTLEMENT_CURRENCY;
    const rate = await getRate(ctx, ctx.db, display);
    const toSettlement = (v?: number) => (v == null ? undefined : Math.round(v / rate));
    const res = await searchOffers(ctx.db, {
      ...q,
      minPriceCents: toSettlement(q.minPrice),
      maxPriceCents: toSettlement(q.maxPrice),
      sellerId: q.seller,
    });
    return withDisplayPrices(ctx, res, display);
  });

  app.get('/me/credit', async (req) => {
    const user = me(req);
    const cur = ctx.cfg.SETTLEMENT_CURRENCY;
    return {
      currency: cur,
      balanceCents: await userCredit(ctx.db, user.id, cur),
      availableCents: await availableCredit(ctx.db, user.id, cur),
      history: await many(
        ctx.db,
        `SELECT e.amount_cents, e.memo, e.order_id, e.created_at FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
          WHERE a.owner_id = $1 AND a.kind = 'user_credit' ORDER BY e.id DESC LIMIT 100`,
        [user.id],
      ),
    };
  });

  app.get('/me/referral', async (req) => referralSummary(ctx, me(req).id));

  app.get('/fx/rates', async () => currentRates(ctx));

  app.get('/games', async (req) => {
    const { q } = z.object({ q: z.string().trim().min(1).max(60) }).parse(req.query);
    return suggestGames(ctx.db, q);
  });

  app.get('/offers/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return getOffer(ctx.db, id);
  });
}
