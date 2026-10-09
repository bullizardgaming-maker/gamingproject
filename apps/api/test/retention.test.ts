import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runRetention } from '../src/domain/retention.js';
import { buyAndPay, makeOffer, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

const png = () => sharp({ create: { width: 8, height: 8, channels: 3, background: '#cc3333' } }).png().toBuffer();

/** Pretend `sql`'s rows happened `days` ago (test-only: bypasses the append-only triggers). */
async function age(table: string, where: string, params: unknown[], column: string, days: number) {
  await h.ctx.db.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
  await h.ctx.db.query(`UPDATE ${table} SET ${column} = ${column} - make_interval(days => ${days}) WHERE ${where}`, params);
  await h.ctx.db.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
}

describe('data retention', () => {
  it('deletes old closed-order chats with their images, erases old delivered codes, and keeps the books', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller);
    await seller.api.post(`/v1/offers/${offer.id}/inventory`, { format: 'txt', content: 'OLD-CODE-1\nNEW-CODE-2' });
    const old = await buyAndPay(h, buyer, offer.id);
    const fresh = await buyAndPay(h, buyer, offer.id);
    for (const o of [old, fresh]) await buyer.api.post(`/v1/orders/${o.id}/confirm`);

    const oldRoom = (await buyer.api.get(`/v1/orders/${old.id}`)).body.room_id as string;
    const up = await buyer.api.post(`/v1/chat/rooms/${oldRoom}/attachments`, await png(), { 'content-type': 'image/png', 'x-filename': 'proof.png' });
    expect(up.status).toBe(201);
    const { rows: [att] } = await h.ctx.db.query('SELECT storage_key FROM chat_attachments WHERE id = $1', [up.body.id]);
    const headBefore = (await buyer.api.get(`/v1/chat/rooms/${oldRoom}/verify`)).body.headHash;

    // The old order closed three years ago; its code was delivered then too.
    await age('orders', 'id = $1', [old.id], 'completed_at', 1100);
    await age('inventory_items', 'order_id = $1', [old.id], 'delivered_at', 1100);
    const ledgerBefore = (await h.ctx.db.query('SELECT count(*)::int AS n FROM ledger_entries')).rows[0].n;

    const run = await runRetention(h.ctx);
    expect(run.counts).toMatchObject({ chatRooms: 1, chatFiles: 1, deliveredItems: 1 });
    expect(run.counts.chatMessages).toBeGreaterThan(2);

    // Chat: messages gone, final hash kept, image deleted from storage.
    expect((await h.ctx.db.query('SELECT count(*)::int AS n FROM chat_messages WHERE room_id = $1', [oldRoom])).rows[0].n).toBe(0);
    const verify = (await buyer.api.get(`/v1/chat/rooms/${oldRoom}/verify`)).body;
    expect(verify).toMatchObject({ valid: true, headHash: headBefore });
    expect(verify.purgedAt).toBeTruthy();
    await expect(h.ctx.storage.get(att.storage_key)).rejects.toThrow();

    // Codes: the old one is erased, the recent one still readable.
    expect((await buyer.api.get(`/v1/orders/${old.id}/items`)).body[0]).toMatchObject({ content: null });
    expect((await buyer.api.get(`/v1/orders/${fresh.id}/items`)).body[0].content).toBe('NEW-CODE-2');
    expect((await h.ctx.db.query('SELECT count(*)::int AS n FROM chat_messages m JOIN chat_rooms r ON r.id = m.room_id WHERE r.order_id = $1', [fresh.id])).rows[0].n).toBeGreaterThan(0);

    // Money records are never purged.
    expect((await h.ctx.db.query('SELECT count(*)::int AS n FROM ledger_entries')).rows[0].n).toBe(ledgerBefore);
    // Outside the retention job the chat log is still append-only.
    await expect(h.ctx.db.query('DELETE FROM chat_messages WHERE room_id IN (SELECT id FROM chat_rooms WHERE order_id = $1)', [fresh.id])).rejects.toThrow(/append-only/);
  });

  it('keeps chats that are still contested and purges short-lived security data', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller, { categorySlug: 'boosting', deliveryMode: 'manual', stock: 2 });
    const order = await buyAndPay(h, buyer, offer.id);
    await seller.api.post(`/v1/orders/${order.id}/deliver`, { payload: 'done' });
    await buyer.api.post(`/v1/orders/${order.id}/dispute`, { reason: 'The boost was not completed as agreed' });
    await h.ctx.db.query(`UPDATE orders SET status = 'refunded' WHERE id = $1`, [order.id]); // closed, but the dispute row is still open
    await age('orders', 'id = $1', [order.id], 'updated_at', 1100);

    await h.ctx.db.query(`INSERT INTO login_failures (ip, created_at) VALUES ('203.0.113.9', now() - interval '2 days')`);
    await h.ctx.db.query(`INSERT INTO csp_reports (payload, created_at) VALUES ('{}', now() - interval '200 days')`);
    const run = await runRetention(h.ctx);
    expect(run.counts.chatRooms).toBe(0);
    expect(run.counts.loginFailures).toBeGreaterThanOrEqual(1);
    expect(run.counts.cspReports).toBe(1);

    const admin = await makeUser(h, { role: 'admin' });
    const view = (await admin.api.get('/v1/admin/retention')).body;
    expect(view.policy.chatAfterOrderClosedDays).toBe(730);
    expect(view.runs[0].status).toBe('ok');
  });
});
