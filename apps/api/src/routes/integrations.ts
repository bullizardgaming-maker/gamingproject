import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { maybeOne } from '../db.js';
import { closeChargeback, receiveChargeback } from '../domain/chargebacks.js';
import { handleChainEvent, handlePaymentCaptured, type ChainEvent } from '../domain/orders.js';
import { applyKycResult } from '../domain/users.js';
import { applyPayoutAccountUpdate } from '../domain/payouts.js';
import { applyCryptoPayment } from '../domain/cryptoPayments.js';
import { applyCryptoPayout } from '../domain/cryptoPayouts.js';
import { debtPaymentByRef, handleDebtPaymentCaptured } from '../domain/debts.js';
import { checkoutByRef, closeCheckoutChargeback, handleCheckoutCaptured, receiveCheckoutChargeback } from '../domain/cart.js';
import { hmacSha256, safeEqual } from '../lib/crypto.js';
import { badRequest, notFound, unauthorized } from '../lib/errors.js';
import { MockPaymentProvider } from '../providers/payments/mock.js';
import type { PaymentEvent } from '../providers/payments/types.js';

export async function processPaymentEvent(ctx: Ctx, ev: PaymentEvent) {
  switch (ev.type) {
    case 'payment.captured':
      // The same PSP checkout also takes sellers' debt repayments.
      if (await debtPaymentByRef(ctx.db, ev.ref)) return handleDebtPaymentCaptured(ctx, ev);
      // ...and carts: one payment for several orders.
      if (await checkoutByRef(ctx.db, ev.ref)) return handleCheckoutCaptured(ctx, ev);
      return handlePaymentCaptured(ctx, ev);
    case 'chargeback.created': {
      const checkout = await checkoutByRef(ctx.db, ev.paymentRef);
      if (checkout) return receiveCheckoutChargeback(ctx, checkout, ev);
      return receiveChargeback(ctx, { paymentRef: ev.paymentRef, disputeRef: ev.disputeRef, network: ev.network, reasonCode: ev.reasonCode, amountCents: ev.amountCents });
    }
    case 'chargeback.closed':
      return (await closeCheckoutChargeback(ctx, ev.disputeRef, ev.won)) ?? closeChargeback(ctx, ev.disputeRef, ev.won);
    case 'payout_account.updated':
      return applyPayoutAccountUpdate(ctx, ev.accountRef, ev.payoutsEnabled);
    case 'crypto.payment':
      return applyCryptoPayment(ctx, ev);
    case 'crypto.payout':
      return applyCryptoPayout(ctx, ev);
    default:
      return null; // payment.failed: the unpaid-order reaper releases stock when the window lapses
  }
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function integrationRoutes(app: FastifyInstance, ctx: Ctx) {
  // --- PSP webhooks ------------------------------------------------------------------
  app.post('/payments/webhook/:provider', async (req, reply) => {
    const { provider } = z.object({ provider: z.string() }).parse(req.params);
    if (provider !== ctx.payments.name) throw notFound('Provider');
    let ev: PaymentEvent;
    try {
      ev = await ctx.payments.parseWebhook(req.rawBody ?? Buffer.alloc(0), req.headers);
    } catch (err) {
      ctx.log.warn({ err: (err as Error).message }, 'rejected payment webhook');
      throw unauthorized('Invalid webhook signature');
    }
    await processPaymentEvent(ctx, ev);
    return reply.send({ received: true });
  });

  // --- Mock hosted checkout (development only) ---------------------------------------
  if (ctx.payments instanceof MockPaymentProvider) {
    const mock = ctx.payments;
    // A checkout is for an order or for a seller repaying a negative balance; both look alike here.
    const orderByRef = async (ref: string) =>
      (await maybeOne(
        ctx.db,
        `SELECT c.id, c.buyer_id, c.presentment_amount_cents, c.presentment_currency, 1 AS quantity, true AS is_cart,
                (SELECT count(*) || ' items' FROM orders o WHERE o.checkout_id = c.id) AS title,
                (SELECT o.buyer_ip_country FROM orders o WHERE o.checkout_id = c.id LIMIT 1) AS buyer_ip_country
           FROM checkouts c WHERE c.payment_provider = 'mock' AND c.payment_ref = $1`,
        [ref],
      )) ??
      (await maybeOne(ctx.db, `SELECT o.*, f.title FROM orders o JOIN offers f ON f.id = o.offer_id WHERE o.payment_provider = 'mock' AND o.payment_ref = $1 AND o.checkout_id IS NULL`, [ref])) ??
      (await maybeOne(
        ctx.db,
        `SELECT id, seller_id AS buyer_id, amount_cents AS presentment_amount_cents, currency AS presentment_currency, 1 AS quantity,
                'Balance repayment' AS title, NULL AS buyer_ip_country, true AS is_debt
           FROM debt_payments WHERE payment_provider = 'mock' AND payment_ref = $1`,
        [ref],
      ));

    app.get('/payments/mock/checkout/:ref', async (req, reply) => {
      const { ref } = z.object({ ref: z.string().max(100) }).parse(req.params);
      const order = await orderByRef(ref);
      if (!order) throw notFound('Checkout session');
      reply.header('Content-Type', 'text/html; charset=utf-8');
      // form-action also governs the post-submit redirect back to the web app.
      reply.header('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${new URL(ctx.cfg.PUBLIC_WEB_URL).origin}`);
      return `<!doctype html><html><head><meta charset="utf-8"><title>Mock Hosted Checkout</title>
<style>body{font:15px system-ui;background:#0b0f17;color:#e6e9ef;display:grid;place-items:center;min-height:100vh;margin:0}
form{background:#141a26;padding:28px;border-radius:12px;width:340px}button{width:100%;padding:12px;border:0;border-radius:8px;background:#3ddc97;font-weight:600;margin-top:16px;cursor:pointer}
small{color:#8b93a7}</style></head><body><form method="post" action="/v1/payments/mock/checkout/${escapeHtml(ref)}/pay">
<h2>Mock hosted checkout</h2><p>${escapeHtml(order.title)} × ${order.quantity}</p>
<p><strong>${(Number(order.presentment_amount_cents) / 100).toFixed(2)} ${order.presentment_currency}</strong></p>
<small>In production this page is the PSP's hosted checkout (Stripe Checkout / Adyen Drop-in). Card data never touches marketplace servers (PCI DSS SAQ-A).</small>
<button type="submit">Pay (test card 4242)</button></form></body></html>`;
    });

    // Stand-in for the PSP-hosted onboarding flow: completing it enables payouts via the signed webhook path.
    app.get('/payments/mock/onboarding/:account', async (req, reply) => {
      const { account } = z.object({ account: z.string().regex(/^mock_acct_[a-f0-9]{8}$/) }).parse(req.params);
      const { return: back } = z.object({ return: z.string().url() }).parse(req.query);
      if (new URL(back).origin !== new URL(ctx.cfg.PUBLIC_WEB_URL).origin) throw badRequest('invalid_return', 'Return URL must be the web app');
      mock.enabledAccounts.add(account);
      const raw = JSON.stringify({ type: 'payout_account.updated', accountRef: account, payoutsEnabled: true });
      await processPaymentEvent(ctx, await mock.parseWebhook(Buffer.from(raw), { 'x-mock-signature': mock.sign(raw) }));
      if ((req.headers.accept ?? '').includes('application/json')) return { payoutsEnabled: true };
      return reply.redirect(back, 303);
    });

    app.post('/payments/mock/checkout/:ref/pay', async (req, reply) => {
      const { ref } = z.object({ ref: z.string().max(100) }).parse(req.params);
      const order = await orderByRef(ref);
      if (!order) throw notFound('Checkout session');
      const body = (req.body ?? {}) as Record<string, string>;
      const ev: PaymentEvent = {
        type: 'payment.captured',
        ref,
        orderId: order.id,
        amountCents: Number(order.presentment_amount_cents),
        currency: order.presentment_currency,
        details: {
          avsResult: body.avs ?? 'pass/pass',
          cvvResult: body.cvv ?? 'pass',
          cardBrand: body.brand ?? 'visa',
          cardLast4: '4242',
          cardFingerprint: body.cardFingerprint ?? `mockcard_${order.buyer_id.slice(0, 8)}`,
          billingCountry: body.billingCountry ?? order.buyer_ip_country ?? 'US',
          feeCents: body.feeCents ? Number(body.feeCents) : undefined,
          // Tests/dev can simulate the PSP converting a foreign-currency charge at a different rate.
          settledAmountCents: body.settledCents ? Number(body.settledCents) : undefined,
        },
      };
      // Exercise the same signed-webhook path a real PSP would use.
      const raw = JSON.stringify(ev);
      const parsed = await mock.parseWebhook(Buffer.from(raw), { 'x-mock-signature': mock.sign(raw) });
      await processPaymentEvent(ctx, parsed);
      if ((req.headers.accept ?? '').includes('application/json')) return { paid: true, orderId: order.id };
      const back = order.is_debt ? '/sell/money?repaid=1' : order.is_cart ? '/orders?checkout=success' : `/orders/${order.id}?checkout=success`;
      return reply.redirect(`${ctx.cfg.PUBLIC_WEB_URL}${back}`, 303);
    });
  }

  // --- KYC provider webhooks ------------------------------------------------------------
  app.post('/kyc/webhook/:provider', async (req) => {
    const { provider } = z.object({ provider: z.string() }).parse(req.params);
    if (provider !== ctx.kyc.name) throw notFound('Provider');
    let result;
    try {
      result = await ctx.kyc.parseWebhook(req.rawBody ?? Buffer.alloc(0), req.headers);
    } catch {
      throw unauthorized('Invalid webhook signature');
    }
    if (result) await applyKycResult(ctx, result);
    return { received: true };
  });

  // --- On-chain escrow indexer -------------------------------------------------------------
  const ChainEventBody = z.discriminatedUnion('type', [
    z.object({ type: z.literal('EscrowCreated'), orderId: z.string().uuid(), txHash: z.string(), amount: z.string().regex(/^\d+$/) }),
    z.object({ type: z.literal('DisputeOpened'), orderId: z.string().uuid(), txHash: z.string() }),
    z.object({ type: z.literal('EscrowSettled'), orderId: z.string().uuid(), txHash: z.string(), outcome: z.enum(['released', 'refunded', 'split']) }),
  ]);
  app.post('/crypto/events', async (req) => {
    const sig = String(req.headers['x-indexer-signature'] ?? '');
    if (!safeEqual(sig, hmacSha256(ctx.cfg.CRYPTO_INDEXER_SECRET, req.rawBody ?? Buffer.alloc(0)))) throw unauthorized('Invalid indexer signature');
    const ev = ChainEventBody.parse(req.body) as ChainEvent;
    const order = await handleChainEvent(ctx, ev);
    return { ok: true, status: order.status };
  });

  // --- PCI DSS 11.6.1: CSP violation reports from payment pages -----------------------------
  app.post('/security/csp-report', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body: any = req.body ?? {};
    const reports = Array.isArray(body) ? body.map((r: any) => r.body ?? r) : [body['csp-report'] ?? body];
    for (const r of reports.slice(0, 20)) {
      if (!r || typeof r !== 'object') throw badRequest('invalid_report', 'Malformed CSP report');
      await ctx.db.query('INSERT INTO csp_reports (document_uri, blocked_uri, directive, payload) VALUES ($1, $2, $3, $4)', [
        String(r['document-uri'] ?? r.documentURL ?? '').slice(0, 2_000),
        String(r['blocked-uri'] ?? r.blockedURL ?? '').slice(0, 2_000),
        String(r['violated-directive'] ?? r.effectiveDirective ?? '').slice(0, 200),
        JSON.stringify(r),
      ]);
      ctx.log.warn({ blocked: r['blocked-uri'] ?? r.blockedURL }, 'CSP violation on payment page');
    }
    return reply.status(204).send();
  });

}
