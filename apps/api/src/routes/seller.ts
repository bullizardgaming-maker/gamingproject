import type { FastifyInstance } from 'fastify';
import { verifyMessage } from 'ethers';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { many, maybeOne, one } from '../db.js';
import { createApiKey, listApiKeys, revokeApiKey } from '../domain/apikeys.js';
import { SELLER_TIERS, sellerTier } from '../domain/commission.js';
import { recordSignals } from '../domain/fraud.js';
import { sellerAvailable } from '../domain/ledger.js';
import { createOffer, requireSeller, submitOwnerProof, updateOffer, uploadInventory } from '../domain/offers.js';
import { requestWithdrawal } from '../domain/users.js';
import { payoutStatus, startPayoutOnboarding } from '../domain/payouts.js';
import { withdrawable } from '../domain/payoutholds.js';
import { ExportQuery } from '../api-schemas.js';
import { EXPORT_KINDS, buildExport, exportRange, toCsv, type ExportKind } from '../domain/exports.js';
import { screenUser } from '../domain/aml.js';
import { payoutCurrency, sellerBalances, setPayoutCurrency } from '../domain/sellerfx.js';
import { getTaxProfile, setTaxProfile } from '../domain/tax.js';
import { getInvoice, invoicePdf, listInvoices } from '../domain/invoices.js';
import { listCreditNotes } from '../domain/clawback.js';
import { sellerAnalytics } from '../domain/analytics.js';
import { sellerDebts, shopHeldForDebt, startDebtPayment } from '../domain/debts.js';
import { DELIVERY_FILTERS, WEBHOOK_EVENTS, createEndpoint, listDeliveries, redeliver, replayDead, rotateSecret, setEndpointActive } from '../domain/webhooks.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { me } from '../server.js';

const Id = z.object({ id: z.string().uuid() });

export const OfferBody = z.object({
  categorySlug: z.string(),
  game: z.string().trim().min(1).max(80),
  title: z.string().trim().min(3).max(140),
  description: z.string().max(5_000).optional(),
  priceCents: z.number().int().positive().max(100_000_00),
  currency: z.string().length(3).toUpperCase().optional().describe('Listing currency (e.g. USD, EUR, GBP)'),
  deliveryMode: z.enum(['auto', 'manual']),
  stock: z.number().int().min(0).max(1_000_000).optional(),
  lowStockThreshold: z.number().int().min(0).max(100_000).optional(),
  deliveryHours: z.number().int().min(1).max(168).optional().describe('Promised delivery time for manual orders, in hours'),
  attributes: z.record(z.string().max(30), z.string().max(60)).optional().describe('Game-specific fields such as server, region, platform or rank (GET /v1/catalog/attributes)'),
});

export const InventoryBody = z.object({
  format: z.enum(['txt', 'json']),
  content: z.string().min(1).max(10 * 1024 * 1024),
});

export async function sellerRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/seller/dashboard', async (req) => {
    const user = me(req);
    const currency = await payoutCurrency(ctx, ctx.db, user.id);
    const hold = await withdrawable(ctx, ctx.db, user.id, currency);
    const [tier, available, stats, escrow] = await Promise.all([
      sellerTier(ctx.db, user.id),
      sellerAvailable(ctx.db, user.id, currency),
      one(
        ctx.db,
        `SELECT count(*) FILTER (WHERE status = 'completed')::int AS completed,
                count(*) FILTER (WHERE status IN ('paid', 'delivered'))::int AS in_progress,
                count(*) FILTER (WHERE status = 'disputed')::int AS disputed,
                count(*) FILTER (WHERE status = 'charged_back')::int AS charged_back
           FROM orders WHERE seller_id = $1`,
        [user.id],
      ),
      one(ctx.db, `SELECT COALESCE(SUM(seller_net_cents), 0)::bigint AS pending FROM orders WHERE seller_id = $1 AND status IN ('paid', 'delivered', 'disputed') AND rail = 'fiat'`, [user.id]),
    ]);
    return {
      tier: tier.tier,
      monthlySalesCents: tier.monthlySalesCents,
      next: tier.next,
      tiers: SELLER_TIERS,
      payoutCurrency: currency,
      balances: { currency, availableCents: available, pendingEscrowCents: escrow.pending, withdrawableCents: hold.withdrawableCents, onHoldCents: hold.heldCents },
      allBalances: await sellerBalances(ctx.db, user.id),
      debts: await sellerDebts(ctx, user.id),
      payoutHold: { level: hold.level, days: hold.holdDays, upcoming: hold.upcoming },
      withdrawalsFrozen: user.withdrawals_frozen,
      shop: await one(
        ctx.db,
        `SELECT (shop_paused AND (shop_paused_until IS NULL OR shop_paused_until > now())) AS paused,
                shop_paused_until AS until, shop_pause_message AS message FROM users WHERE id = $1`,
        [user.id],
      ),
      stats,
    };
  });

  app.get('/seller/analytics', async (req) => {
    const user = me(req);
    requireSeller(user);
    const { days } = z.object({ days: z.coerce.number().pipe(z.union([z.literal(7), z.literal(30), z.literal(90), z.literal(365)])).default(30) }).parse(req.query);
    return sellerAnalytics(ctx.dbRead, user.id, days);
  });

  // --- Offers & inventory ------------------------------------------------------------
  app.get('/seller/offers', async (req) =>
    many(
      ctx.db,
      `SELECT f.*, CASE WHEN f.delivery_mode = 'auto'
                    THEN (SELECT count(*)::int FROM inventory_items i WHERE i.offer_id = f.id AND i.status = 'available')
                    ELSE f.stock END AS available
         FROM offers f WHERE seller_id = $1 AND status <> 'removed' ORDER BY created_at DESC`,
      [me(req).id],
    ),
  );

  app.post('/offers', async (req, reply) => reply.status(201).send(await createOffer(ctx, me(req), OfferBody.parse(req.body))));

  app.patch('/offers/:id', async (req) => {
    const body = OfferBody.pick({ title: true, description: true, priceCents: true, stock: true, lowStockThreshold: true, deliveryHours: true, attributes: true })
      .partial()
      .extend({ version: z.number().int().min(0), status: z.enum(['active', 'paused', 'removed']).optional() })
      .parse(req.body);
    const { version, ...patch } = body;
    return updateOffer(ctx, me(req).id, Id.parse(req.params).id, version, patch);
  });

  app.post('/offers/:id/inventory', async (req) => {
    const user = me(req);
    requireSeller(user);
    const body = InventoryBody.parse(req.body);
    return uploadInventory(ctx, user.id, Id.parse(req.params).id, body.format, body.content);
  });

  app.post('/offers/:id/owner-proof', async (req, reply) => {
    const user = me(req);
    requireSeller(user);
    const body = z
      .object({
        registrationEmail: z.string().email(),
        registrationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        billingName: z.string().max(120).optional(),
        evidence: z.record(z.string(), z.unknown()).default({}),
      })
      .parse(req.body);
    return reply.status(201).send(await submitOwnerProof(ctx, user.id, Id.parse(req.params).id, body));
  });

  // --- Payouts ------------------------------------------------------------------
  app.post('/seller/withdrawals', async (req, reply) => {
    const user = me(req);
    const body = z.object({ amountCents: z.number().int().positive(), currency: z.string().length(3).toUpperCase().optional() }).parse(req.body);
    const currency = body.currency ?? (await payoutCurrency(ctx, ctx.db, user.id));
    return reply.status(201).send(await requestWithdrawal(ctx, user.id, body.amountCents, currency));
  });

  /** Currency new sales are credited and paid out in (the buyer's conversion is the only one). */
  app.put('/seller/payout-currency', async (req) => {
    const { currency } = z.object({ currency: z.string().length(3) }).parse(req.body);
    return setPayoutCurrency(ctx, me(req).id, currency);
  });

  /** Holiday mode: listings disappear from the market and can't be bought until resumed (or `until` passes). */
  app.put('/seller/shop-status', async (req) => {
    const user = me(req);
    const body = z
      .object({ paused: z.boolean(), until: z.string().datetime().optional(), message: z.string().trim().max(200).optional() })
      .parse(req.body);
    if (body.until && new Date(body.until) <= new Date()) throw badRequest('invalid_until', 'Pick a time in the future');
    if (!body.paused && (await shopHeldForDebt(ctx.db, user.id))) {
      throw new AppError(409, 'debt_outstanding', 'Your shop reopens as soon as your balance is settled');
    }
    const row = await one(
      ctx.db,
      `UPDATE users SET shop_paused = $2, shop_paused_until = $3, shop_pause_message = $4 WHERE id = $1
       RETURNING shop_paused AS paused, shop_paused_until AS until, shop_pause_message AS message`,
      [user.id, body.paused, body.paused ? body.until ?? null : null, body.paused ? body.message ?? null : null],
    );
    const open = await one<{ n: number }>(ctx.db, `SELECT count(*)::int AS n FROM orders WHERE seller_id = $1 AND status = 'paid'`, [user.id]);
    return { ...row, ordersStillToDeliver: open.n };
  });

  app.post('/seller/payout-account', async (req) => startPayoutOnboarding(ctx, me(req)));
  app.get('/seller/payout-account', async (req) => payoutStatus(ctx, me(req)));

  // --- Tax profile & commission invoices -------------------------------------------------
  app.get('/seller/tax-profile', async (req) => getTaxProfile(ctx, me(req).id));
  app.put('/seller/tax-profile', async (req) => {
    const body = z
      .object({
        country: z.string().length(2).regex(/^[A-Za-z]{2}$/),
        isBusiness: z.boolean(),
        taxId: z.string().trim().max(20).nullable().optional(),
        billingAddress: z.string().trim().max(300).nullable().optional(),
      })
      .parse(req.body);
    return setTaxProfile(ctx, me(req).id, body);
  });
  app.get('/seller/invoices', async (req) => listInvoices(ctx, me(req).id));
  app.get('/seller/credit-notes', async (req) => listCreditNotes(ctx, me(req).id));
  app.get('/seller/invoices/:id', async (req) => getInvoice(ctx, Id.parse(req.params).id, me(req).id));
  app.get('/seller/invoices/:id/pdf', async (req, reply) => {
    const inv = await getInvoice(ctx, Id.parse(req.params).id, me(req).id);
    reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `attachment; filename="${inv.number}.pdf"`);
    return reply.send(await invoicePdf(inv));
  });

  const sendExport = async (req: any, reply: any, sellerId: string, kind: ExportKind) => {
    const q = ExportQuery.parse(req.query);
    const range = exportRange(q.from, q.to);
    const currency = q.currency ?? (await payoutCurrency(ctx, ctx.db, sellerId));
    const out = await buildExport(ctx.dbRead, sellerId, kind, range, currency);
    if (q.format === 'json') return { kind, ...range, currency: kind === 'statement' ? currency : undefined, rows: out.rows };
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="bullizard-${kind}-${range.from}-to-${range.to}.csv"`);
    return toCsv(out.columns, out.rows);
  };
  app.get('/seller/exports/:kind', async (req, reply) => {
    const { kind } = z.object({ kind: z.enum(EXPORT_KINDS) }).parse(req.params);
    return sendExport(req, reply, me(req).id, kind);
  });

  app.get('/seller/payout-hold', async (req) => {
    const { currency } = z.object({ currency: z.string().length(3).toUpperCase().optional() }).parse(req.query);
    const id = me(req).id;
    return withdrawable(ctx, ctx.db, id, currency ?? (await payoutCurrency(ctx, ctx.db, id)));
  });
  app.get('/seller/debts', async (req) => sellerDebts(ctx, me(req).id));
  app.post('/seller/debts/:id/pay', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { amountCents } = z.object({ amountCents: z.number().int().positive().optional() }).parse(req.body ?? {});
    const user = me(req);
    return reply.status(201).send(await startDebtPayment(ctx, user, id, amountCents));
  });
  app.get('/seller/withdrawals', async (req) => many(ctx.db, 'SELECT * FROM withdrawals WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100', [me(req).id]));

  /** Link a self-custody wallet (for crypto escrow payouts), proven by a personal_sign signature. */
  app.post('/me/wallet', async (req) => {
    const user = me(req);
    const { address, signature } = z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/), signature: z.string() }).parse(req.body);
    const message = `Link wallet ${address.toLowerCase()} to Bullizard account ${user.id}`;
    let recovered: string;
    try {
      recovered = verifyMessage(message, signature);
    } catch {
      throw badRequest('invalid_signature', 'Signature could not be verified');
    }
    if (recovered.toLowerCase() !== address.toLowerCase()) throw badRequest('invalid_signature', `Sign exactly: "${message}"`);
    await ctx.db.query('UPDATE users SET wallet_address = $2 WHERE id = $1', [user.id, address.toLowerCase()]);
    await recordSignals(ctx.db, user.id, { wallet: address.toLowerCase() });
    await screenUser(ctx, user.id);
    return { wallet: address.toLowerCase() };
  });

  // --- Developer: API keys & webhooks --------------------------------------------------
  app.get('/developer/api-keys', async (req) => listApiKeys(ctx, me(req).id));
  app.post('/developer/api-keys', async (req, reply) => {
    const body = z.object({ name: z.string().trim().min(1).max(60), scopes: z.array(z.string()).min(1) }).parse(req.body);
    return reply.status(201).send(await createApiKey(ctx, me(req), body.name, body.scopes));
  });
  app.delete('/developer/api-keys/:id', async (req, reply) => {
    await revokeApiKey(ctx, me(req).id, Id.parse(req.params).id);
    return reply.status(204).send();
  });

  app.get('/developer/webhooks', async (req) =>
    many(ctx.db, 'SELECT id, url, events, active, created_at FROM webhook_endpoints WHERE user_id = $1 ORDER BY created_at DESC', [me(req).id]),
  );
  app.post('/developer/webhooks', async (req, reply) => {
    const user = me(req);
    requireSeller(user);
    const body = z.object({ url: z.string().url().max(2_000), events: z.array(z.enum(WEBHOOK_EVENTS)).min(1) }).parse(req.body);
    return reply.status(201).send(await createEndpoint(ctx, user.id, body.url, body.events));
  });
  app.delete('/developer/webhooks/:id', async (req, reply) => {
    await ctx.db.query('UPDATE webhook_endpoints SET active = false WHERE id = $1 AND user_id = $2', [Id.parse(req.params).id, me(req).id]);
    return reply.status(204).send();
  });
  app.get('/developer/webhooks/:id/deliveries', async (req) => {
    const { status } = z.object({ status: z.enum(DELIVERY_FILTERS).default('all') }).parse(req.query);
    return listDeliveries(ctx, me(req).id, { endpointId: Id.parse(req.params).id, status });
  });
  app.post('/developer/webhooks/deliveries/:id/redeliver', async (req) => redeliver(ctx, me(req).id, Id.parse(req.params).id));
  app.post('/developer/webhooks/:id/replay', async (req) => {
    const { since } = z.object({ since: z.string().datetime().optional() }).parse(req.body ?? {});
    return replayDead(ctx, me(req).id, Id.parse(req.params).id, since);
  });
  app.post('/developer/webhooks/:id/enable', async (req) => setEndpointActive(ctx, me(req).id, Id.parse(req.params).id, true));
  app.post('/developer/webhooks/:id/rotate-secret', async (req) => rotateSecret(ctx, me(req).id, Id.parse(req.params).id));
  app.post('/developer/webhooks/:id/test', async (req) => {
    const { id } = Id.parse(req.params);
    const user = me(req);
    const ep = await maybeOne(ctx.db, 'SELECT id FROM webhook_endpoints WHERE id = $1 AND user_id = $2', [id, user.id]);
    if (!ep) throw notFound('Webhook endpoint');
    const payload = { id: `evt_test_${Date.now()}`, type: 'order.created', created_at: new Date().toISOString(), data: { test: true } };
    await ctx.db.query('INSERT INTO webhook_deliveries (endpoint_id, event_type, payload) VALUES ($1, $2, $3)', [id, 'order.created', payload]);
    return { queued: true };
  });
}
