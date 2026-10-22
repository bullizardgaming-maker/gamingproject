import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buyAndPay, makeOffer, makeUser, setup, type Harness } from './helpers.js';
import { autoResolveTickets } from '../src/domain/support.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

const sent = async (userId: string, template: string) =>
  (await h.ctx.db.query('SELECT data FROM notifications WHERE user_id = $1 AND template = $2 ORDER BY created_at', [userId, template])).rows.map((r) => r.data);

describe('support tickets', () => {
  it('runs a ticket on an order from request to resolution, hiding internal notes from the customer', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h);
    const stranger = await makeUser(h);
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 3 });
    const order = await buyAndPay(h, buyer, offer.id);

    // Only someone on the order can link it.
    expect((await stranger.api.post('/v1/support/tickets', { category: 'order', subject: 'Where is it', body: 'Hello there', orderId: order.id })).status).toBe(404);

    const created = await buyer.api.post('/v1/support/tickets', { category: 'order', subject: 'Key not delivered', body: 'Paid an hour ago, nothing yet.', orderId: order.id });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const t = created.body;
    expect(t).toMatchObject({ status: 'open', priority: 'high', category: 'order', number: expect.any(Number) });
    expect(t.order).toMatchObject({ id: order.id, offer_title: 'Test Key' });
    expect(t.messages).toHaveLength(1);
    expect(await sent(buyer.id, 'support_received')).toHaveLength(1);
    expect((await stranger.api.get(`/v1/support/tickets/${t.id}`)).status).toBe(404);

    // Staff queue: support has the permission, a plain user and finance don't.
    expect((await buyer.api.get('/v1/admin/support/tickets')).status).toBe(403);
    expect((await (await makeUser(h, { tier: 2, role: 'finance' })).api.get('/v1/admin/support/tickets')).status).toBe(403);
    const agent = await makeUser(h, { tier: 2, role: 'support', name: 'Agent Smith' });
    const queue = await agent.api.get('/v1/admin/support/tickets');
    expect(queue.status).toBe(200);
    expect(queue.body[0]).toMatchObject({ id: t.id, priority: 'high', status: 'open', messages: 1 });

    const note = await agent.api.post(`/v1/admin/support/tickets/${t.id}/messages`, { body: 'Seller is usually fast; nudge them.', internal: true });
    expect(note.body.messages).toHaveLength(2);
    expect(note.body.status).toBe('open');
    const replied = await agent.api.post(`/v1/admin/support/tickets/${t.id}/messages`, { body: 'We have asked the seller to deliver within the hour.' });
    expect(replied.body).toMatchObject({ status: 'pending', assigned_to: agent.id });
    expect(replied.body.first_response_at).toBeTruthy();
    expect(await sent(buyer.id, 'support_reply')).toEqual([expect.objectContaining({ number: t.number, resolved: false })]);

    // The customer sees the public reply as "Bullizard Support" and never the internal note.
    const mine = await buyer.api.get(`/v1/support/tickets/${t.id}`);
    expect(mine.body.messages.map((m: any) => m.body)).toEqual(['Paid an hour ago, nothing yet.', 'We have asked the seller to deliver within the hour.']);
    expect(mine.body.messages[1].author_name).toBe('Bullizard Support');
    expect(JSON.stringify(mine.body)).not.toContain('nudge');
    expect(mine.body.assigned_to).toBeUndefined();

    // A customer reply puts it back in the staff queue; resolving and replying reopens it.
    expect((await buyer.api.post(`/v1/support/tickets/${t.id}/messages`, { body: 'Got it, thanks!' })).body.status).toBe('open');
    expect((await buyer.api.post(`/v1/support/tickets/${t.id}/resolve`)).body.status).toBe('resolved');
    expect((await agent.api.get('/v1/admin/support/tickets')).body.find((x: any) => x.id === t.id)).toBeUndefined();
    expect((await agent.api.get('/v1/admin/support/tickets?status=resolved')).body[0].id).toBe(t.id);
    expect((await buyer.api.post(`/v1/support/tickets/${t.id}/messages`, { body: 'Actually one more thing' })).body.status).toBe('open');

    // Assignment and priority, audited.
    expect((await agent.api.patch(`/v1/admin/support/tickets/${t.id}`, { assignedTo: buyer.id })).status).toBe(400);
    const upd = await agent.api.patch(`/v1/admin/support/tickets/${t.id}`, { priority: 'normal', assignedTo: null });
    expect(upd.body).toMatchObject({ priority: 'normal', assigned_to: null });
    const log = (await h.ctx.db.query(`SELECT action FROM admin_audit_log WHERE target_id = $1 ORDER BY id`, [t.id])).rows.map((r) => r.action);
    expect(log).toEqual(['support.note', 'support.reply', 'support.update']); // the rejected assignment left no trace
    expect((await buyer.api.get('/v1/support/tickets')).body.map((x: any) => x.id)).toEqual([t.id]);
  });

  it('caps open tickets and resolves ones left waiting on the customer', async () => {
    const user = await makeUser(h);
    const agent = await makeUser(h, { tier: 2, role: 'admin' });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await user.api.post('/v1/support/tickets', { category: 'account', subject: `Question ${i}`, body: 'How do I verify my phone?' });
      expect(r.status).toBe(201);
      expect(r.body.priority).toBe('normal');
      ids.push(r.body.id);
    }
    const sixth = await user.api.post('/v1/support/tickets', { category: 'other', subject: 'One more', body: 'Hello again' });
    expect(sixth.status).toBe(400);
    expect(sixth.body.error.code).toBe('too_many_tickets');

    await agent.api.post(`/v1/admin/support/tickets/${ids[0]}/messages`, { body: 'Go to Account → Verification.' });
    await agent.api.post(`/v1/admin/support/tickets/${ids[1]}/messages`, { body: 'Done for you.', resolve: true });
    await h.ctx.db.query(`UPDATE support_tickets SET updated_at = now() - interval '8 days' WHERE id = ANY($1)`, [ids.slice(0, 3)]);
    expect(await autoResolveTickets(h.ctx)).toBe(1); // only the pending one; open and resolved are untouched
    expect((await user.api.get(`/v1/support/tickets/${ids[0]}`)).body.status).toBe('resolved');
    expect((await user.api.get(`/v1/support/tickets/${ids[2]}`)).body.status).toBe('open');
    expect(await sent(user.id, 'support_auto_resolved')).toHaveLength(1);
    // Two resolved: there is room again.
    expect((await user.api.post('/v1/support/tickets', { category: 'other', subject: 'Now it works', body: 'Hello again' })).status).toBe(201);
  });
});
