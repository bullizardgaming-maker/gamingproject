import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buyAndPay, client, makeOffer, makeUser, setup, type Harness } from './helpers.js';
import { REQUIREMENTS, checkLevel, levelFor, refreshTrustLevels } from '../src/domain/trust.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

const m = (over: Partial<Parameters<typeof levelFor>[0]> = {}) => ({ completed: 0, ageDays: 0, onTimePct: null, disputePct: null, chargebackPct: null, ...over });

describe('seller trust levels', () => {
  it('needs every requirement of a level, and of the ones below', () => {
    expect(levelFor(m())).toBe('new');
    expect(levelFor(m({ completed: 12, ageDays: 40 }))).toBe('rising');
    expect(levelFor(m({ completed: 150, ageDays: 200, onTimePct: 95, disputePct: 1 }))).toBe('trusted');
    expect(levelFor(m({ completed: 150, ageDays: 200, onTimePct: 90 }))).toBe('rising'); // late too often for trusted
    expect(levelFor(m({ completed: 2_000, ageDays: 500, disputePct: 6 }))).toBe('new'); // disputes too high for any level
    expect(levelFor(m({ completed: 2_000, ageDays: 500, onTimePct: 99, disputePct: 0.5, chargebackPct: 0.1 }))).toBe('top');
    expect(checkLevel(m({ completed: 50, ageDays: 10 }), REQUIREMENTS.rising)).toMatchObject({ completed: true, ageDays: false });
  });

  it('caches levels for badges and reports progress to the seller', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 5 });
    // A track record: 12 completed orders, an account 60 days old.
    await h.ctx.db.query(`UPDATE users SET created_at = now() - interval '60 days' WHERE id = $1`, [seller.id]);
    const buyer = await makeUser(h);
    const first = await buyAndPay(h, buyer, offer.id);
    await h.ctx.db.query(`UPDATE orders SET status = 'completed', completed_at = now() WHERE id = $1`, [first.id]);
    for (let i = 0; i < 11; i++) {
      await h.ctx.db.query(
        `INSERT INTO orders SELECT (jsonb_populate_record(NULL::orders, to_jsonb(o) || jsonb_build_object('id', gen_random_uuid(), 'idempotency_key', NULL, 'payment_ref', NULL, 'ref', 'order#' || upper(substr(md5(random()::text), 1, 7))))).* FROM orders o WHERE o.id = $1`,
        [first.id],
      );
    }
    expect((await client(h.app).get(`/v1/offers/${offer.id}`)).body.seller_trust_level).toBe('new');
    await refreshTrustLevels(h.ctx);
    expect((await client(h.app).get(`/v1/offers/${offer.id}`)).body.seller_trust_level).toBe('rising');
    expect((await client(h.app).get(`/v1/sellers/${seller.id}`)).body.trust_level).toBe('rising');

    const mine = (await seller.api.get('/v1/seller/trust')).body;
    expect(mine).toMatchObject({ level: 'rising', metrics: { completed: 12 }, next: { level: 'trusted', met: { completed: false, ageDays: false, disputePct: true } } });
  });
});
