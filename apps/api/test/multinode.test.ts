import type { AddressInfo } from 'node:net';
import { Redis } from 'ioredis';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/context.js';
import { RedisPubSub } from '../src/lib/pubsub.js';
import { buildApp } from '../src/server.js';
import { buyAndPay, makeOffer, makeUser, setup, type Harness } from './helpers.js';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';

async function redisAvailable() {
  const r = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
  try {
    await r.connect();
    await r.ping();
    return true;
  } catch {
    return false;
  } finally {
    r.disconnect();
  }
}

const hasRedis = await redisAvailable();

describe.skipIf(!hasRedis)('horizontal scaling via Redis pub/sub', () => {
  let h: Harness;
  const nodes: Array<{ url: string; close: () => Promise<void> }> = [];

  beforeAll(async () => {
    h = await setup();
    // Two independent API nodes sharing the database and Redis — as behind a load balancer.
    for (let i = 0; i < 2; i++) {
      const ctx = createContext(loadConfig(), { info() {}, warn() {}, error() {} }, { db: h.ctx.db, pubsub: new RedisPubSub(REDIS_URL) });
      const app = await buildApp(ctx);
      await app.listen({ port: 0, host: '127.0.0.1' });
      nodes.push({ url: `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/v1/ws`, close: async () => { await app.close(); await ctx.pubsub.close(); } });
    }
    await new Promise((r) => setTimeout(r, 200)); // let psubscribe settle
  });
  afterAll(async () => {
    for (const n of nodes) await n.close();
    await h.close();
  });

  const open = (url: string, token: string) =>
    new Promise<{ ws: WebSocket; frames: any[] }>((resolve, reject) => {
      const ws = new WebSocket(url);
      const frames: any[] = [];
      ws.on('message', (raw) => {
        const f = JSON.parse(raw.toString());
        frames.push(f);
        if (f.type === 'ready') resolve({ ws, frames });
      });
      ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
      ws.on('error', reject);
    });

  const waitFor = async (frames: any[], pred: (f: any) => boolean) => {
    for (let i = 0; i < 100; i++) {
      const f = frames.find(pred);
      if (f) return f;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('timed out');
  };

  it('delivers a message sent to node A to a client connected to node B', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller, { categorySlug: 'currency', deliveryMode: 'manual', stock: 10 });
    const order = await buyAndPay(h, buyer, offer.id);
    const roomId = (await buyer.api.get(`/v1/orders/${order.id}`)).body.room_id;

    const a = await open(nodes[0]!.url, buyer.token);
    const b = await open(nodes[1]!.url, seller.token);
    a.ws.send(JSON.stringify({ type: 'subscribe', roomId }));
    b.ws.send(JSON.stringify({ type: 'subscribe', roomId }));
    await waitFor(a.frames, (f) => f.type === 'history');
    await waitFor(b.frames, (f) => f.type === 'history');

    a.ws.send(JSON.stringify({ type: 'message', roomId, body: 'cross-node hello', clientMsgId: 'x' }));
    const got = await waitFor(b.frames, (f) => f.type === 'message' && f.message.body === 'cross-node hello');
    const ack = await waitFor(a.frames, (f) => f.type === 'ack');
    expect(got.message.seq).toBe(ack.seq);
    a.ws.close();
    b.ws.close();
  });
});
