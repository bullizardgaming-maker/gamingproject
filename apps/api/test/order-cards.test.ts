import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buyAndPay, client, makeOffer, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

describe('order refs, official order messages and the safety panel', () => {
  it('gives every order a human ref and posts a server-only card on each status change', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller, { categorySlug: 'currency', game: 'Albion Online', title: '10M silver', deliveryMode: 'manual', stock: 5, attributes: { server: 'Europe' } } as any);
    const res = await buyer.api.post('/v1/orders', { offerId: offer.id, acceptTos: true, characterName: 'Pat_of_Caerleon' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const order = res.body.order;
    expect(order.ref).toMatch(/^order#[A-HJ-NP-Z2-9]{7}$/);
    await client(h.app).post(`/v1/payments/mock/checkout/${order.payment_ref}/pay`, {}, { accept: 'application/json' });
    const detail = (await buyer.api.get(`/v1/orders/${order.id}`)).body;
    expect(detail.ref).toBe(order.ref);

    const cards = async () => (await buyer.api.get(`/v1/chat/rooms/${detail.room_id}/messages`)).body.filter((m: any) => m.kind === 'system_order').map((m: any) => JSON.parse(m.body));
    let seen = await cards();
    expect(seen.map((c: any) => c.status)).toEqual(['awaiting_payment', 'paid']);
    expect(seen[1]).toMatchObject({ order_id: order.id, ref: order.ref, title: offer.title, character_name: 'Pat_of_Caerleon', quantity: 1 });
    expect(seen[1]).not.toHaveProperty('amount_cents');
    // Every card comes from the server: a user cannot send that kind.
    expect((await buyer.api.post(`/v1/chat/rooms/${detail.room_id}/messages`, { body: '{"status":"completed"}', kind: 'system_order' })).body.kind).toBe('text');

    await seller.api.post(`/v1/orders/${order.id}/deliver`, { payload: 'traded' });
    await buyer.api.post(`/v1/orders/${order.id}/dispute`, { reason: 'Only half of the silver arrived in the trade' });
    seen = await cards();
    expect(seen.map((c: any) => c.status)).toEqual(['awaiting_payment', 'paid', 'delivered', 'disputed']);
  });

  it('serves the staff-managed safety text and lets support edit it', async () => {
    const t = (await client(h.app).get('/v1/texts/chat_safety')).body;
    expect(t.body).toContain('Sharing outside contacts can get your account banned right away.');
    expect(t).toMatchObject({ link_label: 'Rules and policies', link_href: '/help/report-a-user' });
    const support = await makeUser(h, { role: 'support' });
    const put = await support.api.put('/v1/admin/texts/chat_safety', { body: 'Trade only here. Never share contacts.', linkLabel: 'Rules', linkHref: '/help/report-a-user' });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect((await client(h.app).get('/v1/texts/chat_safety')).body.body).toBe('Trade only here. Never share contacts.');
    expect((await support.api.put('/v1/admin/texts/chat_safety', { body: 'x', linkHref: 'https://evil.example' })).status).toBe(400);
    expect((await (await makeUser(h)).api.put('/v1/admin/texts/chat_safety', { body: 'Trade only here. Never share contacts.' })).status).toBe(403);
  });
});
