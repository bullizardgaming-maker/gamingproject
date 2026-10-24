import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planTopUps } from '../src/domain/fxtopups.js';
import { runReconciliation } from '../src/domain/reconciliation.js';
import { MockFxExchange, WiseFxExchange } from '../src/providers/fxexchange.js';
import { buyAndPay, makeOffer, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup({ FX_STATIC_RATES: '{"EUR":0.92,"EGP":48.5}', FX_EXCHANGE_PROVIDER: 'mock', FX_TOPUP_MIN_CENTS: '100', PAYOUT_CURRENCIES: 'USD,EUR' });
});
afterAll(async () => h.close());

const exchange = () => h.ctx.fxExchange as MockFxExchange;
const eurPosition = async (admin: { api: any }) => (await admin.api.get('/v1/admin/fx/position')).body.positions.find((p: any) => p.currency === 'EUR');

/** A completed sale credited to a EUR seller: sellers are now owed EUR the platform hasn't bought. */
async function eurSale(priceEurCents = 46_00) {
  const seller = await makeUser(h, { tier: 2 });
  await seller.api.put('/v1/seller/tax-profile', { country: 'US', isBusiness: false });
  await seller.api.put('/v1/seller/payout-currency', { currency: 'EUR' });
  const buyer = await makeUser(h, { tier: 1 });
  const offer = await makeOffer(seller, { priceCents: priceEurCents, currency: 'EUR', categorySlug: 'boosting', deliveryMode: 'manual', stock: 1 } as any);
  const order = await buyAndPay(h, buyer, offer.id);
  await seller.api.post(`/v1/orders/${order.id}/deliver`, { payload: 'done' });
  await buyer.api.post(`/v1/orders/${order.id}/confirm`);
}

describe('automated FX top-ups', () => {
  it('proposes buying the shortfall plus a buffer, and executes on a second person’s approval', async () => {
    const a = await makeUser(h, { role: 'finance' });
    const b = await makeUser(h, { role: 'finance' });
    await eurSale();
    const short = (await eurPosition(a)).shortfallCents;
    expect(short).toBeGreaterThan(0);

    const support = await makeUser(h, { role: 'support' });
    expect((await support.api.post('/v1/admin/fx/topups/plan')).status).toBe(403);
    const plan = await a.api.post('/v1/admin/fx/topups/plan');
    expect(plan.body).toHaveLength(1);
    const t = plan.body[0];
    expect(t).toMatchObject({ from_currency: 'USD', to_currency: 'EUR', status: 'proposed', requested_by: a.id });
    expect(Number(t.to_cents)).toBe(Math.ceil((short * 1.05) / 100) * 100);
    expect((await b.api.get('/v1/me/notifications')).body.items.map((i: any) => i.template)).toContain('fx_topup_proposed');

    expect((await a.api.post(`/v1/admin/fx/topups/${t.id}/decide`, { approve: true })).body.error.code).toBe('four_eyes');
    const done = (await b.api.post(`/v1/admin/fx/topups/${t.id}/decide`, { approve: true })).body;
    expect(done).toMatchObject({ status: 'completed', provider: 'mock', decided_by: b.id });
    expect(Number(done.from_cents)).toBe(Math.ceil(Number(t.to_cents) / (0.92 * (1 - 0.005))));
    const conv = (await h.ctx.db.query('SELECT * FROM fx_conversions WHERE id = $1', [done.conversion_id])).rows[0];
    expect(conv).toMatchObject({ from_currency: 'USD', to_currency: 'EUR', recorded_by: b.id });
    expect(conv.reference).toBe(`mock:${done.provider_ref}`);

    // Covered now (with the buffer to spare): nothing more to buy, and the books still balance.
    expect((await eurPosition(a)).shortfallCents).toBe(0);
    expect((await a.api.post('/v1/admin/fx/topups/plan')).body).toEqual([]);
    expect((await b.api.post(`/v1/admin/fx/topups/${t.id}/decide`, { approve: true })).body.error.code).toBe('already_decided');
    expect((await runReconciliation(h.ctx)).report.issues).toEqual([]);
  });

  it('runs small top-ups on its own, supersedes stale proposals, and records failures', async () => {
    const finance = await makeUser(h, { role: 'finance' });
    const other = await makeUser(h, { role: 'finance' });

    // A growing shortfall replaces the undecided smaller proposal.
    await eurSale(200_00);
    const first = (await planTopUps(h.ctx))[0];
    expect(first).toMatchObject({ status: 'proposed', requested_by: null });
    await eurSale(200_00);
    const second = (await planTopUps(h.ctx))[0];
    expect(Number(second.to_cents)).toBeGreaterThan(Number(first.to_cents));
    expect((await h.ctx.db.query('SELECT status FROM fx_topups WHERE id = $1', [first.id])).rows[0].status).toBe('superseded');

    // The exchange refuses: the top-up is marked failed with the reason; the next plan tries again.
    exchange().fail = 'insufficient USD balance';
    const failed = (await finance.api.post(`/v1/admin/fx/topups/${second.id}/decide`, { approve: true })).body;
    expect(failed).toMatchObject({ status: 'failed', error: 'insufficient USD balance' });
    exchange().fail = null;

    // Under the auto-approve limit it executes immediately, with no person on it.
    h.ctx.cfg.FX_TOPUP_AUTO_APPROVE_CENTS = 1_000_000;
    try {
      const auto = (await planTopUps(h.ctx))[0];
      expect(auto).toMatchObject({ status: 'completed', decided_by: null, requested_by: null });
      expect((await h.ctx.db.query('SELECT recorded_by FROM fx_conversions WHERE id = $1', [auto.conversion_id])).rows[0].recorded_by).toBeNull();
    } finally {
      h.ctx.cfg.FX_TOPUP_AUTO_APPROVE_CENTS = 0;
    }

    // Rejecting closes a proposal without converting anything.
    await eurSale(300_00);
    const rejectMe = (await planTopUps(h.ctx))[0];
    expect((await other.api.post(`/v1/admin/fx/topups/${rejectMe.id}/decide`, { approve: false })).body).toMatchObject({ status: 'rejected', conversion_id: null });
    const list = (await finance.api.get('/v1/admin/fx/topups')).body;
    expect(list).toMatchObject({ provider: 'mock', autoApproveCents: 0 });
    expect(list.topups.map((t: any) => t.status)).toEqual(expect.arrayContaining(['completed', 'failed', 'rejected', 'superseded']));
    expect((await runReconciliation(h.ctx)).report.issues).toEqual([]);
  });
});

describe('Wise exchange adapter', () => {
  it('quotes the exact target amount, converts with an idempotency key, and reports what moved', async () => {
    const calls: Array<{ url: string; body: any; headers: any }> = [];
    const http = (async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
      const body = url.endsWith('/quotes')
        ? { id: 'q-1', rate: 0.9154, sourceAmount: 1092.42, targetAmount: 1000 }
        : { id: 77, state: 'COMPLETED', sourceAmount: { value: 1092.42, currency: 'USD' }, targetAmount: { value: 1000, currency: 'EUR' }, rate: 0.9154 };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const wise = new WiseFxExchange({ baseUrl: 'https://wise.test', token: 'tok', profileId: '123' }, http);
    const r = await wise.buy({ from: 'USD', to: 'EUR', toCents: 1000_00, idempotencyKey: 'topup-1' });
    expect(r).toEqual({ ref: '77', fromCents: 1092_42, toCents: 1000_00, rate: 0.9154 });
    expect(calls[0]).toMatchObject({ url: 'https://wise.test/v3/profiles/123/quotes', body: { sourceCurrency: 'USD', targetCurrency: 'EUR', targetAmount: 1000, payOut: 'BALANCE' } });
    expect(calls[0]!.headers.Authorization).toBe('Bearer tok');
    expect(calls[1]).toMatchObject({ url: 'https://wise.test/v2/profiles/123/balance-movements', body: { quoteId: 'q-1' } });
    expect(calls[1]!.headers['X-idempotence-uuid']).toBe('topup-1');

    const failing = new WiseFxExchange({ baseUrl: 'https://wise.test', token: 'tok', profileId: '123' }, (async () => new Response('{"errors":[{"code":"balance.insufficient"}]}', { status: 422 })) as any);
    await expect(failing.buy({ from: 'USD', to: 'EUR', toCents: 100, idempotencyKey: 'k' })).rejects.toThrow(/422/);
  });
});
