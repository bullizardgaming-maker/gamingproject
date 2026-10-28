import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { holdPolicy } from '../src/domain/payoutholds.js';
import { buyAndPay, makeOffer, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

async function sellerWithSale(priceCents = 50_00) {
  const seller = await makeUser(h, { tier: 2 });
  await h.ctx.db.query(`UPDATE users SET payout_address = 'TTestPayoutAddress123456', payout_address_currency = 'usdttrc20', payout_address_set_at = now(), payouts_enabled = true WHERE id = $1`, [seller.id]);
  const buyer = await makeUser(h, { tier: 1 });
  const offer = await makeOffer(seller, { categorySlug: 'boosting', deliveryMode: 'manual', stock: 5, priceCents });
  const order = await buyAndPay(h, buyer, offer.id);
  await seller.api.post(`/v1/orders/${order.id}/deliver`, { payload: 'done' });
  await buyer.api.post(`/v1/orders/${order.id}/confirm`);
  return { seller, order: (await seller.api.get(`/v1/orders/${order.id}`)).body }; // the seller's view carries seller_net_cents (Round 23e)
}

describe('payout holds', () => {
  it('holds a new seller’s released money for 1 day (CEO, Oct 24), then lets it go', async () => {
    const { seller, order } = await sellerWithSale();
    const dash = (await seller.api.get('/v1/seller/dashboard')).body;
    expect(dash.payoutHold).toMatchObject({ level: 'new', days: 1 });
    expect(dash.balances.onHoldCents).toBe(order.seller_net_cents);
    expect(dash.balances.withdrawableCents).toBe(0);

    const refused = await seller.api.post('/v1/seller/withdrawals', { amountCents: 100 });
    expect(refused.body.error.code).toBe('insufficient_funds');
    expect(refused.body.error.message).toMatch(/1-day payout hold/);
    expect(refused.body.error.details.upcoming).toHaveLength(1);

    // A day and a bit later the release has cleared the hold.
    await h.ctx.db.query(`ALTER TABLE ledger_entries DISABLE TRIGGER USER`);
    await h.ctx.db.query(`UPDATE ledger_entries SET created_at = created_at - interval '26 hours' WHERE order_id = $1`, [order.id]);
    await h.ctx.db.query(`ALTER TABLE ledger_entries ENABLE TRIGGER USER`);
    const after = (await seller.api.get('/v1/seller/payout-hold')).body;
    expect(after).toMatchObject({ heldCents: 0, withdrawableCents: order.seller_net_cents });
    expect((await seller.api.post('/v1/seller/withdrawals', { amountCents: order.seller_net_cents })).status).toBe(201);
  });

  it('shortens the hold with a track record and lets staff override it', async () => {
    const { seller, order } = await sellerWithSale();
    await h.ctx.db.query(`UPDATE users SET created_at = now() - interval '40 days' WHERE id = $1`, [seller.id]);
    // Ten more completed sales (copies of the first order).
    for (let i = 0; i < 10; i++) {
      await h.ctx.db.query(
        `INSERT INTO orders SELECT (jsonb_populate_record(NULL::orders, to_jsonb(o) || jsonb_build_object('id', gen_random_uuid(), 'idempotency_key', NULL, 'payment_ref', NULL, 'ref', 'order#' || upper(substr(md5(random()::text), 1, 7))))).* FROM orders o WHERE o.id = $1`,
        [order.id],
      );
    }
    expect((await holdPolicy(h.ctx, h.ctx.db, seller.id)).level).toBe('established');
    expect((await holdPolicy(h.ctx, h.ctx.db, seller.id)).holdDays).toBe(0); // established sellers: no hold (CEO, Oct 24)

    const admin = await makeUser(h, { role: 'admin' });
    const set = await admin.api.put(`/v1/admin/users/${seller.id}/payout-hold`, { days: 30, reason: 'Unusual refund pattern' });
    expect(set.body).toMatchObject({ level: 'custom', holdDays: 30 });
    await admin.api.put(`/v1/admin/users/${seller.id}/payout-hold`, { days: null, reason: 'Review finished' });
    expect((await holdPolicy(h.ctx, h.ctx.db, seller.id)).level).toBe('established');
  });
});
