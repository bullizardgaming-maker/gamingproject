import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sellerAvailable } from '../src/domain/ledger.js';
import { runReconciliation } from '../src/domain/reconciliation.js';
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
