import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { many, one } from '../db.js';
import { SELLER_TIERS } from '../domain/commission.js';
import { getOffer } from '../domain/offers.js';
import { SORTS, gameDirectory, searchOffers, suggestGames, withDisplayPrices } from '../domain/search.js';
import { currentRates, getRate } from '../domain/fx.js';
import { availableCredit, referralSummary } from '../domain/referrals.js';
import { userCredit } from '../domain/ledger.js';
import { beginSetup, disable, enable, remainingRecoveryCodes } from '../domain/mfa.js';
import { changePassword, requestPasswordReset, resetPassword, completeMfaLogin, confirmVerificationCode, login, register, sendVerificationCode, startKyc } from '../domain/users.js';
import { REFRESH_TTL_DAYS, issueAccessToken, listSessions, refreshSession, revokeByRefreshToken, revokeFamily, revokeOtherSessions, revokeSessionById } from '../domain/sessions.js';
import { enqueueEmail, getPreferences, setPreferences } from '../domain/notifications.js';
import { AppError, badRequest, notFound, unauthorized } from '../lib/errors.js';
import { ATTR_KEY, ATTR_VALUE_MAX, CATEGORY_DEFAULTS, GAME_SETS, attributesFor } from '../domain/attributeSets.js';
import { deleteAccount, exportData } from '../domain/privacy.js';
import { isStaff as isStaffUser, permissionsOf } from '../domain/permissions.js';
import {
  getPushPreferences, listInbox, listPushSubscriptions, markAllRead, markRead, removePushSubscription, setPushPreferences, subscribePush, unreadCount, unsubscribePush,
} from '../domain/inbox.js';
import { recordView } from '../domain/analytics.js';
import { LOCALES } from '../domain/locales/index.js';
import { TICKET_CATEGORIES, createTicket, customerReply, customerResolve, getTicket, listMyTickets } from '../domain/support.js';
import { createWatch, deleteWatch, listWatches, updateWatch } from '../domain/watches.js';
import { confirmSubscription, getIncident, statusSummary, subscribe, unsubscribe } from '../domain/status.js';
import { me, requestMeta } from '../server.js';

const Credentials = z.object({ email: z.string().email().max(254), password: z.string().min(10).max(200), captchaToken: z.string().max(4096).optional() });

export async function publicRoutes(app: FastifyInstance, ctx: Ctx) {
  const strict = { config: { rateLimit: { max: ctx.cfg.AUTH_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' } } };

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

  /** Throws unless the request carries a valid CAPTCHA token (no-op when CAPTCHA is off). */
  const requireCaptcha = async (req: FastifyRequest, token: string | undefined) => {
    if (!ctx.captcha.enabled) return;
    if (!(await ctx.captcha.verify(token, req.ip))) {
      throw new AppError(400, token ? 'captcha_failed' : 'captcha_required', token ? 'The bot check failed. Please try again.' : 'Please complete the bot check.');
    }
  };
  const recentIpFailures = async (ip: string) =>
    (await one<{ n: number }>(ctx.db, `SELECT count(*)::int AS n FROM login_failures WHERE ip = $1 AND created_at > now() - interval '15 minutes'`, [ip])).n;

  // Tells clients which bot-check widget to render.
  app.get('/auth/config', async () => ({
    captcha: ctx.captcha.enabled ? { provider: ctx.cfg.CAPTCHA_PROVIDER, siteKey: ctx.cfg.CAPTCHA_SITE_KEY ?? null } : null,
  }));

  app.post('/auth/register', strict, async (req, reply) => {
    const body = Credentials.extend({ displayName: z.string().trim().min(2).max(40), referralCode: z.string().trim().max(20).optional(), locale: z.enum(LOCALES).optional() }).parse(req.body);
    await requireCaptcha(req, body.captchaToken);
    const res = await register(ctx, { ...body, ...meta(req) });
    return reply.status(201).send(deliver(req, reply, res));
  });

  app.post('/auth/login', strict, async (req, reply) => {
    const body = Credentials.parse(req.body);
    // Per IP (not per account, which would reveal whether an email is registered).
    if (ctx.captcha.enabled && (await recentIpFailures(req.ip)) >= ctx.cfg.CAPTCHA_AFTER_FAILED_LOGINS) await requireCaptcha(req, body.captchaToken);
    let res: Awaited<ReturnType<typeof login>>;
    try {
      res = await login(ctx, { ...body, ...meta(req) });
    } catch (err) {
      if (err instanceof AppError && (err.status === 401 || err.status === 429)) await ctx.db.query('INSERT INTO login_failures (ip) VALUES ($1)', [req.ip]);
      throw err;
    }
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
    const { email, captchaToken } = z.object({ email: z.string().email().max(254), captchaToken: z.string().max(4096).optional() }).parse(req.body);
    await requireCaptcha(req, captchaToken);
    await requestPasswordReset(ctx, email, requestMeta(req).ip);
    return reply.status(202).send({ message: 'If an account uses this email, a reset link is on its way.' });
  });

  app.post('/auth/password/reset', strict, async (req) => {
    const body = z.object({ token: z.string().min(20).max(200), newPassword: z.string().min(10).max(200) }).parse(req.body);
    return resetPassword(ctx, body.token, body.newPassword);
  });

  app.get('/me', async (req) => ({ user: me(req) }));
  // Emails, notifications and SMS go out in this language; the web app sets it when the user switches.
  app.put('/me/locale', async (req) => {
    const { locale } = z.object({ locale: z.enum(LOCALES) }).parse(req.body);
    await ctx.db.query('UPDATE users SET locale = $2 WHERE id = $1', [me(req).id, locale]);
    return { locale };
  });
  app.get('/me/permissions', async (req) => ({ permissions: [...permissionsOf(me(req))].sort() }));

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

  // --- Notification centre & push ---------------------------------------------------------
  const isStaff = (u: { role: string; staff_roles?: string[] | null }) => isStaffUser(u);
  app.get('/me/notifications', async (req) => {
    const q = z.object({ unread: z.enum(['true', 'false']).optional(), before: z.string().datetime().optional(), limit: z.coerce.number().int().positive().max(100).optional() }).parse(req.query);
    return listInbox(ctx, me(req).id, { unreadOnly: q.unread === 'true', before: q.before, limit: q.limit });
  });
  app.get('/me/notifications/unread-count', async (req) => ({ unread: await unreadCount(ctx, me(req).id) }));
  app.post('/me/notifications/:id/read', async (req) => markRead(ctx, me(req).id, z.object({ id: z.string().uuid() }).parse(req.params).id));
  app.post('/me/notifications/read-all', async (req) => markAllRead(ctx, me(req).id));

  app.get('/push/config', async () => ({ enabled: ctx.push.enabled, vapidPublicKey: ctx.push.publicKey }));
  app.get('/me/push-subscriptions', async (req) => listPushSubscriptions(ctx, me(req).id));
  app.post('/me/push-subscriptions', async (req, reply) => {
    // The browser's PushSubscription.toJSON(): { endpoint, keys: { p256dh, auth } }
    const body = z
      .object({ endpoint: z.string().url().max(1_000), keys: z.object({ p256dh: z.string().min(20).max(200), auth: z.string().min(8).max(100) }) })
      .parse(req.body);
    const ua = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined;
    return reply.status(201).send(await subscribePush(ctx, me(req).id, { endpoint: body.endpoint, ...body.keys }, ua));
  });
  app.delete('/me/push-subscriptions/:id', async (req, reply) => {
    await removePushSubscription(ctx, me(req).id, z.object({ id: z.string().uuid() }).parse(req.params).id);
    return reply.status(204).send();
  });
  app.post('/me/push-subscriptions/unsubscribe', async (req, reply) => {
    const { endpoint } = z.object({ endpoint: z.string().max(1_000) }).parse(req.body);
    await unsubscribePush(ctx, me(req).id, endpoint);
    return reply.status(204).send();
  });
  app.get('/me/push-preferences', async (req) => {
    const u = me(req);
    return getPushPreferences(ctx, u.id, isStaff(u));
  });
  app.patch('/me/push-preferences', async (req) => {
    const u = me(req);
    return setPushPreferences(ctx, u.id, isStaff(u), z.record(z.string(), z.boolean()).parse(req.body));
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
  app.get('/categories', async () => many(ctx.dbRead, 'SELECT * FROM categories ORDER BY name'));

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
    // Game-specific fields come as attr.<key>=<value>, e.g. attr.server=EUW&attr.rank=Gold.
    const attributes: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.query as Record<string, unknown>)) {
      if (!k.startsWith('attr.')) continue;
      const key = k.slice(5);
      if (!ATTR_KEY.test(key) || typeof v !== 'string' || !v.trim() || v.length > ATTR_VALUE_MAX) throw badRequest('invalid_attribute_filter', `Bad filter ${k}`);
      attributes[key] = v.trim();
    }
    if (Object.keys(attributes).length > 6) throw badRequest('invalid_attribute_filter', 'At most 6 field filters');
    // Price filters are given in the display currency and compared in the settlement currency.
    const display = q.currency ?? ctx.cfg.SETTLEMENT_CURRENCY;
    const rate = await getRate(ctx, ctx.db, display);
    const toSettlement = (v?: number) => (v == null ? undefined : Math.round(v / rate));
    const res = await searchOffers(ctx.dbRead, {
      ...q,
      minPriceCents: toSettlement(q.minPrice),
      maxPriceCents: toSettlement(q.maxPrice),
      sellerId: q.seller,
      attributes,
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

  // --- Help centre support tickets --------------------------------------------------------------
  const Body = z.string().trim().min(2).max(5_000);
  app.get('/support/tickets', async (req) => listMyTickets(ctx.db, me(req).id));
  app.post('/support/tickets', async (req, reply) => {
    const body = z
      .object({ category: z.enum(TICKET_CATEGORIES), subject: z.string().trim().min(3).max(140), body: Body, orderId: z.string().uuid().optional() })
      .parse(req.body);
    const id = await createTicket(ctx, me(req).id, body);
    return reply.status(201).send(await getTicket(ctx.db, id, { id: me(req).id, staff: false }));
  });
  app.get('/support/tickets/:id', async (req) => getTicket(ctx.db, z.object({ id: z.string().uuid() }).parse(req.params).id, { id: me(req).id, staff: false }));
  app.post('/support/tickets/:id/messages', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await customerReply(ctx, me(req).id, id, z.object({ body: Body }).parse(req.body).body);
    return getTicket(ctx.db, id, { id: me(req).id, staff: false });
  });
  app.post('/support/tickets/:id/resolve', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await customerResolve(ctx, me(req).id, id);
    return getTicket(ctx.db, id, { id: me(req).id, staff: false });
  });

  // --- Watchlist & price alerts -------------------------------------------------------------
  const WatchTarget = z.number().int().positive().max(100_000_00).nullable();
  app.get('/me/watches', async (req) => listWatches(ctx, me(req).id));
  app.post('/me/watches', async (req, reply) => {
    const body = z
      .object({
        offerId: z.string().uuid().optional(),
        game: z.string().trim().min(1).max(80).optional(),
        category: z.string().max(40).optional(),
        attributes: z.record(z.string().max(30), z.string().max(60)).optional(),
        targetCents: WatchTarget.optional(),
        currency: z.string().length(3).optional(),
      })
      .refine((b) => !!b.offerId !== !!b.game, 'Give either offerId or game')
      .parse(req.body);
    return reply.status(201).send(await createWatch(ctx, me(req).id, body));
  });
  app.patch('/me/watches/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ targetCents: WatchTarget, currency: z.string().length(3).optional() }).parse(req.body);
    return updateWatch(ctx, me(req).id, id, body);
  });
  app.delete('/me/watches/:id', async (req, reply) => {
    await deleteWatch(ctx, me(req).id, z.object({ id: z.string().uuid() }).parse(req.params).id);
    return reply.status(204).send();
  });

  app.get('/fx/rates', async () => currentRates(ctx));

  // Game-specific listing fields: the sell form and game-page filters read these.
  app.get('/catalog/attributes', async (req, reply) => {
    const { game, category } = z.object({ game: z.string().trim().min(1).max(80).optional(), category: z.string().max(40).optional() }).parse(req.query);
    reply.header('Cache-Control', 'public, max-age=300');
    if (game && category) return { game, category, fields: attributesFor(game, category) };
    return { defaults: CATEGORY_DEFAULTS, games: GAME_SETS };
  });

  app.get('/catalog/games', async (_req, reply) => {
    reply.header('Cache-Control', 'public, max-age=60');
    return gameDirectory(ctx.dbRead);
  });

  // --- Public status page -----------------------------------------------------------------
  app.get('/status', async (_req, reply) => {
    reply.header('Cache-Control', 'public, max-age=15');
    return statusSummary(ctx);
  });
  app.get('/status/incidents/:id', async (req) => getIncident(ctx, z.object({ id: z.string().uuid() }).parse(req.params).id));
  app.post('/status/subscribe', strict, async (req, reply) => {
    const { email } = z.object({ email: z.string().max(254) }).parse(req.body);
    return reply.status(202).send(await subscribe(ctx, email));
  });
  app.post('/status/confirm', strict, async (req) => confirmSubscription(ctx, z.object({ token: z.string().min(10).max(100) }).parse(req.body).token));
  app.post('/status/unsubscribe', strict, async (req) => unsubscribe(ctx, z.object({ token: z.string().min(10).max(120) }).parse(req.body).token));

  app.get('/games', async (req) => {
    const { q } = z.object({ q: z.string().trim().min(1).max(60) }).parse(req.query);
    return suggestGames(ctx.dbRead, q);
  });

  app.get('/offers/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const offer = await getOffer(ctx.dbRead, id);
    // A listing agreed on a buyer request is only visible to that buyer, its seller and staff.
    const staffViewer = !!req.user && isStaffUser(req.user as any);
    if (offer.reserved_for && ![offer.reserved_for, offer.seller_id].includes(req.user?.id) && !staffViewer) throw notFound('Offer');
    // Listings waiting for moderation are only for their seller and staff, and only they see why.
    const insider = offer.seller_id === req.user?.id || staffViewer;
    if (offer.status === 'review' && !insider) throw notFound('Offer');
    if (!insider) {
      delete offer.review_reasons;
      delete offer.review_note;
    }
    void recordView(ctx, offer.id, offer.seller_id, { userId: req.user?.id, ip: req.ip });
    return offer;
  });
}
