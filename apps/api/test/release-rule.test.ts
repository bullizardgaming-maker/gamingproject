import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runJobsOnce } from '../src/worker.js';
import { buyAndPay, makeOffer, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

describe('release rule: held until the buyer confirms', () => {
  it('standard orders have no auto-release; the buyer confirms, or staff release 24h+ after delivery', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 5, categorySlug: 'currency', title: 'Gold 10k', priceCents: 10_00 });
    const order = await buyAndPay(h, buyer, offer.id);
    expect((await buyer.api.get(`/v1/orders/${order.id}`)).body.protection).toBe('until_confirmed');
    await seller.api.post(`/v1/orders/${order.id}/deliver`, { payload: 'sent in game' });
    let d = (await buyer.api.get(`/v1/orders/${order.id}`)).body;
    expect(d.status).toBe('delivered');
    expect(d.protection_ends_at).toBeNull();

    // The worker never releases it on its own.
    await h.ctx.db.query(`UPDATE orders SET delivered_at = now() - interval '10 days' WHERE id = $1`, [order.id]);
    await runJobsOnce(h.ctx);
    expect((await buyer.api.get(`/v1/orders/${order.id}`)).body.status).toBe('delivered');

    // Too early for staff while it is under 24h; the seller can't ask for a release yet either.
    await h.ctx.db.query(`UPDATE orders SET delivered_at = now() - interval '2 hours' WHERE id = $1`, [order.id]);
    const support = await makeUser(h, { tier: 2, role: 'support' });
    expect((await support.api.post(`/v1/admin/orders/${order.id}/release`, { note: 'proof looks fine' })).body.error.code).toBe('too_early');
    expect((await seller.api.post(`/v1/orders/${order.id}/follow-up`, {})).body.error.code).toBe('too_early');
    expect((await support.api.get('/v1/admin/orders/unconfirmed')).body.map((o: any) => o.id)).not.toContain(order.id);

    // 24h later: the seller files a follow-up (a support ticket), staff see it in the queue and release.
    await h.ctx.db.query(`UPDATE orders SET delivered_at = now() - interval '25 hours' WHERE id = $1`, [order.id]);
    const fu = await seller.api.post(`/v1/orders/${order.id}/follow-up`, { message: 'Screenshot of the trade is in the chat.' });
    expect(fu.status, JSON.stringify(fu.body)).toBe(201);
    expect((await seller.api.post(`/v1/orders/${order.id}/follow-up`, {})).body.error.code).toBe('already_open');
    const ticket = (await seller.api.get(`/v1/support/tickets/${fu.body.ticketId}`)).body;
    expect(ticket.subject).toMatch(/^Release request: Gold 10k/);
    expect(ticket.priority).toBe('high');
    const queue = (await support.api.get('/v1/admin/orders/unconfirmed')).body;
    expect(queue.find((o: any) => o.id === order.id)).toMatchObject({ open_tickets: 1, seller_name: expect.any(String) });
    // A buyer-side user can't do it.
    expect((await buyer.api.post(`/v1/admin/orders/${order.id}/release`, { note: 'x' })).status).toBe(403);
    const rel = await support.api.post(`/v1/admin/orders/${order.id}/release`, { note: 'Trade screenshot matches the listing' });
    expect(rel.status, JSON.stringify(rel.body)).toBe(200);
    d = (await buyer.api.get(`/v1/orders/${order.id}`)).body;
    expect(d.status).toBe('completed');
    expect(d.events.at(-1).reason).toBe('staff_released');
    expect((await support.api.post(`/v1/admin/orders/${order.id}/release`, { note: 'again' })).body.error.code).toBe('invalid_state');
  });

  it('the buyer confirming releases at once; accounts never auto-release — after 14 days staff may', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const item = await makeOffer(seller, { deliveryMode: 'manual', stock: 5, categorySlug: 'items', title: 'Rare sword', priceCents: 5_00 });
    const o1 = await buyAndPay(h, buyer, item.id);
    await seller.api.post(`/v1/orders/${o1.id}/deliver`, { payload: 'traded' });
    expect((await buyer.api.post(`/v1/orders/${o1.id}/confirm`, {})).status).toBe(200);
    expect((await buyer.api.get(`/v1/orders/${o1.id}`)).body.status).toBe('completed');

    const acct = await makeOffer(seller, { deliveryMode: 'manual', categorySlug: 'accounts', title: 'Old account', priceCents: 50_00 });
    const o2 = await buyAndPay(h, buyer, acct.id);
    await seller.api.post(`/v1/orders/${o2.id}/deliver`, { payload: 'login:pass' });
    const d = (await buyer.api.get(`/v1/orders/${o2.id}`)).body;
    expect(d.protection).toBe('insurance_14d');
    expect(new Date(d.protection_ends_at).getTime()).toBeGreaterThan(Date.now() + 13 * 86_400_000);
    const support = await makeUser(h, { role: 'support' });
    await h.ctx.db.query(`UPDATE orders SET delivered_at = now() - interval '2 days' WHERE id = $1`, [o2.id]);
    // Before the window ends, an unfinished changeover blocks a staff release.
    expect((await support.api.post(`/v1/admin/orders/${o2.id}/release`, { note: 'Looks delivered' })).body.error.code).toBe('checklist_incomplete');
    await h.ctx.db.query(`UPDATE orders SET protection_ends_at = now() - interval '1 minute' WHERE id = $1`, [o2.id]);
    await runJobsOnce(h.ctx);
    await runJobsOnce(h.ctx);
    const after = (await buyer.api.get(`/v1/orders/${o2.id}`)).body;
    expect(after.status).toBe('delivered'); // nothing moves on its own
    expect(after.events.filter((e: any) => e.reason === 'protection_window_elapsed')).toHaveLength(1); // told once
    expect((await buyer.api.get(`/v1/chat/rooms/${after.room_id}/messages`)).body.filter((m: any) => m.code === 'protection_ended')).toHaveLength(1);
    // Now a person releases it.
    const rel = await support.api.post(`/v1/admin/orders/${o2.id}/release`, { note: 'Window over, buyer silent, proof checked' });
    expect(rel.status, JSON.stringify(rel.body)).toBe(200);
    expect((await buyer.api.get(`/v1/orders/${o2.id}`)).body.status).toBe('completed');
  });
});
