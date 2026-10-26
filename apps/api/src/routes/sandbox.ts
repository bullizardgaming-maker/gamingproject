import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { maybeOne, one } from '../db.js';
import { receiveChargeback } from '../domain/chargebacks.js';
import { autoCompleteExpired, confirmOrder, createOrder, handlePaymentCaptured, openDispute } from '../domain/orders.js';
import type { User } from '../domain/users.js';
import { PUBLIC_USER_COLUMNS } from '../domain/users.js';
import { hashPassword, randomToken } from '../lib/crypto.js';
import { forbidden, notFound, unauthorized } from '../lib/errors.js';

/**
 * Sandbox helpers for testing order flows (staging scripts, sellers trying the site). Only mounted
 * when SANDBOX_MODE=true, which also requires the mock payment provider, so no
 * real money or identity checks are involved. Each seller gets their own
 * simulated buyer account.
 */
export const SandboxOrderBody = z.object({ offerId: z.string().uuid(), quantity: z.number().int().positive().max(100).default(1) });
export const SandboxChargebackBody = z.object({
  network: z.enum(['visa', 'mastercard']).default('visa'),
  reasonCode: z.string().max(10).default('10.4'),
});

export async function sandboxRoutes(app: FastifyInstance, ctx: Ctx) {
  /** A signed-in seller (session token). */
  const caller = async (req: FastifyRequest): Promise<User> => {
    if (req.user) return req.user;
    throw unauthorized();
  };

  async function sandboxBuyer(sellerId: string): Promise<User> {
    const email = `sandbox-buyer+${sellerId}@sandbox.invalid`;
    const existing = await maybeOne<User>(ctx.db, `SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE email = $1`, [email]);
    if (existing) return existing;
    return one<User>(
      ctx.db,
      `INSERT INTO users (email, password_hash, display_name, kyc_tier, email_verified_at, phone_verified_at)
       VALUES ($1, $2, 'Sandbox buyer', 1, now(), now()) RETURNING ${PUBLIC_USER_COLUMNS}`,
      [email, await hashPassword(randomToken(24))],
    );
  }

  async function ownOrder(orderId: string, sellerId: string) {
    const o = await maybeOne(ctx.db, 'SELECT * FROM orders WHERE id = $1 AND seller_id = $2', [orderId, sellerId]);
    if (!o) throw notFound('Order');
    return o;
  }
  const Id = z.object({ id: z.string().uuid() });

  app.post('/sandbox/verify-me', async (req) => {
    const user = await caller(req);
    // The sandbox skips onboarding: verified, rules test passed.
    await ctx.db.query(`UPDATE users SET kyc_tier = 2, email_verified_at = now(), phone_verified_at = now(), payouts_enabled = true, rules_passed_at = COALESCE(rules_passed_at, now()),
                          stripe_account_id = COALESCE(stripe_account_id, 'mock_acct_' || substr(id::text, 1, 8)) WHERE id = $1`, [user.id]);
    return { kyc_tier: 2, payouts_enabled: true };
  });

  /** A simulated buyer buys one of your listings and pays. Instant-delivery listings deliver at once. */
  app.post('/sandbox/orders', async (req, reply) => {
    const seller = await caller(req);
    const body = SandboxOrderBody.parse(req.body);
    const offer = await maybeOne(ctx.db, 'SELECT seller_id FROM offers WHERE id = $1', [body.offerId]);
    if (!offer || offer.seller_id !== seller.id) throw forbidden('not_your_offer', 'Sandbox orders can only target your own listings');
    const buyer = await sandboxBuyer(seller.id);
    const { order } = await createOrder(ctx, { buyer, offerId: body.offerId, quantity: body.quantity, rail: 'fiat', acceptTos: true });
    await handlePaymentCaptured(ctx, {
      type: 'payment.captured', ref: order.payment_ref!, orderId: order.id, amountCents: order.amount_cents, currency: order.currency,
      details: { avsResult: 'pass/pass', cvvResult: 'pass', cardBrand: 'visa', cardLast4: '4242', billingCountry: 'US' },
    });
    return reply.status(201).send(await one(ctx.db, 'SELECT * FROM orders WHERE id = $1', [order.id]));
  });

  app.post('/sandbox/orders/:id/confirm', async (req) => {
    const seller = await caller(req);
    const o = await ownOrder(Id.parse(req.params).id, seller.id);
    return confirmOrder(ctx, o.id, o.buyer_id);
  });

  app.post('/sandbox/orders/:id/dispute', async (req) => {
    const seller = await caller(req);
    const o = await ownOrder(Id.parse(req.params).id, seller.id);
    const { reason } = z.object({ reason: z.string().min(10).max(500).default('Sandbox: the item did not work') }).parse(req.body ?? {});
    return openDispute(ctx, o.id, o.buyer_id, reason);
  });

  /** Skip ahead to the end of the protection window, releasing escrow as the worker would. */
  /** Pretend the delivery happened `hours` ago (default 25), so the staff-release rule (24h after delivery) can be exercised. */
  app.post('/sandbox/orders/:id/age-delivery', async (req) => {
    const seller = await caller(req);
    const o = await ownOrder(Id.parse(req.params).id, seller.id);
    const { hours } = z.object({ hours: z.number().min(0).max(24 * 60).default(25) }).parse(req.body ?? {});
    await ctx.db.query(`UPDATE orders SET delivered_at = now() - make_interval(hours => $2) WHERE id = $1 AND status = 'delivered'`, [o.id, hours]);
    return one(ctx.db, 'SELECT id, status, delivered_at FROM orders WHERE id = $1', [o.id]);
  });
  app.post('/sandbox/orders/:id/expire-protection', async (req) => {
    const seller = await caller(req);
    const o = await ownOrder(Id.parse(req.params).id, seller.id);
    await ctx.db.query(`UPDATE orders SET protection_ends_at = now() - interval '1 second' WHERE id = $1 AND status = 'delivered'`, [o.id]);
    await autoCompleteExpired(ctx);
    return one(ctx.db, 'SELECT id, status, completed_at FROM orders WHERE id = $1', [o.id]);
  });

  app.post('/sandbox/orders/:id/chargeback', async (req, reply) => {
    const seller = await caller(req);
    const o = await ownOrder(Id.parse(req.params).id, seller.id);
    const body = SandboxChargebackBody.parse(req.body ?? {});
    return reply.status(201).send(await receiveChargeback(ctx, { orderId: o.id, network: body.network, reasonCode: body.reasonCode, amountCents: o.amount_cents }));
  });

}
