import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/context.js';
import { MemoryPubSub } from '../src/lib/pubsub.js';
import { FakeCaptcha } from '../src/providers/captcha.js';
import { buildApp } from '../src/server.js';
import { client, setup, type Harness } from './helpers.js';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';
const hasRedis = await (async () => {
  const r = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
  try {
    await r.connect();
    return (await r.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    r.disconnect();
  }
})();

let h: Harness;
beforeAll(async () => {
  h = await setup({ CAPTCHA_PROVIDER: 'turnstile', CAPTCHA_SECRET: 'x', CAPTCHA_SITE_KEY: 'site-key', CAPTCHA_AFTER_FAILED_LOGINS: '2' }, { captcha: new FakeCaptcha('captcha-ok') });
});
afterAll(async () => h.close());

describe('CAPTCHA', () => {
  it('advertises the widget and requires it for sign-up and password reset', async () => {
    const anon = client(h.app);
    expect((await anon.get('/v1/auth/config')).body).toEqual({ captcha: { provider: 'turnstile', siteKey: 'site-key' } });
    const reg = { email: `bot${Date.now()}@example.com`, password: 'correct horse battery', displayName: 'Bot' };
    expect((await anon.post('/v1/auth/register', reg)).body.error.code).toBe('captcha_required');
    expect((await anon.post('/v1/auth/register', { ...reg, captchaToken: 'forged' })).body.error.code).toBe('captcha_failed');
    expect((await anon.post('/v1/auth/register', { ...reg, captchaToken: 'captcha-ok' })).status).toBe(201);

    expect((await anon.post('/v1/auth/password/forgot', { email: reg.email })).status).toBe(400);
    expect((await anon.post('/v1/auth/password/forgot', { email: reg.email, captchaToken: 'captcha-ok' })).status).toBe(202);
  });

  it('asks for it at sign-in only after failures from the same IP, for known and unknown emails alike', async () => {
    const email = `known${Date.now()}@example.com`;
    await client(h.app).post('/v1/auth/register', { email, password: 'correct horse battery', displayName: 'Known', captchaToken: 'captcha-ok' });

    const fromA = client(h.app, undefined, { 'x-forwarded-for': '203.0.113.10' });
    const fromB = client(h.app, undefined, { 'x-forwarded-for': '203.0.113.11' });
    expect((await fromA.post('/v1/auth/login', { email, password: 'correct horse battery' })).status).toBe(200);
    await fromA.post('/v1/auth/login', { email, password: 'wrong password!!' });
    await fromA.post('/v1/auth/login', { email: 'nobody@example.com', password: 'wrong password!!' });
    // Two failures from A: A now needs a token for any email; B does not.
    expect((await fromA.post('/v1/auth/login', { email: 'ghost@example.com', password: 'whatever12345' })).body.error.code).toBe('captcha_required');
    expect((await fromA.post('/v1/auth/login', { email, password: 'correct horse battery' })).body.error.code).toBe('captcha_required');
    expect((await fromA.post('/v1/auth/login', { email, password: 'correct horse battery', captchaToken: 'captcha-ok' })).status).toBe(200);
    expect((await fromB.post('/v1/auth/login', { email, password: 'correct horse battery' })).status).toBe(200);
  });
});

describe.skipIf(!hasRedis)('shared rate limits', () => {
  it('counts requests across API nodes through Redis', async () => {
    const cfg = loadConfig({ REDIS_URL, RATE_LIMIT_PER_MINUTE: '5', TRUST_PROXY: 'true' } as any);
    const nodes = await Promise.all([0, 1].map(async () => buildApp(createContext(cfg, { info() {}, warn() {}, error() {} }, { db: h.ctx.db, pubsub: new MemoryPubSub() }))));
    const ip = `198.51.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 254) + 1}`;
    // Start from a clean counter for this IP (a previous run within the minute may have used it).
    const r = new Redis(REDIS_URL);
    const stale = await r.keys(`bz-rl:*${ip}*`);
    if (stale.length) await r.del(...stale);
    r.disconnect();
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      const res = await nodes[i % 2]!.inject({ method: 'GET', url: '/v1/categories', headers: { 'x-forwarded-for': ip } });
      statuses.push(res.statusCode);
    }
    // Five allowed in total, not five per node.
    expect(statuses.filter((s) => s === 200)).toHaveLength(5);
    expect(statuses.slice(5).every((s) => s === 429)).toBe(true);
    await Promise.all(nodes.map((n) => n.close()));
  });
});
