import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runReconciliation } from '../src/domain/reconciliation.js';
import { MockPaymentProvider } from '../src/providers/payments/mock.js';
import { buyAndPay, makeOffer, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup({ PLATFORM_TAX_COUNTRY: 'IE' }); // VAT path kept under test (CFO B3: unset in production)
});
afterAll(async () => h.close());

describe('platform earnings withdrawals', () => {
  it('needs a second admin, only spends treasury money, and keeps the PSP balance check exact', async () => {
    const a1 = await makeUser(h, { tier: 2, role: 'admin' });
    const a2 = await makeUser(h, { tier: 2, role: 'admin' });
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller, { priceCents: 100_00 });
    await seller.api.post(`/v1/offers/${offer.id}/inventory`, { format: 'txt', content: 'T1' });
    const order = await buyAndPay(h, buyer, offer.id);
    await buyer.api.post(`/v1/orders/${order.id}/confirm`);

    const bal = (await a1.api.get('/v1/admin/treasury')).body.balance;
    // 100.00 grossed up by 5% = 105.27: the 5.27 commission minus the 10% reserve share (rounded down) and the VAT inside it (IE 23%: 5.27 * 23/123 = 0.99).
    expect(bal.treasuryCents).toBe(5_27 - 52 - 99);
    expect((await a1.api.post('/v1/admin/treasury/withdrawals', { amountCents: bal.treasuryCents + 1, note: 'too much' })).status).toBe(400);

    const w = (await a1.api.post('/v1/admin/treasury/withdrawals', { amountCents: 3_00, note: 'October revenue' })).body;
    expect(w.status).toBe('pending_approval');
    expect((await a1.api.post(`/v1/admin/treasury/withdrawals/${w.id}/decide`, { approve: true })).body.error.code).toBe('four_eyes');
    const paid = (await a2.api.post(`/v1/admin/treasury/withdrawals/${w.id}/decide`, { approve: true })).body;
    expect(paid.status).toBe('paid');
    expect(paid.provider_ref).toMatch(/^mock_po_/);
    expect((await a2.api.post(`/v1/admin/treasury/withdrawals/${w.id}/decide`, { approve: true })).body.error.code).toBe('already_decided');
    expect((await a1.api.get('/v1/admin/treasury')).body.balance.treasuryCents).toBe(5_27 - 52 - 99 - 3_00);

    // PSP now holds: 105.27 captured - 3.00 paid to the company bank (the seller hasn't withdrawn).
    const mock = h.ctx.payments as MockPaymentProvider;
    mock.balanceOverride = 102_27;
    expect((await runReconciliation(h.ctx)).status).toBe('ok');
    mock.balanceOverride = null;

    const log = (await a1.api.get('/v1/admin/audit?targetType=treasury_withdrawal')).body.map((e: any) => e.action);
    expect(log).toEqual(expect.arrayContaining(['treasury.withdrawal_requested', 'treasury.withdrawal_approved']));
  });
});
