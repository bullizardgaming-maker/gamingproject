import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatchEmails, render } from '../src/domain/notifications.js';
import { isoWeek, maybeSendRetentionDigest, retentionDigest, sendRetentionDigest } from '../src/domain/retentionDigest.js';
import { buyAndPay, makeOffer, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
const sent: Array<{ to: string; subject?: string; body: string }> = [];
beforeAll(async () => {
  h = await setup();
  const orig = h.messenger.send.bind(h.messenger);
  h.messenger.send = async (m: any) => {
    sent.push(m);
    return orig(m);
  };
});
afterAll(async () => h.close());

// Back-dated into 2031 so other tests' orders fall outside the windows.
const at = (iso: string) => new Date(`${iso}T12:00:00Z`);

describe('weekly retention digest', () => {
  it('labels ISO weeks', () => {
    expect(isoWeek(new Date('2026-10-05T00:00:00Z'))).toBe('2026-W41');
    expect(isoWeek(new Date('2027-01-01T00:00:00Z'))).toBe('2026-W53');
  });

  it('emails staff with analytics access once a week, with alerts when churn or repeat rates cross the line', async () => {
    const s1 = await makeUser(h, { tier: 2 });
    const s2 = await makeUser(h, { tier: 2 });
    const [a, b, c] = [await makeUser(h, { tier: 1 }), await makeUser(h, { tier: 1 }), await makeUser(h, { tier: 1 })];
    const o1 = await makeOffer(s1, { deliveryMode: 'manual', stock: 20, categorySlug: 'currency', title: 'Gold one' });
    const o2 = await makeOffer(s2, { deliveryMode: 'manual', stock: 20, categorySlug: 'currency', title: 'Gold two' });
    const buy = async (who: any, offer: any, day: string) => {
      const o = await buyAndPay(h, who, offer.id);
      await h.ctx.db.query('UPDATE orders SET paid_at = $2, created_at = $2 WHERE id = $1', [o.id, at(day)]);
    };
    // January: three first-time buyers, two sellers. February: only seller 1 sells (seller 2 churned: 50%).
    await buy(a, o1, '2031-01-05');
    await buy(b, o1, '2031-01-20');
    await buy(c, o2, '2031-01-25');
    await buy(a, o1, '2031-02-10');
    // The digest week (Mon 2031-03-10 covers Mar 3–9): A returns, B is a returning buyer too; the week before had one order.
    await buy(b, o1, '2031-02-26');
    await buy(a, o1, '2031-03-04');
    await buy(b, o1, '2031-03-07');

    const monday = at('2031-03-10');
    const d = await retentionDigest(h.ctx, monday);
    expect(d).toMatchObject({ week: '2031-W10', week_ending: '2031-03-09', orders: 2, active_buyers: 2, returning_buyers: 2, new_buyers: 0, prev_orders: 1, prev_active_buyers: 1, active_sellers: 1 });
    expect(d.active_buyers_delta_pct).toBe(100);
    expect(d.month).toBe('2031-02');
    expect(d.seller_churn_pct).toBe(50);
    // January's 90 days aren't over yet in March, so no repeat rate; churn 50% is above the 20% line.
    expect(d.repeat_90d_pct).toBeNull();
    expect(d.alerts).toHaveLength(1);
    expect(d.alerts[0]).toMatch(/Seller churn in 2031-02 was 50%/);
    // By June the January cohort is complete: A and B repeated, C didn't (66.7%), above the 25% line…
    const june = await retentionDigest(h.ctx, at('2031-06-16'));
    expect(june.repeat_90d_pct).toBe(66.7);
    expect(june.alerts.some((x) => /repeat rate/.test(x))).toBe(false);
    // …unless the line is set higher.
    const cfg = h.ctx.cfg as { COHORT_ALERT_REPEAT_PCT: number };
    const was = cfg.COHORT_ALERT_REPEAT_PCT;
    cfg.COHORT_ALERT_REPEAT_PCT = 80;
    expect((await retentionDigest(h.ctx, at('2031-06-16'))).alerts.some((x) => /repeat rate is 66.7%, below the 80% line/.test(x))).toBe(true);
    cfg.COHORT_ALERT_REPEAT_PCT = was;

    const admin = await makeUser(h, { tier: 2, role: 'admin' });
    const finance = await makeUser(h, { tier: 2, role: 'finance' });
    const support = await makeUser(h, { tier: 2, role: 'support' });
    const nobody = await makeUser(h, { tier: 1 });
    const first = await sendRetentionDigest(h.ctx, monday);
    expect(first.week).toBe('2031-W10');
    expect(first.queued).toBeGreaterThanOrEqual(2);
    // Same week again: nothing new is queued.
    expect((await sendRetentionDigest(h.ctx, at('2031-03-12'))).queued).toBe(0);

    await dispatchEmails(h.ctx);
    const to = (u: any) => sent.filter((m) => m.to === u.email && /Weekly retention/.test(m.subject ?? ''));
    expect(to(admin)).toHaveLength(1);
    expect(to(finance)).toHaveLength(1);
    expect(to(support)).toHaveLength(0);
    expect(to(nobody)).toHaveLength(0);
    const mail = to(admin)[0]!;
    expect(mail.subject).toBe('Alert: Weekly retention: 2 active buyers (+100% vs last week)');
    expect(mail.body).toContain('Seller churn in 2031-02 was 50%');
    expect(mail.body).toContain('Paid orders: 2 (1)');
    expect(mail.body).toContain('90-day repeat rate (completed cohorts): n/a');
    expect(mail.body).toContain('/admin');

    // The worker only runs it on Mondays.
    expect(await maybeSendRetentionDigest(h.ctx, at('2031-03-11'))).toBeNull();
  });

  it('renders without alerts and with empty data', () => {
    const r = render(h.ctx, 'retention_digest', {
      week_ending: '2031-03-09', orders: 0, prev_orders: 0, active_buyers: 0, prev_active_buyers: 0, returning_buyers: 0, prev_returning_buyers: 0, new_buyers: 0, prev_new_buyers: 0,
      active_sellers: 0, prev_active_sellers: 0, new_sellers: 0, prev_new_sellers: 0, active_buyers_delta_pct: null, month: '2031-02', seller_churn_pct: null, churned_sellers: null,
      sellers_last_month: null, returning_pct: null, month_active_buyers: 0, repeat_90d_pct: null, alerts: [],
    });
    expect(r.subject).toBe('Weekly retention: 0 active buyers (n/a vs last week)');
    expect(r.text).not.toContain('undefined');
    expect(r.text).not.toContain('ALERTS');
  });
});
