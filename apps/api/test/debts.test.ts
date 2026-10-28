import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collectDebts } from '../src/domain/debts.js';
import { sellerAvailable } from '../src/domain/ledger.js';
import { runReconciliation } from '../src/domain/reconciliation.js';
import { buyAndPay, client, makeOffer, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

const DAY = 86_400_000;
const later = (days: number) => new Date(Date.now() + days * DAY);
const templates = async (u: { api: any }) => (await u.api.get('/v1/me/notifications?limit=50')).body.items.map((i: any) => i.template) as string[];
const debtOf = async (sellerId: string) => (await h.ctx.db.query('SELECT * FROM seller_debts WHERE seller_id = $1 ORDER BY opened_at DESC LIMIT 1', [sellerId])).rows[0];

/** A seller who sold, withdrew everything, then had the order refunded after release: they owe their share. */
async function sellerInDebt() {
  const arbiter = await makeUser(h, { role: 'arbiter' });
  const seller = await makeUser(h, { tier: 2 });
  await h.ctx.db.query(`UPDATE users SET payout_address = 'TTestPayoutAddress123456', payout_address_currency = 'usdttrc20', payout_address_set_at = now(), payouts_enabled = true, payout_hold_days = 0 WHERE id = $1`, [seller.id]);
  const buyer = await makeUser(h, { tier: 1 });
  const offer = await makeOffer(seller, { categorySlug: 'boosting', deliveryMode: 'manual', stock: 1, priceCents: 60_00 });
  const order = await buyAndPay(h, buyer, offer.id);
  await seller.api.post(`/v1/orders/${order.id}/deliver`, { payload: 'done' });
  await buyer.api.post(`/v1/orders/${order.id}/confirm`);
  const net = Number((await h.ctx.db.query('SELECT seller_net_cents FROM orders WHERE id = $1', [order.id])).rows[0].seller_net_cents);
  expect((await seller.api.post('/v1/seller/withdrawals', { amountCents: net })).status).toBe(201);
  expect((await arbiter.api.post(`/v1/admin/orders/${order.id}/refund-after-release`, { paidBy: 'seller', reason: 'Account reclaimed by original owner' })).status).toBe(200);
  expect(await sellerAvailable(h.ctx.db, seller.id)).toBe(-net);
  return { seller, net };
}

describe('seller debt collection', () => {
  it('reminds, pauses the shop, and reopens it when the seller repays by card', async () => {
    const finance = await makeUser(h, { role: 'finance' });
    const { seller, net } = await sellerInDebt();
    const listing = await makeOffer(seller, { categorySlug: 'boosting', deliveryMode: 'manual', stock: 3, priceCents: 20_00, title: 'Still listed' });

    // Day 0: case opened, first reminder, withdrawals blocked.
    await collectDebts(h.ctx);
    let debt = await debtOf(seller.id);
    expect(debt).toMatchObject({ currency: 'USD', reminders_sent: 1, closed_at: null, paused_at: null });
    expect(Number(debt.owed_cents)).toBe(net);
    expect(await templates(seller)).toContain('debt_reminder');
    expect((await seller.api.post('/v1/seller/withdrawals', { amountCents: 100 })).body.error.code).toBe('debt_outstanding');
    const dash = (await seller.api.get('/v1/seller/dashboard')).body;
    expect(dash.debts).toEqual([expect.objectContaining({ id: debt.id, owedCents: net, shopPausedAt: null })]);

    // Running again the same day sends nothing new; day 3 sends the second reminder (not a burst).
    await collectDebts(h.ctx, later(1));
    expect((await debtOf(seller.id)).reminders_sent).toBe(1);
    await collectDebts(h.ctx, later(8));
    expect((await debtOf(seller.id)).reminders_sent).toBe(3);
    expect((await templates(seller)).filter((t) => t === 'debt_reminder')).toHaveLength(2);

    // Day 15: shop paused, finance told, listings gone, the seller can't lift it themselves.
    await collectDebts(h.ctx, later(15));
    debt = await debtOf(seller.id);
    expect(debt.paused_at).not.toBeNull();
    expect(await templates(seller)).toContain('debt_shop_paused');
    expect(await templates(finance)).toContain('debt_escalated');
    expect((await client(h.app).get(`/v1/offers?seller=${seller.id}`)).body.total).toBe(0);
    expect((await seller.api.put('/v1/seller/shop-status', { paused: false })).body.error.code).toBe('debt_outstanding');
    const buyer = await makeUser(h, { tier: 1 });
    expect((await buyer.api.post('/v1/orders', { offerId: listing.id, quantity: 1, acceptTos: true })).body.error.code).toBe('shop_paused');

    // Staff view; regular users can't see it.
    expect((await finance.api.get('/v1/admin/debts')).body.map((d: any) => d.id)).toContain(debt.id);
    expect((await seller.api.get('/v1/admin/debts')).status).toBe(403);

    // Repay by card through the hosted checkout: balance back to zero, case closed, shop reopened.
    expect((await seller.api.post(`/v1/seller/debts/${debt.id}/pay`, { amountCents: net + 1 })).body.error.code).toBe('invalid_amount');
    const pay = await seller.api.post(`/v1/seller/debts/${debt.id}/pay`, {});
    expect(pay.status).toBe(201);
    expect(pay.body).toMatchObject({ amountCents: net, currency: 'USD' });
    const ref = pay.body.checkoutUrl.split('/').pop();
    expect((await client(h.app).post(`/v1/payments/mock/checkout/${ref}/pay`, { feeCents: '30' }, { accept: 'application/json' })).status).toBe(200);
    // A replayed webhook doesn't credit twice.
    expect((await client(h.app).post(`/v1/payments/mock/checkout/${ref}/pay`, {}, { accept: 'application/json' })).status).toBe(200);

    expect(await sellerAvailable(h.ctx.db, seller.id)).toBe(0);
    debt = await debtOf(seller.id);
    expect(debt).toMatchObject({ closed_reason: 'repaid' });
    expect(await templates(seller)).toContain('debt_cleared');
    const u = (await h.ctx.db.query('SELECT shop_paused, shop_paused_for_debt FROM users WHERE id = $1', [seller.id])).rows[0];
    expect(u).toEqual({ shop_paused: false, shop_paused_for_debt: false });
    expect((await client(h.app).get(`/v1/offers?seller=${seller.id}`)).body.total).toBe(1);
    expect((await finance.api.get('/v1/admin/debts?status=closed')).body.map((d: any) => d.id)).toContain(debt.id);
    expect((await runReconciliation(h.ctx)).report.issues).toEqual([]);
  });

  it('closes as written off after a four-eyes adjustment, and leaves a holiday pause the seller set alone', async () => {
    const { seller, net } = await sellerInDebt();
    await collectDebts(h.ctx);
    // The seller went on holiday themselves before the debt pause.
    expect((await seller.api.put('/v1/seller/shop-status', { paused: true, message: 'Back next week' })).status).toBe(200);
    await collectDebts(h.ctx, later(15));
    expect((await debtOf(seller.id)).paused_at).not.toBeNull();
    expect((await h.ctx.db.query('SELECT shop_pause_message, shop_paused_for_debt FROM users WHERE id = $1', [seller.id])).rows[0]).toEqual({
      shop_pause_message: 'Back next week',
      shop_paused_for_debt: false,
    });

    const a = await makeUser(h, { role: 'admin' });
    const b = await makeUser(h, { role: 'admin' });
    const req = await a.api.post('/v1/admin/ledger/adjustments', {
      reason: 'Write off unrecoverable seller debt',
      lines: [
        { kind: 'seller_available', ownerId: seller.id, currency: 'USD', amountCents: net },
        { kind: 'treasury', ownerId: null, currency: 'USD', amountCents: -net },
      ],
    });
    expect(req.status).toBe(201);
    expect((await b.api.post(`/v1/admin/ledger/adjustments/${req.body.id}/decide`, { approve: true })).status).toBe(200);
    await collectDebts(h.ctx, later(16));

    expect((await debtOf(seller.id)).closed_reason).toBe('written_off');
    // Their own holiday pause stays; they can lift it now that nothing is owed.
    const u = (await h.ctx.db.query('SELECT shop_paused, shop_pause_message FROM users WHERE id = $1', [seller.id])).rows[0];
    expect(u).toEqual({ shop_paused: true, shop_pause_message: 'Back next week' });
    expect((await seller.api.put('/v1/seller/shop-status', { paused: false })).status).toBe(200);
  });
});
