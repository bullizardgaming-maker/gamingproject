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
import { WEBHOOK_EVENTS, createEndpoint } from '../domain/webhooks.js';
import { badRequest, notFound } from '../lib/errors.js';
import { me } from '../server.js';

const Id = z.object({ id: z.string().uuid() });

export const OfferBody = z.object({
  categorySlug: z.string(),
  game: z.string().trim().min(1).max(80),
  title: z.string().trim().min(3).max(140),
  description: z.string().max(5_000).optional(),
  priceCents: z.number().int().positive().max(100_000_00),
  currency: z.literal('USD').optional(),
  deliveryMode: z.enum(['auto', 'manual']),
  stock: z.number().int().min(0).max(1_000_000).optional(),
  lowStockThreshold: z.number().int().min(0).max(100_000).optional(),
  deliveryHours: z.number().int().min(1).max(168).optional().describe('Promised delivery time for manual orders, in hours'),
});

export const InventoryBody = z.object({
  format: z.enum(['txt', 'json']),
  content: z.string().min(1).max(10 * 1024 * 1024),
});

export async function sellerRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/seller/dashboard', async (req) => {
    const user = me(req);
    const [tier, available, stats, escrow] = await Promise.all([
      sellerTier(ctx.db, user.id),
      sellerAvailable(ctx.db, user.id),
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
      balances: { availableCents: available, pendingEscrowCents: escrow.pending },
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
    const body = OfferBody.pick({ title: true, description: true, priceCents: true, stock: true, lowStockThreshold: true, deliveryHours: true })
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
    const { amountCents } = z.object({ amountCents: z.number().int().positive() }).parse(req.body);
    return reply.status(201).send(await requestWithdrawal(ctx, me(req).id, amountCents));
  });

  /** Holiday mode: listings disappear from the market and can't be bought until resumed (or `until` passes). */
  app.put('/seller/shop-status', async (req) => {
    const user = me(req);
    const body = z
      .object({ paused: z.boolean(), until: z.string().datetime().optional(), message: z.string().trim().max(200).optional() })
      .parse(req.body);
    if (body.until && new Date(body.until) <= new Date()) throw badRequest('invalid_until', 'Pick a time in the future');
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
    const { id } = Id.parse(req.params);
    const rows = await many(
      ctx.db,
      `SELECT d.id, d.event_type, d.status, d.attempts, d.last_status_code, d.last_error, d.next_attempt_at, d.created_at, d.delivered_at, d.payload
         FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
        WHERE e.id = $1 AND e.user_id = $2 ORDER BY d.created_at DESC LIMIT 100`,
      [id, me(req).id],
    );
    return rows;
  });
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
