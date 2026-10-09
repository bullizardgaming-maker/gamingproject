import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { retentionMetrics } from '../src/domain/cohorts.js';
import { buyAndPay, makeOffer, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

// Orders are back-dated into 2030 so other tests' orders (paid now) fall outside the window.
const at = (iso: string) => new Date(`${iso}T12:00:00Z`);

describe('retention dashboard', () => {
  it('builds buyer and seller cohorts, returning buyers, seller churn and the 90-day repeat rate', async () => {
    const s1 = await makeUser(h, { tier: 2 });
    const s2 = await makeUser(h, { tier: 2 });
    const [a, b, c] = [await makeUser(h, { tier: 1 }), await makeUser(h, { tier: 1 }), await makeUser(h, { tier: 1 })];
    const o1 = await makeOffer(s1, { deliveryMode: 'manual', stock: 20, categorySlug: 'currency', title: 'Gold one' });
    const o2 = await makeOffer(s2, { deliveryMode: 'manual', stock: 20, categorySlug: 'currency', title: 'Gold two' });
    const buy = async (who: any, offer: any, day: string) => {
      const o = await buyAndPay(h, who, offer.id);
      await h.ctx.db.query('UPDATE orders SET paid_at = $2, created_at = $2 WHERE id = $1', [o.id, at(day)]);
    };
    // January: A and B buy from seller 1; seller 2 sells to C.
    await buy(a, o1, '2030-01-05');
    await buy(b, o1, '2030-01-20');
    await buy(c, o2, '2030-01-25');
    // February: A comes back (within 90 days); only seller 1 sells, so seller 2 has churned.
    await buy(a, o1, '2030-02-10');
    // March: B comes back, 40 days after their first order.
    await buy(b, o1, '2030-03-01');

    const r = await retentionMetrics(h.ctx.db, 6, at('2030-06-15'));
    expect(r.buyerCohorts[0]).toEqual({ cohort: '2030-01', size: 3, retained: [3, 1, 1, 0, 0, 0] });
    expect(r.buyerCohorts[1]).toMatchObject({ cohort: '2030-02', size: 0 });
    expect(r.sellerCohorts[0]).toEqual({ cohort: '2030-01', size: 2, retained: [2, 1, 1, 0, 0, 0] });

    const feb = r.series.find((m) => m.month === '2030-02')!;
    expect(feb).toMatchObject({ active_buyers: 1, returning_buyers: 1, returning_pct: 100, active_sellers: 1, sellers_last_month: 2, churned_sellers: 1, seller_churn_pct: 50 });
    const jan = r.series.find((m) => m.month === '2030-01')!;
    expect(jan).toMatchObject({ active_buyers: 3, returning_buyers: 0, new_sellers: 2 });

    // A and B ordered again within 90 days of their first order; C didn't.
    expect(r.repeat[0]).toMatchObject({ cohort: '2030-01', buyers: 3, repeat_90d: 2, repeat_pct: 66.7, complete: true });
    expect(r.repeat90dPct).toBe(66.7);
  });

  it('is staff-only', async () => {
    const user = await makeUser(h, { tier: 1 });
    expect((await user.api.get('/v1/admin/analytics/retention')).status).toBe(403);
    const admin = await makeUser(h, { tier: 2, role: 'admin' });
    const res = await admin.api.get('/v1/admin/analytics/retention?months=6');
    expect(res.status).toBe(200);
    expect(res.body.buyerCohorts).toHaveLength(6);
  });
});
