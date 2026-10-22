import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Bullizard, BullizardError, WebhookVerificationError, constructWebhookEvent, verifyWebhookSignature } from '../../../sdks/typescript/src/index.js';
import { buildOpenApi } from '../src/openapi.js';
import { signPayload } from '../src/domain/webhooks.js';
import { buyAndPay, makeOffer, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

/** fetch that goes straight into the Fastify app, so the SDK runs against the real API. */
const injectFetch = (async (url: string, init: RequestInit = {}) => {
  const u = new URL(url);
  const r = await h.app.inject({ method: (init.method ?? 'GET') as any, url: u.pathname + u.search, headers: init.headers as any, payload: init.body as any });
  const headers = new Headers();
  for (const [k, v] of Object.entries(r.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
  return new Response(r.statusCode === 204 ? null : r.rawPayload, { status: r.statusCode, headers });
}) as typeof fetch;

const sdk = (apiKey: string) => new Bullizard({ apiKey, baseUrl: 'http://api.test', fetch: injectFetch, maxRetries: 0 });

describe('TypeScript SDK against the real API', () => {
  it('runs a seller bot end to end', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const key = await seller.api.post('/v1/developer/api-keys', {
      name: 'bot',
      scopes: ['orders:read', 'orders:write', 'inventory:write', 'offers:write', 'chat:write', 'reports:read', 'webhooks:manage'],
    });
    const bz = sdk(key.body.key);

    const auto = await makeOffer(seller);
    expect(await bz.inventory.upload({ offerId: auto.id, format: 'txt', content: 'CODE-1\nCODE-2\nCODE-1' })).toEqual({ added: 2, duplicates: 1, available: 2 });
    const results = await bz.prices.update([{ offerId: auto.id, priceCents: 9_99, version: auto.version }]);
    expect(results[0]).toMatchObject({ ok: true, price_cents: 9_99 });

    const manual = await makeOffer(seller, { categorySlug: 'boosting', deliveryMode: 'manual', stock: 2 });
    const order = await buyAndPay(h, buyer, manual.id);
    const paid = await bz.orders.list({ status: 'paid' });
    const mine = paid.find((o) => o.id === order.id)!;
    expect(mine).toMatchObject({ status: 'paid', quantity: 1 });

    const sent = await bz.chat.send(mine.chat_room_id, 'Starting your boost now');
    expect(sent).toMatchObject({ body: 'Starting your boost now', sender_id: seller.id });
    await bz.orders.deliver(order.id, 'Boost done: Diamond II');
    expect((await bz.orders.get(order.id)).status).toBe('delivered');

    // Polling yields each change once; aborting ends it.
    const abort = new AbortController();
    const seen: string[] = [];
    for await (const o of bz.orders.poll({ intervalMs: 10, signal: abort.signal })) {
      seen.push(`${o.id}:${o.status}`);
      if (seen.length === 1) abort.abort();
    }
    expect(seen).toEqual([`${order.id}:delivered`]);

    const sales = await bz.reports.get('sales');
    expect(sales.kind).toBe('sales');
    expect(Array.isArray(sales.rows)).toBe(true);
    expect(await bz.reports.csv('payouts')).toMatch(/^[a-z_]+(,[a-z_]+)*\r?\n/);
    expect(await bz.invoices.list()).toEqual([]);
    expect(await bz.webhooks.deliveries({ status: 'all' })).toEqual([]);

    // Errors carry the API's status and code.
    const err = await bz.orders.get('00000000-0000-4000-8000-000000000000').catch((e) => e);
    expect(err).toBeInstanceOf(BullizardError);
    expect(err).toMatchObject({ status: 404 });
  });

  it('surfaces missing scopes as errors, and refuses a non-API key', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const key = await seller.api.post('/v1/developer/api-keys', { name: 'ro', scopes: ['orders:read'] });
    const err = await sdk(key.body.key).prices.update([{ offerId: '00000000-0000-4000-8000-000000000000', priceCents: 100 }]).catch((e) => e);
    expect(err).toMatchObject({ status: 403 });
    expect(() => new Bullizard({ apiKey: 'eyJhbGciOi...' })).toThrow(/mk_/);
  });

  it('retries a rate-limited call and then succeeds', async () => {
    let calls = 0;
    const flaky = (async () => {
      calls++;
      return calls === 1
        ? new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'slow down' } }), { status: 429, headers: { 'retry-after': '0', 'content-type': 'application/json' } })
        : new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const bz = new Bullizard({ apiKey: 'mk_test_key', baseUrl: 'http://api.test', fetch: flaky });
    expect(await bz.orders.list()).toEqual([]);
    expect(calls).toBe(2);
  });

  it('verifies webhook signatures exactly as the API signs them', async () => {
    const secret = 'whsec_test_secret';
    const raw = JSON.stringify({ id: 'evt_1', type: 'order.created', created_at: new Date().toISOString(), data: { id: 'o1' } });
    const sig = signPayload(secret, raw);
    expect(await verifyWebhookSignature(raw, sig, secret)).toBe(true);
    expect(await verifyWebhookSignature(raw.replace('o1', 'o2'), sig, secret)).toBe(false);
    expect(await verifyWebhookSignature(raw, sig, 'wrong')).toBe(false);

    const event = await constructWebhookEvent(new TextEncoder().encode(raw), { 'x-hook-signature': sig }, secret);
    expect(event.type).toBe('order.created');
    await expect(constructWebhookEvent(raw, new Headers(), secret)).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it('only calls endpoints the published API reference documents', async () => {
    const documented = Object.keys((buildOpenApi({ serverUrl: 'http://x', sandbox: false }) as any).paths);
    const fs = await import('node:fs');
    const ts = fs.readFileSync(new URL('../../../sdks/typescript/src/index.ts', import.meta.url), 'utf8');
    const py = fs.readFileSync(new URL('../../../sdks/python/bullizard/client.py', import.meta.url), 'utf8');
    // Path templates with their parameters as {id}, without the query string the client appends.
    const norm = (p: string) => `/v1${p.replace(/\$\{qs\(.*$/, '').replace(/\$?\{[^}]+\}/g, '{id}')}`;
    const docs = new Set(documented.map((p) => p.replace(/\{[a-z_]+\}/gi, '{id}')));
    const tsPaths = [...ts.matchAll(/`(\/merchant\/[^`]*)`/g)].map((m) => norm(m[1]!).replace(/\/$/, ''));
    const pyPaths = [...py.matchAll(/f?"(\/merchant\/[^"]*)"/g)].map((m) => norm(m[1]!).replace(/\/$/, ''));
    expect(tsPaths.length).toBeGreaterThan(8);
    expect(pyPaths.length).toBeGreaterThan(8);
    for (const p of [...tsPaths, ...pyPaths]) expect(docs, `${p} is not in the API reference`).toContain(p);
  });
});
