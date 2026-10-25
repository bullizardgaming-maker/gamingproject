import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sellerAvailable } from '../src/domain/ledger.js';
import { runReconciliation } from '../src/domain/reconciliation.js';
import type { MockPaymentProvider } from '../src/providers/payments/mock.js';
import { endWindowAndRelease, buyAndPay, client, makeOffer, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  // Static rates: 1 USD = 0.92 EUR. Tax out of the way (US seller) to keep the arithmetic readable.
  h = await setup({ FX_STATIC_RATES: '{"EUR":0.92,"EGP":48.5}', FX_SPREAD_BPS: '100', PAYOUT_CURRENCIES: 'USD,EUR' });
});
afterAll(async () => h.close());

async function eurSeller() {
  const seller = await makeUser(h, { tier: 2 });
  await seller.api.put('/v1/seller/tax-profile', { country: 'US', isBusiness: false });
  // Round 22b: sellers can no longer choose EUR; this is a seller who chose it before (balances in EUR still exist).
  await h.ctx.db.query(`UPDATE users SET payout_currency = 'EUR' WHERE id = $1`, [seller.id]);
  await h.ctx.db.query(`UPDATE users SET stripe_account_id = 'acct_eur', payouts_enabled = true, payout_hold_days = 0 WHERE id = $1`, [seller.id]);
  return seller;
}

describe('seller balances in their own currency', () => {
  it('Round 22b: the payout currency is USD only, whatever PAYOUT_CURRENCIES says (400 unsupported_currency)', async () => {
    expect(h.ctx.cfg.PAYOUT_CURRENCIES).toContain('EUR');
    const seller = await makeUser(h, { tier: 2 });
    for (const currency of ['EUR', 'EGP', 'eur']) {
      const r = await seller.api.put('/v1/seller/payout-currency', { currency });
      expect(r.status, currency).toBe(400);
      expect(r.body.error.code, currency).toBe('unsupported_currency');
    }
    expect((await seller.api.put('/v1/seller/payout-currency', { currency: 'USD' })).body.payoutCurrency).toBe('USD');
  });

  it('credits a EUR seller their EUR price minus commission at the rate locked at order time, but withdraws in USD only', async () => {
    const seller = await eurSeller();
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller, { priceCents: 92_00, currency: 'EUR', categorySlug: 'boosting', deliveryMode: 'manual', stock: 1 } as any);
    const order = await buyAndPay(h, buyer, offer.id);
    const row = (await h.ctx.db.query('SELECT * FROM orders WHERE id = $1', [order.id])).rows[0];
    expect(row).toMatchObject({ amount_cents: 105_27, seller_net_cents: 100_00, seller_currency: 'EUR' }); // 92.00 EUR = 100.00 USD, plus 5% grossed up
    expect(Number(row.seller_fx_rate)).toBeCloseTo(0.92, 10); // mid-market: no spread for the seller

    // EUR weakens before release: the seller is unaffected, the platform carries the move.
    await h.ctx.db.query(`UPDATE fx_rates SET rate = 0.80 WHERE currency = 'EUR'`);
    await seller.api.post(`/v1/orders/${order.id}/deliver`, { payload: 'done' });
    await buyer.api.post(`/v1/orders/${order.id}/confirm`);
    await h.ctx.db.query(`UPDATE fx_rates SET rate = 0.92 WHERE currency = 'EUR'`);

    const expectedEur = Math.round(Number(row.seller_net_cents) * 0.92);
    expect(expectedEur).toBe(92_00); // the seller gets their EUR price exactly: one conversion only
    expect(await sellerAvailable(h.ctx.db, seller.id, 'EUR')).toBe(expectedEur);
    expect(await sellerAvailable(h.ctx.db, seller.id, 'USD')).toBe(0);
    const dash = (await seller.api.get('/v1/seller/dashboard')).body;
    expect(dash.balances).toMatchObject({ currency: 'EUR', availableCents: expectedEur, withdrawableCents: expectedEur });
    expect(dash.allBalances).toEqual([{ currency: 'EUR', cents: expectedEur }]);

    // Round 22b: withdrawals are USD only; the EUR balance stays for Finance to convert by a manual ledger adjustment.
    const w = await seller.api.post('/v1/seller/withdrawals', { amountCents: expectedEur, currency: 'EUR' });
    expect(w.status).toBe(400);
    expect(w.body.error.code).toBe('unsupported_currency');
    expect(await sellerAvailable(h.ctx.db, seller.id, 'EUR')).toBe(expectedEur);

    // Treasury sees the EUR owed to the seller; every currency's PSP balance check stays exact.
    const admin = await makeUser(h, { role: 'admin' });
    const pos = (await admin.api.get('/v1/admin/fx/position')).body.positions;
    const eur = pos.find((p: any) => p.currency === 'EUR');
    // The EUR owed to the seller hasn't been bought yet: that's the shortfall to convert.
    expect(eur).toMatchObject({ positionCents: -expectedEur, sellerBalancesCents: expectedEur, shortfallCents: expectedEur });
    // Nothing is converted automatically (Round 22b): the USD captured stays at the PSP until Finance adjusts the balance.
    const mock = h.ctx.payments as MockPaymentProvider;
    mock.balanceOverride = { USD: Number(row.amount_cents), EUR: 0 };
    expect((await runReconciliation(h.ctx)).report.issues).toEqual([]);
    // EUR at the PSP that the books don't know about is caught.
    mock.balanceOverride = { USD: Number(row.amount_cents), EUR: 5_00 };
    const bad = await runReconciliation(h.ctx);
    mock.balanceOverride = null;
    expect(bad.report.issues).toEqual([{ check: 'psp_balance_mismatch', detail: { currency: 'EUR', expected: 0, actual: 5_00, difference: 5_00 } }]);
  });

  it('debits an unprotected EUR seller in EUR on a chargeback and restores it exactly when won', async () => {
    const seller = await eurSeller();
    const buyer = await makeUser(h, { tier: 1 });
    const admin = await makeUser(h, { role: 'admin' });
    // Account listing without owner proof: the seller's balance is on the hook for chargebacks.
    const offer = await makeOffer(seller, { priceCents: 46_00, currency: 'EUR', categorySlug: 'accounts', deliveryMode: 'manual', stock: 1 } as any);
    const order = await buyAndPay(h, buyer, offer.id);
    await seller.api.post(`/v1/orders/${order.id}/deliver`, { payload: 'creds' });
    await endWindowAndRelease(h, order.id);
    const row = (await h.ctx.db.query('SELECT * FROM orders WHERE id = $1', [order.id])).rows[0];
    expect(row.status).toBe('completed');
    const credited = await sellerAvailable(h.ctx.db, seller.id, 'EUR');
    expect(credited).toBe(Math.round(Number(row.seller_net_cents) * 0.92));

    // Full chargeback: the seller's whole EUR balance (worth net USD) goes, the reserve covers the rest.
    const cb = await admin.api.post('/v1/admin/chargebacks', { orderId: order.id, network: 'visa', reasonCode: '13.1', amountCents: Number(row.amount_cents), disputeRef: 'dp_eur_1' });
    expect(cb.status).toBe(201);
    const { rows: [c] } = await h.ctx.db.query('SELECT evidence FROM chargebacks WHERE id = $1', [cb.body.id]);
    expect(c.evidence.allocation.seller_available).toBe(Math.floor(credited / 0.92));
    expect(await sellerAvailable(h.ctx.db, seller.id, 'EUR')).toBe(credited - Math.round(c.evidence.allocation.seller_available * 0.92));
    expect(await sellerAvailable(h.ctx.db, seller.id, 'EUR')).toBeGreaterThanOrEqual(0);
    expect((await runReconciliation(h.ctx)).report.issues).toEqual([]);

    // Won: the exact EUR amount comes back.
    const mock = h.ctx.payments as MockPaymentProvider;
    const body = JSON.stringify({ type: 'chargeback.closed', disputeRef: 'dp_eur_1', won: true });
    expect((await client(h.app).post('/v1/payments/webhook/mock', body, { 'content-type': 'application/json', 'x-mock-signature': mock.sign(body) })).status).toBe(200);
    expect(await sellerAvailable(h.ctx.db, seller.id, 'EUR')).toBe(credited);
    expect((await runReconciliation(h.ctx)).report.issues).toEqual([]);
  });
});
