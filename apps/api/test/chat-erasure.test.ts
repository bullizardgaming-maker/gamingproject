import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyChain } from '../src/domain/chat.js';
import { clearChatKeyCache } from '../src/domain/chatkeys.js';
import { runRetention } from '../src/domain/retention.js';
import { rotateAll } from '../src/domain/keyrotation.js';
import { buyAndPay, makeOffer, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

async function orderChat() {
  const seller = await makeUser(h, { tier: 2 });
  const buyer = await makeUser(h, { tier: 1 });
  const offer = await makeOffer(seller, { categorySlug: 'boosting', deliveryMode: 'manual', stock: 1, priceCents: 25_00 });
  const order = await buyAndPay(h, buyer, offer.id);
  const roomId = (await h.ctx.db.query('SELECT id FROM chat_rooms WHERE order_id = $1', [order.id])).rows[0].id;
  await buyer.api.post(`/v1/chat/rooms/${roomId}/messages`, { body: 'my rank is gold 2, server EUW' });
  await seller.api.post(`/v1/chat/rooms/${roomId}/messages`, { body: 'starting tonight' });
  return { seller, buyer, order, roomId };
}

describe('per-user chat erasure', () => {
  it('erases one user’s messages while the chain still verifies and everyone else’s stay readable', async () => {
    const { seller, buyer, order, roomId } = await orderChat();
    const compliance = await makeUser(h, { role: 'compliance' });
    const support = await makeUser(h, { role: 'support' });

    // Evidence is held while a dispute is open.
    await seller.api.post(`/v1/orders/${order.id}/deliver`, { payload: 'done' });
    expect((await buyer.api.post(`/v1/orders/${order.id}/dispute`, { reason: 'not_delivered', description: 'Boost never happened at all' })).status).toBe(200);
    expect((await compliance.api.post(`/v1/admin/users/${buyer.id}/erase-chat`, { reason: 'GDPR erasure request' })).body.error.code).toBe('legal_hold');
    await h.ctx.db.query(`UPDATE orders SET status = 'completed' WHERE id = $1`, [order.id]);

    expect((await support.api.post(`/v1/admin/users/${buyer.id}/erase-chat`, { reason: 'GDPR erasure request' })).status).toBe(403);
    expect((await compliance.api.post(`/v1/admin/users/${buyer.id}/erase-chat`, { reason: 'GDPR erasure request' })).body).toEqual({ erased: true, alreadyErased: false });

    const msgs = (await seller.api.get(`/v1/chat/rooms/${roomId}/messages`)).body;
    const fromBuyer = msgs.filter((m: any) => m.sender_id === buyer.id);
    const fromSeller = msgs.filter((m: any) => m.sender_id === seller.id);
    expect(fromBuyer.length).toBeGreaterThan(0);
    expect(fromBuyer.every((m: any) => m.body === null && m.erased === true)).toBe(true);
    expect(fromSeller.map((m: any) => m.body)).toContain('starting tonight');
    expect(JSON.stringify(msgs)).not.toContain('gold 2');

    // The chain still verifies over the stored digests, and says how many messages are erased.
    const v = (await seller.api.get(`/v1/chat/rooms/${roomId}/verify`)).body;
    expect(v).toMatchObject({ valid: true, erasedMessages: fromBuyer.length });
    // The erased user can't add to the record any more; a second erasure is a no-op.
    expect((await buyer.api.post(`/v1/chat/rooms/${roomId}/messages`, { body: 'hello again' })).body.error.code).toBe('chat_erased');
    expect((await compliance.api.post(`/v1/admin/users/${buyer.id}/erase-chat`, { reason: 'GDPR erasure request' })).body.alreadyErased).toBe(true);
    const audit = (await (await makeUser(h, { role: 'admin' })).api.get('/v1/admin/audit?action=chat.erased')).body;
    expect(JSON.stringify(audit)).toContain('GDPR erasure request');
  });

  it('erases deleted accounts’ chat once the retention period has passed, and rotates wrapped keys', async () => {
    const { buyer, roomId } = await orderChat();
    // Data-key rotation re-wraps chat keys, and messages stay readable.
    const before = (await buyer.api.get(`/v1/chat/rooms/${roomId}/messages`)).body;
    expect(Object.values(await rotateAll(h.ctx)).every((n) => typeof n === 'number')).toBe(true);
    clearChatKeyCache();
    expect((await buyer.api.get(`/v1/chat/rooms/${roomId}/messages`)).body.map((m: any) => m.body)).toEqual(before.map((m: any) => m.body));

    await h.ctx.db.query(`UPDATE users SET deleted_at = now() - make_interval(days => $2) WHERE id = $1`, [buyer.id, h.ctx.cfg.RETENTION_ORDER_IP_DAYS + 1]);
    const run = await runRetention(h.ctx);
    expect(run.counts.chatKeysDestroyed).toBeGreaterThanOrEqual(1);
    clearChatKeyCache();
    expect((await verifyChain(h.ctx.db, roomId, h.ctx.keyring)).valid).toBe(true);
    const row = (await h.ctx.db.query('SELECT key_ciphertext, shred_reason FROM chat_user_keys WHERE user_id = $1', [buyer.id])).rows[0];
    expect(row).toEqual({ key_ciphertext: null, shred_reason: 'account deleted; retention period over' });
  });
});
