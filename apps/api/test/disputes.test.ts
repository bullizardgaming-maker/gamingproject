import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buyAndPay, makeOffer, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

describe('dispute evidence', () => {
  it('collects statements from both sides and builds the arbiter’s case file', async () => {
    const seller = await makeUser(h, { tier: 2, name: 'Case Seller' });
    const buyer = await makeUser(h, { name: 'Case Buyer' });
    const stranger = await makeUser(h);
    const arbiter = await makeUser(h, { tier: 2, role: 'arbiter' });
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 2, title: 'Rare item' });
    const order = await buyAndPay(h, buyer, offer.id);
    const room = (await buyer.api.get(`/v1/orders/${order.id}`)).body.room_id;
    await buyer.api.post(`/v1/chat/rooms/${room}/messages`, { body: 'When will it arrive?' });
    await seller.api.post(`/v1/orders/${order.id}/deliver`, { payload: 'traded in game' });

    const d = await buyer.api.post(`/v1/orders/${order.id}/dispute`, { reason: 'The item I received is a different one', category: 'not_as_described' });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(d.body.category).toBe('not_as_described');

    expect((await stranger.api.post(`/v1/orders/${order.id}/dispute/statements`, { body: 'I want in on this one' })).status).toBe(403);
    const s = await seller.api.post(`/v1/orders/${order.id}/dispute/statements`, { body: 'I traded exactly the listed item; screenshot in chat.' });
    expect(s.status).toBe(201);
    expect(s.body.map((x: any) => x.role)).toEqual(['buyer', 'seller']);
    const view = (await buyer.api.get(`/v1/orders/${order.id}`)).body;
    expect(view.dispute.statements).toHaveLength(2);

    expect((await buyer.api.get(`/v1/admin/disputes/${d.body.id}/case`)).status).toBe(403);
    const file = (await arbiter.api.get(`/v1/admin/disputes/${d.body.id}/case`)).body;
    expect(file.dispute).toMatchObject({ category: 'not_as_described', opened_by: 'buyer' });
    expect(file.buyer).toMatchObject({ display_name: 'Case Buyer', disputes_opened: 1 });
    expect(file.seller).toMatchObject({ display_name: 'Case Seller', disputes_against_as_seller: 1 });
    expect(file.snapshot.offer.title).toBe('Rare item');
    expect(file.facts).toMatchObject({ chatChainIntact: true, listingChangedSincePurchase: false, sellerRepliedAfterDispute: false });
    const types = file.timeline.map((t: any) => t.type);
    expect(types).toEqual(expect.arrayContaining(['status', 'message', 'statement']));
    const times = file.timeline.map((t: any) => new Date(t.at).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(file.timeline.find((t: any) => t.text === 'When will it arrive?').who).toBe('buyer');
    expect((await h.ctx.db.query(`SELECT 1 FROM admin_audit_log WHERE action = 'dispute.case_viewed' AND target_id = $1`, [d.body.id])).rowCount).toBe(1);

    // After the decision no more statements.
    await arbiter.api.post(`/v1/admin/disputes/${d.body.id}/resolve`, { outcome: 'seller', note: 'Chat shows the listed item was traded' });
    expect((await buyer.api.post(`/v1/orders/${order.id}/dispute/statements`, { body: 'But it was not the right one!' })).status).toBe(409);
  });
});
