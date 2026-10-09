import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runJobsOnce } from '../src/worker.js';
import { buyAndPay, makeOffer, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

async function completedOrder(seller: any, buyer: any) {
  const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 1, categorySlug: 'currency', title: 'Gold pack' });
  const order = await buyAndPay(h, buyer, offer.id);
  await seller.api.post(`/v1/orders/${order.id}/deliver`, { payload: 'sent' });
  return order;
}

describe('buyer reputation', () => {
  it('sellers rate buyers once per completed order and see the summary on the order', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const order = await completedOrder(seller, buyer);

    // Not before completion, and only the seller.
    expect((await seller.api.post(`/v1/orders/${order.id}/buyer-rating`, { positive: true })).body.error.code).toBe('not_rateable');
    await buyer.api.post(`/v1/orders/${order.id}/confirm`, {});
    expect((await buyer.api.post(`/v1/orders/${order.id}/buyer-rating`, { positive: true })).body.error.code).toBe('not_seller');
    // Tags must match the verdict.
    expect((await seller.api.post(`/v1/orders/${order.id}/buyer-rating`, { positive: true, tags: ['rude'] })).body.error.code).toBe('tags_mismatch');
    const ok = await seller.api.post(`/v1/orders/${order.id}/buyer-rating`, { positive: true, tags: ['clear_communication', 'quick_confirmation'] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect((await seller.api.post(`/v1/orders/${order.id}/buyer-rating`, { positive: false })).body.error.code).toBe('already_rated');

    const asSeller = (await seller.api.get(`/v1/orders/${order.id}`)).body;
    expect(asSeller.buyer_rating).toMatchObject({ positive: true });
    expect(asSeller.buyer_reputation).toMatchObject({ level: 'new', completedOrders: 1, positive: 1, negative: 0, disputesLost: 0, chargebacks: 0 });
    expect(asSeller.buyer_reputation.topTags.map((t: any) => t.tag).sort()).toEqual(['clear_communication', 'quick_confirmation']);
    // The buyer doesn't see it on the order, but sees their own summary.
    expect((await buyer.api.get(`/v1/orders/${order.id}`)).body.buyer_reputation).toBeNull();
    expect((await buyer.api.get('/v1/me/buyer-reputation')).body).toMatchObject({ positive: 1, completedOrders: 1 });
  });

  it('counts disputes the buyer opened and lost, and flags caution', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const arbiter = await makeUser(h, { tier: 2, role: 'admin' });
    for (let i = 0; i < 2; i++) {
      const order = await completedOrder(seller, buyer);
      await buyer.api.post(`/v1/orders/${order.id}/dispute`, { reason: 'Never received the gold at all', category: 'not_delivered' });
      const disputeId = (await arbiter.api.get(`/v1/orders/${order.id}`)).body.dispute.id;
      const res = await arbiter.api.post(`/v1/admin/disputes/${disputeId}/resolve`, { outcome: 'seller', note: 'Trade log shows delivery' });
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    }
    await runJobsOnce(h.ctx);
    const rep = (await buyer.api.get('/v1/me/buyer-reputation')).body;
    expect(rep).toMatchObject({ disputesOpened: 2, disputesLost: 2, level: 'caution' });
  });

  it('closes ratings 30 days after completion', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const order = await completedOrder(seller, buyer);
    await buyer.api.post(`/v1/orders/${order.id}/confirm`, {});
    await h.ctx.db.query(`UPDATE orders SET completed_at = now() - interval '31 days' WHERE id = $1`, [order.id]);
    expect((await seller.api.post(`/v1/orders/${order.id}/buyer-rating`, { positive: false, tags: ['rude'] })).body.error.code).toBe('rating_closed');
  });
});
