import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sellerAvailable } from '../src/domain/ledger.js';
import { runReconciliation } from '../src/domain/reconciliation.js';
import { MAX_ATTEMPTS, dispatchDueWebhooks } from '../src/domain/webhooks.js';
import { buyAndPay, client, makeOffer, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

describe('manual ledger adjustments', () => {
  it('needs balanced lines and a second admin, then posts one balanced transaction', async () => {
    const alice = await makeUser(h, { role: 'admin' });
    const bob = await makeUser(h, { role: 'admin' });
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h);
    const offer = await makeOffer(seller, { categorySlug: 'boosting', deliveryMode: 'manual', stock: 2 });
    const order = await buyAndPay(h, buyer, offer.id);

    const unbalanced = await alice.api.post('/v1/admin/ledger/adjustments', {
      reason: 'Goodwill credit for a late payout',
      lines: [{ kind: 'treasury', amountCents: -500 }, { kind: 'seller_available', ownerId: seller.id, amountCents: 400 }],
    });
    expect(unbalanced.body.error.code).toBe('unbalanced');
    const noOwner = await alice.api.post('/v1/admin/ledger/adjustments', {
      reason: 'Goodwill credit for a late payout',
      lines: [{ kind: 'treasury', amountCents: -500 }, { kind: 'seller_available', amountCents: 500 }],
    });
    expect(noOwner.status).toBe(400);

    const req = await alice.api.post('/v1/admin/ledger/adjustments', {
      reason: 'Goodwill credit for a late payout',
      orderId: order.id,
      lines: [{ kind: 'treasury', amountCents: -500 }, { kind: 'seller_available', ownerId: seller.id, amountCents: 500 }],
    });
    expect(req.status).toBe(201);
    const before = await sellerAvailable(h.ctx.db, seller.id);
    expect((await alice.api.post(`/v1/admin/ledger/adjustments/${req.body.id}/decide`, { approve: true })).body.error.code).toBe('four_eyes');
    expect(await sellerAvailable(h.ctx.db, seller.id)).toBe(before);

    const posted = await bob.api.post(`/v1/admin/ledger/adjustments/${req.body.id}/decide`, { approve: true });
    expect(posted.body).toMatchObject({ status: 'posted' });
    expect(await sellerAvailable(h.ctx.db, seller.id)).toBe(before + 500);
    expect((await bob.api.post(`/v1/admin/ledger/adjustments/${req.body.id}/decide`, { approve: true })).status).toBe(409);

    const ledger = (await bob.api.get(`/v1/admin/users/${seller.id}/ledger`)).body;
    expect(ledger.find((a: any) => a.kind === 'seller_available').balance_cents).toBe(before + 500);
    expect((await seller.api.get('/v1/admin/ledger/adjustments')).status).toBe(403);

    const audit = (await alice.api.get('/v1/admin/audit?action=ledger.adjustment_posted')).body;
    expect(JSON.stringify(audit)).toContain(req.body.id);
    const recon = await runReconciliation(h.ctx);
    expect(recon.report.issues).toEqual([]);
  });
});

describe('webhook self-service', () => {
  it('lets a merchant find dead deliveries and redeliver them with the same event id', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const ep = (await seller.api.post('/v1/developer/webhooks', { url: 'https://merchant.example/hook', events: ['order.created'] })).body;
    await seller.api.post(`/v1/developer/webhooks/${ep.id}/test`);
    await seller.api.post(`/v1/developer/webhooks/${ep.id}/test`);

    const failing = async () => new Response('down', { status: 500 });
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await h.ctx.db.query(`UPDATE webhook_deliveries SET next_attempt_at = now() WHERE endpoint_id = $1`, [ep.id]);
      await dispatchDueWebhooks(h.ctx, { fetchImpl: failing as any });
    }
    const key = (await seller.api.post('/v1/developer/api-keys', { name: 'ops', scopes: ['webhooks:manage'] })).body.key;
    const bot = client(h.app, key);
    const dead = (await bot.get('/v1/merchant/webhooks/deliveries?status=dead')).body;
    expect(dead).toHaveLength(2);

    const seen: string[] = [];
    const ok = async (_url: string, init: any) => {
      seen.push(JSON.parse(init.body).id);
      return new Response('', { status: 200 });
    };
    expect((await bot.post(`/v1/merchant/webhooks/deliveries/${dead[0].id}/redeliver`)).body).toMatchObject({ status: 'pending' });
    await dispatchDueWebhooks(h.ctx, { fetchImpl: ok as any });
    expect(seen).toEqual([dead[0].payload.id]);

    expect((await bot.post(`/v1/merchant/webhooks/${ep.id}/replay`, {})).body).toEqual({ requeued: 1 });
    await dispatchDueWebhooks(h.ctx, { fetchImpl: ok as any });
    expect(seen).toHaveLength(2);
    expect((await bot.get('/v1/merchant/webhooks/deliveries?status=succeeded')).body).toHaveLength(2);

    // Someone else's delivery is invisible.
    const other = await makeUser(h, { tier: 2 });
    expect((await other.api.post(`/v1/developer/webhooks/deliveries/${dead[0].id}/redeliver`)).status).toBe(404);
    // Disabled endpoints can't be redelivered to until re-enabled; rotation returns a new secret once.
    await seller.api.del(`/v1/developer/webhooks/${ep.id}`);
    expect((await bot.post(`/v1/merchant/webhooks/deliveries/${dead[0].id}/redeliver`)).status).toBe(404);
    expect((await seller.api.post(`/v1/developer/webhooks/${ep.id}/enable`)).body.active).toBe(true);
    const rotated = (await seller.api.post(`/v1/developer/webhooks/${ep.id}/rotate-secret`)).body;
    expect(rotated.secret).toMatch(/^whsec_/);
    expect(rotated.secret).not.toBe(ep.secret);
  });
});
