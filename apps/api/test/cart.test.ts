import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { client, makeOffer, makeUser, setup, type Harness } from './helpers.js';
import { splitProportional } from '../src/domain/cart.js';
import { processPaymentEvent } from '../src/routes/integrations.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

const pay = (ref: string, extra: Record<string, string> = {}) => client(h.app).post(`/v1/payments/mock/checkout/${ref}/pay`, extra, { accept: 'application/json' });
const statuses = async (ids: string[]) => (await h.ctx.db.query('SELECT id, status FROM orders WHERE id = ANY($1)', [ids])).rows.reduce((m: any, r: any) => ({ ...m, [r.id]: r.status }), {});

describe('cart checkout', () => {
  it('splits amounts exactly', () => {
    expect(splitProportional(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(splitProportional(999, [500, 499])).toEqual([500, 499]);
    expect(splitProportional(5, [0, 0])).toEqual([0, 0]);
  });

  it('pays listings from several sellers with one payment, one escrow order each', async () => {
    const s1 = await makeUser(h, { tier: 2 });
    const s2 = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h);
    const key = await makeOffer(s1, { priceCents: 10_00, deliveryMode: 'auto' });
    await s1.api.post(`/v1/offers/${key.id}/inventory`, { format: 'txt', content: 'K-1\nK-2\nK-3' });
    const gold = (await s2.api.post('/v1/offers', { categorySlug: 'currency', game: 'Cart Game', title: 'Gold', priceCents: 5_00, deliveryMode: 'manual', stock: 50, priceTiers: [{ minQty: 10, priceCents: 4_00 }] })).body;

    const res = await buyer.api.post('/v1/orders/cart', { items: [{ offerId: key.id, quantity: 2 }, { offerId: gold.id, quantity: 10 }], acceptTos: true });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.orders).toHaveLength(2);
    expect(res.body.orders.map((o: any) => [o.seller_id, o.amount_cents])).toEqual([[s1.id, 21_06], [s2.id, 42_11]]); // seller prices 20.00 / 40.00 grossed up by 5%
    expect(res.body.checkout).toMatchObject({ status: 'awaiting_payment', presentment_amount_cents: 63_17, presentment_currency: 'USD' });
    expect(res.body.checkoutUrl).toContain('/v1/payments/mock/checkout/');
    const ids = res.body.orders.map((o: any) => o.id);

    const paid = await pay(res.body.checkout.payment_ref, { settledCents: '6316', feeCents: '180' });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    const st = await statuses(ids);
    expect(st[ids[0]]).toBe('delivered'); // instant keys
    expect(st[ids[1]]).toBe('paid');
    expect((await buyer.api.get(`/v1/checkouts/${res.body.checkout.id}`)).body.checkout.status).toBe('paid');
    expect((await s1.api.get(`/v1/checkouts/${res.body.checkout.id}`)).status).toBe(404);
    // Each order has its own chat and escrow; the capture split adds back up.
    const captured = (await h.ctx.db.query(
      `SELECT sum(e.amount_cents)::int AS n FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
        WHERE e.order_id = ANY($1) AND e.memo = 'payment_captured' AND a.kind = 'gateway_clearing'`,
      [ids],
    )).rows[0];
    expect(Math.abs(captured.n)).toBe(6316);

    // Replayed capture changes nothing.
    await pay(res.body.checkout.payment_ref);
    expect(await statuses(ids)).toEqual(st);
  });

  it('cancels the whole cart when one item fails, releasing reserved stock', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h);
    const a = await makeOffer(seller, { deliveryMode: 'manual', stock: 3 });
    const b = await makeOffer(seller, { deliveryMode: 'manual', stock: 1 });
    const res = await buyer.api.post('/v1/orders/cart', { items: [{ offerId: a.id, quantity: 2 }, { offerId: b.id, quantity: 5 }], acceptTos: true });
    expect(res.status).toBe(409);
    expect((await h.ctx.db.query('SELECT stock FROM offers WHERE id = $1', [a.id])).rows[0].stock).toBe(3);
    const left = (await h.ctx.db.query(`SELECT status FROM orders WHERE buyer_id = $1`, [buyer.id])).rows.map((r) => r.status);
    expect(left.every((s) => s === 'cancelled')).toBe(true);
    // Own listings and duplicates are refused.
    expect((await seller.api.post('/v1/orders/cart', { items: [{ offerId: a.id, quantity: 1 }], acceptTos: true })).status).toBe(403);
    expect((await buyer.api.post('/v1/orders/cart', { items: [{ offerId: a.id, quantity: 1 }, { offerId: a.id, quantity: 1 }], acceptTos: true })).status).toBe(400);
  });

  it('refunds one order of a cart on its own, and shares a chargeback across the orders', async () => {
    const s1 = await makeUser(h, { tier: 2 });
    const s2 = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h);
    const arbiter = await makeUser(h, { tier: 2, role: 'arbiter' });
    const a = await makeOffer(s1, { deliveryMode: 'manual', stock: 2, priceCents: 30_00 });
    const b = await makeOffer(s2, { deliveryMode: 'manual', stock: 2, priceCents: 10_00 });
    const res = await buyer.api.post('/v1/orders/cart', { items: [{ offerId: a.id, quantity: 1 }, { offerId: b.id, quantity: 1 }], acceptTos: true }, { 'idempotency-key': 'cart-1' });
    // Same idempotency key: the same checkout back.
    const again = await buyer.api.post('/v1/orders/cart', { items: [{ offerId: a.id, quantity: 1 }, { offerId: b.id, quantity: 1 }], acceptTos: true }, { 'idempotency-key': 'cart-1' });
    expect(again.status).toBe(200);
    expect(again.body.checkout.id).toBe(res.body.checkout.id);
    const ref = res.body.checkout.payment_ref;
    await pay(ref);
    const [oa, ob] = res.body.orders;

    const refund = vi.spyOn(h.ctx.payments, 'refund');
    const d = await buyer.api.post(`/v1/orders/${ob.id}/dispute`, { reason: 'Never received the item' });
    await arbiter.api.post(`/v1/admin/disputes/${d.body.id}/resolve`, { outcome: 'buyer', note: 'Seller did not deliver' });
    expect(refund).toHaveBeenCalledWith(ref, ob.amount_cents, 'USD', `refund_order_${ob.id}`);
    expect(ob.amount_cents).toBe(10_53);
    expect(await statuses([oa.id, ob.id])).toEqual({ [oa.id]: 'paid', [ob.id]: 'refunded' });
    refund.mockRestore();

    await processPaymentEvent(h.ctx, { type: 'chargeback.created', disputeRef: 'dp_cart_1', paymentRef: ref, network: 'visa', reasonCode: '13.1', amountCents: oa.amount_cents + ob.amount_cents });
    const cbs = (await h.ctx.db.query(`SELECT order_id, amount_cents, provider_ref FROM chargebacks WHERE provider_ref LIKE 'dp_cart_1:%' ORDER BY amount_cents DESC`)).rows;
    expect(cbs.map((c) => c.order_id).sort()).toEqual([oa.id, ob.id].sort());
    expect(cbs.reduce((n, c) => n + Number(c.amount_cents), 0)).toBeLessThanOrEqual(oa.amount_cents + ob.amount_cents);
    expect(cbs.find((c) => c.order_id === oa.id).amount_cents).toBe(oa.amount_cents);
    await processPaymentEvent(h.ctx, { type: 'chargeback.closed', disputeRef: 'dp_cart_1', won: true });
    const closed = (await h.ctx.db.query(`SELECT status FROM chargebacks WHERE provider_ref LIKE 'dp_cart_1:%'`)).rows.map((r) => r.status);
    expect(closed.every((s) => s === 'won')).toBe(true);
  });
  it('spends the buyer’s balance first: a cart it covers is paid at once, otherwise only the rest is charged', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h);
    const { post, accountId } = await import('../src/domain/ledger.js');
    const { withTx } = await import('../src/db.js');
    await withTx(h.ctx.db, async (tx) =>
      post(tx, [
        { account: await accountId(tx, 'treasury', 'USD'), amountCents: -25_00 },
        { account: await accountId(tx, 'user_credit', 'USD', buyer.id), amountCents: 25_00 },
      ], 'test_credit'),
    );
    const gold = await makeOffer(seller, { categorySlug: 'currency', deliveryMode: 'manual', stock: 50, priceCents: 10_00 });
    const gems = await makeOffer(seller, { categorySlug: 'currency', deliveryMode: 'manual', stock: 50, priceCents: 20_00 });

    // 10.53 + 21.06 = 31.59: the 25.00 balance pays the first order and part of the second.
    const res = await buyer.api.post('/v1/orders/cart', { items: [{ offerId: gold.id }, { offerId: gems.id }], acceptTos: true, useCredit: true });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.orders.map((o: any) => [o.amount_cents, o.credit_cents, o.charged_cents])).toEqual([[10_53, 10_53, 0], [21_06, 14_47, 6_59]]);
    expect(res.body.checkout).toMatchObject({ status: 'awaiting_payment', presentment_amount_cents: 6_59 });
    await pay(res.body.checkout.payment_ref);
    const ids = res.body.orders.map((o: any) => o.id);
    expect(await statuses(ids)).toEqual({ [ids[0]]: 'paid', [ids[1]]: 'paid' });
    expect((await buyer.api.get('/v1/me/credit')).body.availableCents).toBe(0);

    // Nothing left to charge: the cart is paid without a payment step.
    await withTx(h.ctx.db, async (tx) =>
      post(tx, [
        { account: await accountId(tx, 'treasury', 'USD'), amountCents: -50_00 },
        { account: await accountId(tx, 'user_credit', 'USD', buyer.id), amountCents: 50_00 },
      ], 'test_credit'),
    );
    const covered = await buyer.api.post('/v1/orders/cart', { items: [{ offerId: gold.id }], acceptTos: true, useCredit: true });
    expect(covered.status, JSON.stringify(covered.body)).toBe(201);
    expect(covered.body.checkoutUrl).toBeNull();
    expect(covered.body.checkout).toMatchObject({ status: 'paid', presentment_amount_cents: 0 });
    expect(covered.body.orders[0]).toMatchObject({ status: 'paid', credit_cents: 10_53, charged_cents: 0 });
    expect((await buyer.api.get('/v1/me/credit')).body.availableCents).toBe(39_47);
  });
});
