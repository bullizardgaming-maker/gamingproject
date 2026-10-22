import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountId, balance, sellerAvailable } from '../src/domain/ledger.js';
import { runReconciliation } from '../src/domain/reconciliation.js';
import { buyAndPay, makeOffer, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

const platform = async (kind: 'treasury' | 'reserve' | 'tax_payable') => balance(h.ctx.db, await accountId(h.ctx.db, kind, 'USD'));

async function completedSale(seller: Awaited<ReturnType<typeof makeUser>>, priceCents = 100_00) {
  const buyer = await makeUser(h, { tier: 1 });
  const offer = await makeOffer(seller, { categorySlug: 'boosting', deliveryMode: 'manual', stock: 1, priceCents });
  const order = await buyAndPay(h, buyer, offer.id);
  await seller.api.post(`/v1/orders/${order.id}/deliver`, { payload: 'done' });
  await buyer.api.post(`/v1/orders/${order.id}/confirm`);
  const row = (await h.ctx.db.query('SELECT * FROM orders WHERE id = $1', [order.id])).rows[0];
  return { buyer, order: row };
}

describe('refunds after release', () => {
  it('claws the seller’s share back (into debt if needed), returns commission and tax, and issues a credit note', async () => {
    const arbiter = await makeUser(h, { role: 'arbiter' });
    const seller = await makeUser(h, { tier: 2 });
    await h.ctx.db.query(`UPDATE users SET stripe_account_id = 'acct_c', payouts_enabled = true, payout_hold_days = 0 WHERE id = $1`, [seller.id]);
    await seller.api.post('/v1/developer/webhooks', { url: 'https://merchant.example/hook', events: ['order.clawback'] });
    const { buyer, order } = await completedSale(seller);
    // The seller already withdrew everything.
    expect((await seller.api.post('/v1/seller/withdrawals', { amountCents: Number(order.seller_net_cents) })).status).toBe(201);
    const before = { treasury: await platform('treasury'), reserve: await platform('reserve'), tax: await platform('tax_payable') };

    const support = await makeUser(h, { role: 'support' });
    expect((await support.api.post(`/v1/admin/orders/${order.id}/refund-after-release`, { paidBy: 'seller', reason: 'Account reclaimed by original owner' })).status).toBe(403);
    const res = await arbiter.api.post(`/v1/admin/orders/${order.id}/refund-after-release`, { paidBy: 'seller', reason: 'Account reclaimed by original owner' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ fullyRefunded: true, refund: { amount_cents: 100_00, paid_by: 'seller' } });

    // Seller now owes their share; withdrawals are impossible until future sales repay it.
    expect(await sellerAvailable(h.ctx.db, seller.id)).toBe(-Number(order.seller_net_cents));
    expect((await seller.api.get('/v1/seller/dashboard')).body.balances.withdrawableCents).toBe(0);
    // Commission (and the tax and reserve share inside it) went back with the refund.
    const reserveCut = Math.floor((Number(order.commission_cents) * 1_000) / 10_000);
    expect(await platform('tax_payable')).toBe(before.tax - Number(order.commission_tax_cents));
    expect(await platform('reserve')).toBe(before.reserve - reserveCut);
    expect(await platform('treasury')).toBe(before.treasury - (Number(order.commission_cents) - reserveCut - Number(order.commission_tax_cents)));
    expect((await buyer.api.get(`/v1/orders/${order.id}`)).body.status).toBe('refunded');

    const cn = res.body.creditNote;
    expect(cn.number).toMatch(new RegExp(`^BZ-CN-${new Date().getUTCFullYear()}-\\d{6}$`));
    expect(Number(cn.gross_cents)).toBe(Number(order.commission_cents));
    expect(Number(cn.net_cents) + Number(cn.tax_cents)).toBe(Number(cn.gross_cents));
    expect((await seller.api.get('/v1/seller/credit-notes')).body.map((c: any) => c.number)).toEqual([cn.number]);
    expect((await seller.api.get('/v1/me/notifications')).body.items.map((i: any) => i.template)).toContain('clawback');
    const hook = (await h.ctx.db.query(`SELECT payload FROM webhook_deliveries WHERE event_type = 'order.clawback' ORDER BY created_at DESC LIMIT 1`)).rows[0].payload.data;
    expect(hook).toMatchObject({ paid_by: 'seller', seller_debited_cents: Number(order.seller_net_cents), credit_note: cn.number, fully_refunded: true });

    // Statement shows it; tax report nets it out.
    const st = (await seller.api.get('/v1/seller/exports/statement?format=json')).body.rows;
    expect(st.map((r: any) => r.description)).toContain('Refund after release');
    const finance = await makeUser(h, { role: 'finance' });
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const report = (await finance.api.get(`/v1/admin/tax/report?from=${today}&to=${tomorrow}`)).body;
    expect(report.reduce((s: number, r: any) => s + r.credit_notes, 0)).toBeGreaterThanOrEqual(1);

    // A new sale pays the debt down first.
    const next = await completedSale(seller, 50_00);
    expect(await sellerAvailable(h.ctx.db, seller.id)).toBe(Number(next.order.seller_net_cents) - Number(order.seller_net_cents));
    expect((await arbiter.api.post(`/v1/admin/orders/${order.id}/refund-after-release`, { paidBy: 'seller', reason: 'Second attempt here' })).body.error.code).toBe('not_released');
    expect((await runReconciliation(h.ctx)).report.issues).toEqual([]);
  });

  it('supports partial goodwill refunds paid by the platform, and caps a later chargeback', async () => {
    const finance = await makeUser(h, { role: 'finance' });
    const seller = await makeUser(h, { tier: 2 });
    const { order } = await completedSale(seller, 80_00);
    const sellerBefore = await sellerAvailable(h.ctx.db, seller.id);

    const r1 = await finance.api.post(`/v1/admin/orders/${order.id}/refund-after-release`, { amountCents: 20_00, paidBy: 'platform', reason: 'Late delivery goodwill' });
    expect(r1.body.fullyRefunded).toBe(false);
    const r2 = await finance.api.post(`/v1/admin/orders/${order.id}/refund-after-release`, { amountCents: 20_00, paidBy: 'platform', reason: 'Second goodwill gesture' });
    expect(r2.status).toBe(200);
    expect(r2.body.refund.provider_ref).not.toBe(r1.body.refund.provider_ref); // separate PSP refunds
    expect((await finance.api.post(`/v1/admin/orders/${order.id}/refund-after-release`, { amountCents: 40_01, paidBy: 'platform', reason: 'Too much money here' })).body.error).toMatchObject({ code: 'invalid_amount' });
    expect(await sellerAvailable(h.ctx.db, seller.id)).toBe(sellerBefore); // platform paid
    expect((await h.ctx.db.query('SELECT status FROM orders WHERE id = $1', [order.id])).rows[0].status).toBe('completed');

    // The bank can only reverse what is still on the card.
    const cb = await finance.api.post('/v1/admin/chargebacks', { orderId: order.id, network: 'visa', reasonCode: '13.1', amountCents: 80_00 });
    expect(cb.status).toBe(201);
    expect(Number(cb.body.amount_cents)).toBe(40_00);
    expect((await finance.api.post(`/v1/admin/orders/${order.id}/refund-after-release`, { paidBy: 'platform', reason: 'After chargeback' })).body.error.code).toBe('chargeback_exists');
    expect((await runReconciliation(h.ctx)).report.issues).toEqual([]);
  });
});
