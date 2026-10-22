import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatchEmails } from '../src/domain/notifications.js';
import { sellerAvailable } from '../src/domain/ledger.js';
import { runJobsOnce } from '../src/worker.js';
import { buyAndPay, client, makeOffer, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

const emailsTo = async (email: string) => {
  await dispatchEmails(h.ctx);
  return (h.messenger.outbox as any[]).filter((m) => m.channel === 'email' && m.to === email).map((m) => m.subject);
};

describe('holiday mode', () => {
  it('hides a paused shop from the market and blocks new orders until it resumes', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller, { title: 'Holiday shop item', categorySlug: 'boosting', deliveryMode: 'manual', stock: 3 });
    const res = await seller.api.put('/v1/seller/shop-status', { paused: true, message: 'Back on Monday' });
    expect(res.body).toMatchObject({ paused: true, message: 'Back on Monday', ordersStillToDeliver: 0 });

    const found = (await client(h.app).get('/v1/offers?q=holiday')).body.items;
    expect(found).toHaveLength(0);
    expect((await client(h.app).get(`/v1/offers/${offer.id}`)).body).toMatchObject({ shop_paused: true, shop_pause_message: 'Back on Monday' });
    const blocked = await buyer.api.post('/v1/orders', { offerId: offer.id, acceptTos: true });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatchObject({ code: 'shop_paused', message: 'Back on Monday' });

    // A pause with an end date lifts itself.
    await seller.api.put('/v1/seller/shop-status', { paused: true, until: new Date(Date.now() + 3_600_000).toISOString() });
    await h.ctx.db.query(`UPDATE users SET shop_paused_until = now() - interval '1 second' WHERE id = $1`, [seller.id]);
    expect((await client(h.app).get('/v1/offers?q=holiday')).body.items).toHaveLength(1);
    expect((await buyer.api.post('/v1/orders', { offerId: offer.id, acceptTos: true })).status).toBe(201);
  });
});

describe('promised delivery times', () => {
  async function paidManualOrder(hours = 2) {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller, { title: 'Late boost', categorySlug: 'boosting', deliveryMode: 'manual', stock: 5, priceCents: 30_00, deliveryHours: hours } as any);
    const order = await buyAndPay(h, buyer, offer.id);
    return { seller, buyer, order };
  }

  it('sets a deadline, warns both sides when it passes, and lets the buyer cancel for a full refund', async () => {
    const { seller, buyer, order } = await paidManualOrder(2);
    const o = (await buyer.api.get(`/v1/orders/${order.id}`)).body;
    const hours = (new Date(o.delivery_due_at).getTime() - new Date(o.paid_at).getTime()) / 3_600_000;
    expect(hours).toBeCloseTo(2, 3);

    expect((await buyer.api.post(`/v1/orders/${order.id}/cancel-late`)).body.error.code).toBe('not_late');
    await h.ctx.db.query(`UPDATE orders SET delivery_due_at = now() - interval '1 minute' WHERE id = $1`, [order.id]);
    await runJobsOnce(h.ctx);
    expect(await emailsTo(buyer.email)).toContain('Your order is late: Late boost');
    expect(await emailsTo(seller.email)).toContain('Overdue: deliver Late boost now');
    await runJobsOnce(h.ctx); // no duplicate warnings
    expect((await emailsTo(buyer.email)).filter((s) => s.startsWith('Your order is late'))).toHaveLength(1);

    expect((await seller.api.post(`/v1/orders/${order.id}/cancel-late`)).status).toBe(403);
    expect((await buyer.api.post(`/v1/orders/${order.id}/cancel-late`)).body).toEqual({ refunded: true });
    expect((await buyer.api.get(`/v1/orders/${order.id}`)).body.status).toBe('refunded');
    expect(await sellerAvailable(h.ctx.db, seller.id)).toBe(0);
  });

  it('refunds automatically if still undelivered after the grace period, and tracks on-time rate', async () => {
    const { seller, buyer, order } = await paidManualOrder(4);
    await h.ctx.db.query(`UPDATE orders SET delivery_due_at = now() - interval '49 hours' WHERE id = $1`, [order.id]);
    await runJobsOnce(h.ctx);
    const o = (await buyer.api.get(`/v1/orders/${order.id}`)).body;
    expect(o.status).toBe('refunded');
    expect(o.events.at(-1).reason).toBe('late_delivery_auto_refund');
    expect((await client(h.app).get(`/v1/sellers/${seller.id}`)).body.on_time_delivery_pct).toBe(0);
  });

  it('counts on-time deliveries', async () => {
    const { seller, order } = await paidManualOrder(4);
    await seller.api.post(`/v1/orders/${order.id}/deliver`, { payload: 'done' });
    // Delivered two hours ago, deadline passed a minute ago: on time.
    await h.ctx.db.query(`UPDATE orders SET delivered_at = now() - interval '2 hours', delivery_due_at = now() - interval '1 minute' WHERE id = $1`, [order.id]);
    expect((await client(h.app).get(`/v1/sellers/${seller.id}`)).body.on_time_delivery_pct).toBe(100);
  });
});
