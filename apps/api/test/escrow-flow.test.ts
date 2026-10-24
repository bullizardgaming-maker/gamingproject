import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountId, balance, sellerAvailable } from '../src/domain/ledger.js';
import { dispatchDueWebhooks } from '../src/domain/webhooks.js';
import { runJobsOnce } from '../src/worker.js';
import { grossUp } from '../src/domain/commission.js';
import { endWindowAndRelease, buyAndPay, client, makeOffer, makeUser, mockKyc, setup, type Harness } from './helpers.js';

/** Fresh sellers are in the launch promo: 5% commission, grossed up on top of their price. */
const PROMO_BPS = 500;

let h: Harness;
beforeAll(async () => {
  h = await setup({ PLATFORM_TAX_COUNTRY: 'IE' }); // the VAT path stays tested here; production leaves the country unset until a company exists (CFO B3)
});
afterAll(async () => h.close());

async function platformBalance(kind: 'escrow' | 'treasury' | 'reserve' | 'gateway_clearing' | 'tax_payable') {
  return balance(h.ctx.db, await accountId(h.ctx.db, kind, 'USD'));
}

describe('verification tiers', () => {
  it('upgrades to Tier 1 after email + SMS OTP, and Tier 2 after eKYC approval', async () => {
    const u = await makeUser(h, { tier: 0 });
    expect((await u.api.post('/v1/orders', { offerId: '00000000-0000-0000-0000-000000000000', acceptTos: true })).body.error.code).toBe('kyc_required');

    await u.api.post('/v1/verify/email/send');
    const emailCode = /(\d{6})/.exec(h.messenger.lastTo(u.email)!.body)![1];
    expect((await u.api.post('/v1/verify/email/confirm', { code: '000000' })).status).toBe(400);
    await u.api.post('/v1/verify/email/confirm', { code: emailCode });

    expect((await u.api.post('/v1/verify/sms/send', { phone: '4155550123' })).status).toBe(400);
    await u.api.post('/v1/verify/sms/send', { phone: '+14155550123' });
    const smsCode = /(\d{6})/.exec(h.messenger.lastTo('+14155550123')!.body)![1];
    const confirmed = await u.api.post('/v1/verify/sms/confirm', { code: smsCode });
    expect(confirmed.body.user.kyc_tier).toBe(1);

    // Tier 1 cannot sell before passing the rules test (onboarding.test.ts).
    expect((await u.api.post('/v1/offers', { categorySlug: 'keys', game: 'G', title: 'Key', priceCents: 100, deliveryMode: 'auto' })).body.error.code).toBe('rules_test_required');

    const kyc = await u.api.post('/v1/kyc/start', { level: 'tier2_individual' });
    expect(kyc.status).toBe(200);
    const payload = JSON.stringify({ externalId: kyc.body.externalId, status: 'approved', legalName: 'Jane Seller' });
    const hook = await client(h.app).post('/v1/kyc/webhook/mock', payload, { 'content-type': 'application/json', 'x-mock-signature': mockKyc(h).sign(payload) });
    expect(hook.status).toBe(200);
    expect((await u.api.get('/v1/me')).body.user.kyc_tier).toBe(2);

    const forged = await client(h.app).post('/v1/kyc/webhook/mock', payload, { 'content-type': 'application/json', 'x-mock-signature': 'bad' });
    expect(forged.status).toBe(401);
  });
});

describe('auto-delivery with escrow held until confirmation', () => {
  it('captures into escrow, auto-delivers encrypted goods, and splits on buyer confirmation', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });

    // Webhook endpoint for the seller.
    const ep = await seller.api.post('/v1/developer/webhooks', { url: 'https://merchant.example/hooks', events: ['order.created', 'order.delivered', 'order.completed', 'offer.low_stock'] });
    expect(ep.status).toBe(201);
    const secret: string = ep.body.secret;

    const offer = await makeOffer(seller, { priceCents: 25_00, lowStockThreshold: 1 });
    const upload = await seller.api.post(`/v1/offers/${offer.id}/inventory`, { format: 'txt', content: 'KEY-AAA\nKEY-BBB\nKEY-AAA\nKEY-CCC\n' });
    expect(upload.body).toEqual({ added: 3, duplicates: 1, available: 3 });

    // Stored ciphertext never contains the plaintext.
    const raw = await h.ctx.db.query('SELECT ciphertext FROM inventory_items WHERE offer_id = $1', [offer.id]);
    expect(raw.rows.every((r) => !r.ciphertext.includes('KEY-'))).toBe(true);

    const order = await buyAndPay(h, buyer, offer.id, 2);
    const detail = (await buyer.api.get(`/v1/orders/${order.id}`)).body;
    expect(detail.status).toBe('delivered');
    // Standard goods are held until the buyer confirms: no deadline, no auto-release (release-rule.test.ts).
    expect(detail.protection).toBe('until_confirmed');
    expect(detail.protection_ends_at).toBeNull();
    expect(detail.commission_bps).toBe(PROMO_BPS);
    expect(detail.amount_cents).toBe(grossUp(50_00, PROMO_BPS)); // 52.64: the seller's 50.00 plus 5% grossed up

    const items = (await buyer.api.get(`/v1/orders/${order.id}/items`)).body;
    expect(items.map((i: any) => i.content)).toEqual(['KEY-AAA', 'KEY-BBB']);
    expect((await seller.api.get(`/v1/orders/${order.id}/items`)).status).toBe(404);

    expect(await platformBalance('escrow')).toBe(52_64);
    expect(await sellerAvailable(h.ctx.db, seller.id)).toBe(0);

    const confirm = await buyer.api.post(`/v1/orders/${order.id}/confirm`);
    expect(confirm.status).toBe(200);

    // The seller receives their price exactly; the 2.64 commission is split treasury / reserve (10%) / VAT.
    expect(await sellerAvailable(h.ctx.db, seller.id)).toBe(50_00);
    expect(await platformBalance('escrow')).toBe(0);
    // Commission is VAT-inclusive: the platform-country VAT inside it (IE 23%: 2.64 * 23/123) is owed to the tax office.
    expect((await platformBalance('treasury')) + (await platformBalance('reserve')) + (await platformBalance('tax_payable'))).toBe(2_64);
    expect(await platformBalance('reserve')).toBe(26);
    expect(await platformBalance('tax_payable')).toBe(49);

    // Webhooks: signed, idempotency key, delivered.
    const received: Array<{ headers: Record<string, string>; body: string }> = [];
    const fakeFetch = (async (_url: string, init: any) => {
      received.push({ headers: init.headers, body: init.body });
      return new Response('ok', { status: 200 });
    }) as typeof fetch;
    await dispatchDueWebhooks(h.ctx, { fetchImpl: fakeFetch });
    const types = received.map((r) => JSON.parse(r.body).type).sort();
    expect(types).toEqual(['offer.low_stock', 'order.completed', 'order.created', 'order.delivered']);
    for (const r of received) {
      expect(r.headers['X-Hook-Signature']).toBe(createHmac('sha256', secret).update(r.body).digest('hex'));
      expect(r.headers['Idempotency-Key']).toBe(JSON.parse(r.body).id);
    }
  });

  it('releases escrow automatically when the inspection window lapses', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller, { categorySlug: 'gift-cards', priceCents: 100_00 });
    await seller.api.post(`/v1/offers/${offer.id}/inventory`, { format: 'json', content: '["GC-1"]' });
    const order = await buyAndPay(h, buyer, offer.id);

    await runJobsOnce(h.ctx);
    expect((await buyer.api.get(`/v1/orders/${order.id}`)).body.status).toBe('delivered');

    await endWindowAndRelease(h, order.id); // no auto-release (Round 20): staff release once the window is over
    const done = (await buyer.api.get(`/v1/orders/${order.id}`)).body;
    expect(done.status).toBe('completed');
    expect(done.commission_bps).toBe(PROMO_BPS);
    expect(done.amount_cents).toBe(grossUp(100_00, PROMO_BPS));
    expect(await sellerAvailable(h.ctx.db, seller.id)).toBe(100_00);
  });

  it('expires unpaid orders and returns reserved stock', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller);
    await seller.api.post(`/v1/offers/${offer.id}/inventory`, { format: 'txt', content: 'ONLY-ONE' });
    const res = await buyer.api.post('/v1/orders', { offerId: offer.id, acceptTos: true });
    expect((await buyer.api.get(`/v1/offers/${offer.id}`)).body.stock).toBe(0);
    await h.ctx.db.query(`UPDATE orders SET payment_expires_at = now() - interval '1 second' WHERE id = $1`, [res.body.order.id]);
    await runJobsOnce(h.ctx);
    expect((await buyer.api.get(`/v1/orders/${res.body.order.id}`)).body.status).toBe('cancelled');
    expect((await buyer.api.get(`/v1/offers/${offer.id}`)).body.stock).toBe(1);
  });

  it('replays the same order for a repeated Idempotency-Key', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller);
    await seller.api.post(`/v1/offers/${offer.id}/inventory`, { format: 'txt', content: 'A\nB' });
    const a = await buyer.api.post('/v1/orders', { offerId: offer.id, acceptTos: true }, { 'idempotency-key': 'k-1' });
    const b = await buyer.api.post('/v1/orders', { offerId: offer.id, acceptTos: true }, { 'idempotency-key': 'k-1' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.order.id).toBe(a.body.order.id);
  });
});

describe('game accounts: 14-day insurance, security changeover, disputes', () => {
  it('requires the security checklist before early confirmation', async () => {
    const seller = await makeUser(h, { tier: 2, name: 'Sam Seller' });
    const buyer = await makeUser(h, { tier: 1 });
    const admin = await makeUser(h, { tier: 2, role: 'admin' });
    const offer = await makeOffer(seller, { categorySlug: 'accounts', title: 'Lvl 80 main', priceCents: 300_00, deliveryMode: 'manual' });
    expect(offer.high_risk_secondary).toBe(true);

    // Original Owner Proof -> verified listing.
    const proof = await seller.api.post(`/v1/offers/${offer.id}/owner-proof`, {
      registrationEmail: 'orig@example.com', registrationDate: '2015-03-01', billingName: 'Sam Seller', evidence: { cdKey: 'XXXX' },
    });
    expect(proof.status).toBe(201);
    await admin.api.post(`/v1/admin/owner-proofs/${proof.body.id}/review`, { approve: true });
    expect((await buyer.api.get(`/v1/offers/${offer.id}`)).body.high_risk_secondary).toBe(false);

    const order = await buyAndPay(h, buyer, offer.id);
    let detail = (await buyer.api.get(`/v1/orders/${order.id}`)).body;
    expect(detail.status).toBe('paid');
    expect(detail.protection).toBe('insurance_14d');
    expect(detail.commission_bps).toBe(PROMO_BPS);
    expect(detail.seller_protected).toBe(true);

    expect((await buyer.api.post(`/v1/orders/${order.id}/deliver`, { payload: 'x' })).status).toBe(403);
    await seller.api.post(`/v1/orders/${order.id}/deliver`, { payload: '{"login":"main80","password":"s3cret"}' });
    detail = (await buyer.api.get(`/v1/orders/${order.id}`)).body;
    expect(detail.status).toBe('delivered');
    const days = (new Date(detail.protection_ends_at).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.99);
    expect((await buyer.api.get(`/v1/orders/${order.id}/items`)).body[0].content).toContain('main80');

    const early = await buyer.api.post(`/v1/orders/${order.id}/confirm`);
    expect(early.body.error.code).toBe('checklist_incomplete');
    for (const item of detail.checklist.items) {
      await buyer.api.patch(`/v1/orders/${order.id}/checklist`, { key: item.key, done: true });
    }
    expect((await buyer.api.post(`/v1/orders/${order.id}/confirm`)).status).toBe(200);
    expect(await sellerAvailable(h.ctx.db, seller.id)).toBe(300_00);
  });

  it('freezes escrow on dispute and refunds the buyer when the arbiter rules for them', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const arbiter = await makeUser(h, { tier: 2, role: 'arbiter' });
    const offer = await makeOffer(seller, { categorySlug: 'accounts', priceCents: 120_00, deliveryMode: 'manual' });
    const order = await buyAndPay(h, buyer, offer.id);
    await seller.api.post(`/v1/orders/${order.id}/deliver`, { payload: 'creds' });

    const escrowBefore = await platformBalance('escrow');
    const d = await buyer.api.post(`/v1/orders/${order.id}/dispute`, { reason: 'Original owner recovered the account on day 3' });
    expect(d.status).toBe(200);

    // Auto-release must not happen while disputed.
    await h.ctx.db.query(`UPDATE orders SET protection_ends_at = now() - interval '1 day' WHERE id = $1`, [order.id]);
    await runJobsOnce(h.ctx);
    expect((await buyer.api.get(`/v1/orders/${order.id}`)).body.status).toBe('disputed');

    expect((await buyer.api.post(`/v1/admin/disputes/${d.body.id}/resolve`, { outcome: 'buyer', note: 'x' })).status).toBe(403);
    const r = await arbiter.api.post(`/v1/admin/disputes/${d.body.id}/resolve`, { outcome: 'buyer', note: 'Recovery confirmed by chat evidence' });
    expect(r.status).toBe(200);
    const final = (await buyer.api.get(`/v1/orders/${order.id}`)).body;
    expect(final.status).toBe('refunded');
    expect(await platformBalance('escrow')).toBe(escrowBefore - order.amount_cents);
    expect(order.amount_cents).toBe(grossUp(120_00, PROMO_BPS));
    expect(await sellerAvailable(h.ctx.db, seller.id)).toBe(0);

    // Chat contains the full, verifiable record.
    const verify = await arbiter.api.get(`/v1/chat/rooms/${final.room_id}/verify`);
    expect(verify.body.valid).toBe(true);
  });
});

describe('ledger integrity', () => {
  it('every posting balances to zero', async () => {
    const { rows } = await h.ctx.db.query('SELECT txn_id, SUM(amount_cents)::bigint AS s FROM ledger_entries GROUP BY txn_id HAVING SUM(amount_cents) <> 0');
    expect(rows).toEqual([]);
  });

  it('ledger entries are append-only', async () => {
    await expect(h.ctx.db.query('UPDATE ledger_entries SET amount_cents = 0')).rejects.toThrow(/append-only/);
    await expect(h.ctx.db.query('DELETE FROM order_events')).rejects.toThrow(/append-only/);
  });
});
