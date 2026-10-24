import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buyAndPay, makeOffer, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
let wsUrl: string;
beforeAll(async () => {
  h = await setup();
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  wsUrl = `ws://127.0.0.1:${(h.app.server.address() as AddressInfo).port}/v1/ws`;
});
afterAll(async () => h.close());

async function orderRoom() {
  const seller = await makeUser(h, { tier: 2 });
  const buyer = await makeUser(h, { tier: 1 });
  const offer = await makeOffer(seller, { categorySlug: 'currency', deliveryMode: 'manual', stock: 100 });
  const order = await buyAndPay(h, buyer, offer.id);
  const roomId = (await buyer.api.get(`/v1/orders/${order.id}`)).body.room_id as string;
  return { seller, buyer, roomId, order };
}

function connect(token: string): Promise<{ ws: WebSocket; next: (pred: (m: any) => boolean) => Promise<any> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const inbox: any[] = [];
    const waiters: Array<{ pred: (m: any) => boolean; resolve: (m: any) => void }> = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      const w = waiters.findIndex((x) => x.pred(m));
      if (w >= 0) waiters.splice(w, 1)[0]!.resolve(m);
      else inbox.push(m);
    });
    const next = (pred: (m: any) => boolean) =>
      new Promise<any>((res, rej) => {
        const i = inbox.findIndex(pred);
        if (i >= 0) return res(inbox.splice(i, 1)[0]);
        waiters.push({ pred, resolve: res });
        setTimeout(() => rej(new Error('timeout waiting for ws frame')), 5_000);
      });
    ws.on('open', async () => {
      ws.send(JSON.stringify({ type: 'auth', token }));
      try {
        await next((m) => m.type === 'ready');
        resolve({ ws, next });
      } catch (e) {
        reject(e);
      }
    });
    ws.on('error', reject);
  });
}

describe('chat ledger', () => {
  it('assigns gapless monotonic sequence numbers under concurrent writers', async () => {
    const { buyer, seller, roomId } = await orderRoom();
    await Promise.all(
      Array.from({ length: 30 }, (_, i) => (i % 2 ? buyer : seller).api.post(`/v1/chat/rooms/${roomId}/messages`, { body: `message ${i}` })),
    );
    const msgs = (await buyer.api.get(`/v1/chat/rooms/${roomId}/messages`)).body as Array<{ seq: number }>;
    expect(msgs.map((m) => m.seq)).toEqual(Array.from({ length: msgs.length }, (_, i) => i + 1));
    expect((await buyer.api.get(`/v1/chat/rooms/${roomId}/verify`)).body).toMatchObject({ valid: true, messages: msgs.length });
  });

  it('is tamper-evident and append-only', async () => {
    const { buyer, roomId } = await orderRoom();
    await buyer.api.post(`/v1/chat/rooms/${roomId}/messages`, { body: 'the code did not work' });
    await buyer.api.post(`/v1/chat/rooms/${roomId}/messages`, { body: 'the code worked' });
    // The text is stored sealed with the author's key, never in the clear.
    const stored = (await h.ctx.db.query(`SELECT seq, body, body_sealed, body_mac FROM chat_messages WHERE room_id = $1 AND sender_id = $2 ORDER BY seq`, [roomId, buyer.id])).rows;
    expect(stored.map((m: any) => m.body)).toEqual(['', '']);
    expect(JSON.stringify(stored)).not.toContain('did not work');
    expect((await buyer.api.get(`/v1/chat/rooms/${roomId}/verify`)).body).toMatchObject({ valid: true, erasedMessages: 0 });
    await expect(h.ctx.db.query(`UPDATE chat_messages SET body_sealed = NULL WHERE room_id = $1`, [roomId])).rejects.toThrow(/append-only/);

    // Even a superuser bypassing the trigger is caught: swapping one message's sealed text for another's...
    const [first, second] = stored;
    await h.ctx.db.query('ALTER TABLE chat_messages DISABLE TRIGGER chat_messages_append_only');
    await h.ctx.db.query(`UPDATE chat_messages SET body_sealed = $3 WHERE room_id = $1 AND seq = $2`, [roomId, first.seq, second.body_sealed]);
    await h.ctx.db.query('ALTER TABLE chat_messages ENABLE TRIGGER chat_messages_append_only');
    expect((await buyer.api.get(`/v1/chat/rooms/${roomId}/verify`)).body).toMatchObject({ valid: false, brokenAtSeq: first.seq });

    // ...or rewriting the digest the chain covers.
    await h.ctx.db.query('ALTER TABLE chat_messages DISABLE TRIGGER chat_messages_append_only');
    await h.ctx.db.query(`UPDATE chat_messages SET body_sealed = $3 WHERE room_id = $1 AND seq = $2`, [roomId, first.seq, first.body_sealed]);
    await h.ctx.db.query(`UPDATE chat_messages SET body_mac = repeat('0', 64) WHERE room_id = $1 AND seq = $2`, [roomId, second.seq]);
    await h.ctx.db.query('ALTER TABLE chat_messages ENABLE TRIGGER chat_messages_append_only');
    expect((await buyer.api.get(`/v1/chat/rooms/${roomId}/verify`)).body).toMatchObject({ valid: false, brokenAtSeq: second.seq });
  });

  it('hides rooms from non-participants', async () => {
    const { roomId } = await orderRoom();
    const stranger = await makeUser(h, { tier: 1 });
    expect((await stranger.api.get(`/v1/chat/rooms/${roomId}/messages`)).status).toBe(403);
  });

  it('blocks off-platform contact (never delivered), counts offences, and applies the staff-set action', async () => {
    const { seller, buyer, roomId } = await orderRoom();
    const before = (await buyer.api.get(`/v1/chat/rooms/${roomId}/messages`)).body.length;
    const blocked = await seller.api.post(`/v1/chat/rooms/${roomId}/messages`, { body: 'add me on discord for a discount' });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error).toMatchObject({ code: 'offplatform_blocked', message: 'Not sent. Sharing outside contacts can get your account banned right away.' });
    // The buyer never sees it, the sender neither; staff see the attempt in the queue with its context.
    let msgs = (await buyer.api.get(`/v1/chat/rooms/${roomId}/messages`)).body;
    expect(msgs).toHaveLength(before);
    expect(msgs.some((m: any) => m.body.includes('discord'))).toBe(false);
    expect((await seller.api.get(`/v1/chat/rooms/${roomId}/messages`)).body.some((m: any) => m.body.includes('discord'))).toBe(false);
    const mod = await makeUser(h, { role: 'support' });
    const queue = (await mod.api.get('/v1/admin/moderation/chats')).body;
    const flag = queue.find((f: any) => f.room_id === roomId);
    expect(flag.reasons).toContain('discord');
    expect(flag.context.at(-1)).toMatchObject({ body: 'add me on discord for a discount' });
    expect(blocked.body.error.details.action).toBe('queue'); // Round 22: blocked and queued, no strike until staff confirm
    expect((await seller.api.get('/v1/me')).body.user.status).toBe('active');

    // Launch policy (CEO, Oct 24): warn → suspend → ban, applied when staff confirm a flag. Staff can shorten it.
    expect((await mod.api.get('/v1/admin/moderation/offplatform-policy')).body.actions).toEqual(['warn', 'suspend', 'ban']);
    expect((await mod.api.put('/v1/admin/moderation/offplatform-policy', { actions: ['warn', 'ban'] })).body.actions).toEqual(['warn', 'ban']);
    expect((await mod.api.post(`/v1/admin/moderation/chats/${flag.id}`, { confirm: true })).body).toMatchObject({ status: 'confirmed', action: 'warn' });
    expect((await seller.api.get('/v1/me')).body.user.status).toBe('active'); // 1st confirmed offence: warn
    // An unambiguous contact link bans at once, without waiting for staff.
    await seller.api.post(`/v1/chat/rooms/${roomId}/messages`, { body: 'telegram: t.me/cheapgold' });
    expect((await h.ctx.db.query('SELECT status FROM users WHERE id = $1', [seller.id])).rows[0].status).toBe('banned');
    // Like the admin ban, the filter ban signs the account out everywhere (Round 22).
    const banned = await seller.api.post(`/v1/chat/rooms/${roomId}/messages`, { body: 'hello?' });
    expect(banned.status).toBe(401);
    msgs = (await buyer.api.get(`/v1/chat/rooms/${roomId}/messages`)).body;
    expect(msgs.at(-1).kind).toBe('warning');
    expect(msgs.at(-1).body).toContain('banned');
    // The hash chain still verifies with the hidden attempts in it.
    expect((await buyer.api.get(`/v1/chat/rooms/${roomId}/verify`)).body.valid).toBe(true);
    await mod.api.put('/v1/admin/moderation/offplatform-policy', { actions: ['warn', 'warn', 'ban'] });
  });
});

describe('websocket gateway', () => {
  it('delivers messages in real time with server-assigned seq and replays history on (re)subscribe', async () => {
    const { buyer, seller, roomId } = await orderRoom();
    const a = await connect(buyer.token);
    const b = await connect(seller.token);

    a.ws.send(JSON.stringify({ type: 'subscribe', roomId }));
    const history = await a.next((m) => m.type === 'history');
    const lastSeq = history.messages.at(-1).seq as number;
    b.ws.send(JSON.stringify({ type: 'subscribe', roomId, afterSeq: lastSeq }));
    expect((await b.next((m) => m.type === 'history')).messages).toEqual([]);

    a.ws.send(JSON.stringify({ type: 'message', roomId, body: 'is the gold ready?', clientMsgId: 'c1' }));
    const ack = await a.next((m) => m.type === 'ack');
    expect(ack).toMatchObject({ clientMsgId: 'c1', seq: lastSeq + 1 });
    const pushed = await b.next((m) => m.type === 'message' && m.message.seq === lastSeq + 1);
    expect(pushed.message.body).toBe('is the gold ready?');
    // Seller also gets a user-level notification.
    await b.next((m) => m.type === 'notification' && m.event === 'chat.message');

    // Reconnect + sync from the last seen seq.
    b.ws.close();
    a.ws.send(JSON.stringify({ type: 'message', roomId, body: 'hello?', clientMsgId: 'c2' }));
    await a.next((m) => m.type === 'ack' && m.clientMsgId === 'c2');
    const b2 = await connect(seller.token);
    b2.ws.send(JSON.stringify({ type: 'subscribe', roomId, afterSeq: lastSeq + 1 }));
    const missed = await b2.next((m) => m.type === 'history');
    expect(missed.messages.map((m: any) => m.body)).toEqual(['hello?']);

    a.ws.close();
    b2.ws.close();
  });

  it('rejects unauthenticated frames and foreign rooms', async () => {
    const { roomId } = await orderRoom();
    const stranger = await makeUser(h, { tier: 1 });
    const s = await connect(stranger.token);
    s.ws.send(JSON.stringify({ type: 'subscribe', roomId }));
    expect((await s.next((m) => m.type === 'error')).code).toBe('not_participant');
    s.ws.send('not json');
    expect((await s.next((m) => m.type === 'error')).code).toBe('bad_frame');
    s.ws.close();
    // A forged token closes the socket with 4401 so the client knows to refresh.
    const closed = await new Promise<number>((resolve) => {
      const ws = new WebSocket(wsUrl);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: 'forged' })));
      ws.on('close', (code) => resolve(code));
    });
    expect(closed).toBe(4401);
  });
});
