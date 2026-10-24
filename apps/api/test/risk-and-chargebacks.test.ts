import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountId, balance, sellerAvailable } from '../src/domain/ledger.js';
import { MockPaymentProvider } from '../src/providers/payments/mock.js';
import { endWindowAndRelease, buyAndPay, client, makeOffer, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

const reserve = async () => balance(h.ctx.db, await accountId(h.ctx.db, 'reserve', 'USD'));

describe('syndicate risk scoring (graph fraud engine)', () => {
  it('freezes a new seller receiving money from a cluster of linked buyer accounts', async () => {
    const seller = await makeUser(h, { tier: 2, ip: '203.0.113.10', device: 'seller-device' });
    const offer = await makeOffer(seller, { priceCents: 150_00 });
    await seller.api.post(`/v1/offers/${offer.id}/inventory`, { format: 'txt', content: Array.from({ length: 10 }, (_, i) => `K${i}`).join('\n') });

    // Five "different" buyers — all on one device fingerprint and one /24 proxy subnet.
    const buyers = [];
    for (let i = 0; i < 5; i++) buyers.push(await makeUser(h, { tier: 1, device: 'farm-device-7', ip: `198.51.100.${20 + i}` }));
    const orders = [];
    for (const b of buyers) orders.push(await buyAndPay(h, b, offer.id));

    const first = (await buyers[0]!.api.get(`/v1/orders/${orders[0]!.id}`)).body;
    const last = (await buyers[4]!.api.get(`/v1/orders/${orders[4]!.id}`)).body;
    expect(first.risk_score).toBeLessThan(0.5);
    expect(first.status).toBe('delivered');
    expect(last.risk_score).toBeGreaterThanOrEqual(0.8);
    expect(last.status).toBe('paid'); // auto-delivery withheld pending review
    expect(last.escrow_frozen).toBe(true);
    // All of the seller's open escrows are frozen, not just the triggering one.
    expect((await buyers[0]!.api.get(`/v1/orders/${orders[0]!.id}`)).body.escrow_frozen).toBe(true);
    expect((await seller.api.get('/v1/seller/dashboard')).body.withdrawalsFrozen).toBe(true);
    expect((await buyers[0]!.api.post(`/v1/orders/${orders[0]!.id}/confirm`)).status).toBe(423);

    const admin = await makeUser(h, { tier: 2, role: 'admin' });
    const flags = (await admin.api.get('/v1/admin/risk-flags')).body;
    const sellerFlag = flags.find((f: any) => f.user_id === seller.id);
    expect(sellerFlag.reasons.map((r: any) => r.code)).toEqual(expect.arrayContaining(['buyer_syndicate_cluster', 'new_seller']));
  });

  it('flags buyer and seller sharing a device (self-dealing)', async () => {
    const seller = await makeUser(h, { tier: 2, device: 'same-laptop' });
    const buyer = await makeUser(h, { tier: 1, device: 'same-laptop' });
    const offer = await makeOffer(seller);
    await seller.api.post(`/v1/offers/${offer.id}/inventory`, { format: 'txt', content: 'X1' });
    const order = await buyAndPay(h, buyer, offer.id);
    const o = (await buyer.api.get(`/v1/orders/${order.id}`)).body;
    expect(o.risk_score).toBeGreaterThanOrEqual(0.5);
    expect(o.escrow_frozen).toBe(true);
  });

  it('lets an admin clear a false positive and unfreeze funds', async () => {
    const seller = await makeUser(h, { tier: 2, device: 'shared-cafe-pc' });
    const buyer = await makeUser(h, { tier: 1, device: 'shared-cafe-pc' });
    const admin = await makeUser(h, { tier: 2, role: 'admin' });
    const offer = await makeOffer(seller);
    await seller.api.post(`/v1/offers/${offer.id}/inventory`, { format: 'txt', content: 'Y1' });
    const order = await buyAndPay(h, buyer, offer.id);
    const flags = (await admin.api.get('/v1/admin/risk-flags')).body.filter((f: any) => f.order_id === order.id);
    for (const f of flags) await admin.api.post(`/v1/admin/risk-flags/${f.id}/review`, { decision: 'clear' });
    expect((await buyer.api.get(`/v1/orders/${order.id}`)).body.escrow_frozen).toBe(false);
  });
});

describe('withdrawals', () => {
  it('pays out available balance and refuses overdrafts', async () => {
    const seller = await makeUser(h, { tier: 2 });
    await h.ctx.db.query('UPDATE users SET payout_hold_days = 0 WHERE id = $1', [seller.id]); // holds are tested in payout-holds.test.ts
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller, { priceCents: 40_00 });
    await seller.api.post(`/v1/offers/${offer.id}/inventory`, { format: 'txt', content: 'W1' });
    const order = await buyAndPay(h, buyer, offer.id);
    await buyer.api.post(`/v1/orders/${order.id}/confirm`);
    const available = await sellerAvailable(h.ctx.db, seller.id);
    expect((await seller.api.post('/v1/seller/withdrawals', { amountCents: available })).body.error.code).toBe('no_payout_account');

    // Payout onboarding through the (mock) PSP-hosted flow.
    const link = await seller.api.post('/v1/seller/payout-account');
    expect((await seller.api.get('/v1/seller/payout-account')).body).toMatchObject({ connected: true, payoutsEnabled: false });
    const path = new URL(link.body.url).pathname + new URL(link.body.url).search;
    expect((await client(h.app).get(path, { accept: 'application/json' })).body.payoutsEnabled).toBe(true);
    expect((await seller.api.get('/v1/seller/payout-account')).body.payoutsEnabled).toBe(true);
    const evil = path.replace(/return=[^&]+/, 'return=' + encodeURIComponent('https://evil.example/'));
    expect((await client(h.app).get(evil)).status).toBe(400);

    expect((await seller.api.post('/v1/seller/withdrawals', { amountCents: available + 1 })).status).toBe(400);
    const w = await seller.api.post('/v1/seller/withdrawals', { amountCents: available });
    expect(w.status).toBe(201);
    expect(w.body.status).toBe('paid');
    expect(await sellerAvailable(h.ctx.db, seller.id)).toBe(0);
    expect((await buyer.api.post('/v1/seller/withdrawals', { amountCents: 1 })).body.error.code).toBe('kyc_required');
  });
});

describe('chargeback shield & automated representment', () => {
  it('builds a reason-code-specific packet and absorbs the loss from the reserve for protected sellers', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1, device: 'buyer-phone' });
    const admin = await makeUser(h, { tier: 2, role: 'admin' });
    const offer = await makeOffer(seller, { priceCents: 60_00 });
    await seller.api.post(`/v1/offers/${offer.id}/inventory`, { format: 'txt', content: 'P1\nP2' });

    // A prior, undisputed purchase from the same device strengthens a fraud (10.4) response.
    const prior = await buyAndPay(h, buyer, offer.id);
    await buyer.api.post(`/v1/orders/${prior.id}/confirm`);
    const order = await buyAndPay(h, buyer, offer.id, 1, { billingCountry: 'DE' });
    await buyer.api.post(`/v1/orders/${order.id}/confirm`);

    const sellerBefore = await sellerAvailable(h.ctx.db, seller.id);
    const reserveBefore = await reserve();
    const cb = await admin.api.post('/v1/admin/chargebacks', { orderId: order.id, network: 'visa', reasonCode: '10.4', amountCents: 60_00, disputeRef: 'dp_test_1' });
    expect(cb.status).toBe(201);
    expect(cb.body.category).toBe('fraud');
    const respondDays = (new Date(cb.body.respond_by).getTime() - Date.now()) / 86_400_000;
    expect(Math.round(respondDays)).toBe(30);

    expect(await sellerAvailable(h.ctx.db, seller.id)).toBe(sellerBefore); // Chargeback Shield
    expect(await reserve()).toBe(reserveBefore - 60_00);

    const row = (await h.ctx.db.query('SELECT status, evidence, packet_pdf FROM chargebacks WHERE id = $1', [cb.body.id])).rows[0];
    expect(row.status).toBe('submitted');
    expect(row.packet_pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(row.evidence.packet.specific).toMatchObject({ avs_result: 'pass/pass', cvv_result: 'pass', billing_country: 'DE' });
    expect(row.evidence.packet.specific.prior_undisputed_orders_same_device_or_card).toHaveLength(1);
    expect((h.ctx.payments as MockPaymentProvider).submittedEvidence.at(-1)).toMatchObject({ disputeRef: 'dp_test_1' });

    const pdf = await admin.api.get(`/v1/admin/chargebacks/${cb.body.id}/packet.pdf`);
    expect(pdf.headers['content-type']).toBe('application/pdf');

    // Issuer rules in our favour: the reserve is made whole via the signed PSP webhook.
    const mock = h.ctx.payments as MockPaymentProvider;
    const body = JSON.stringify({ type: 'chargeback.closed', disputeRef: 'dp_test_1', won: true });
    const hook = await client(h.app).post('/v1/payments/webhook/mock', body, { 'content-type': 'application/json', 'x-mock-signature': mock.sign(body) });
    expect(hook.status).toBe(200);
    expect(await reserve()).toBe(reserveBefore);
  });

  it('debits the seller for High Risk - Secondary Market listings and uses Not-as-Described evidence', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const admin = await makeUser(h, { tier: 2, role: 'admin' });
    const offer = await makeOffer(seller, { categorySlug: 'accounts', priceCents: 80_00, deliveryMode: 'manual' });
    const order = await buyAndPay(h, buyer, offer.id);
    await seller.api.post(`/v1/orders/${order.id}/deliver`, { payload: 'acc' });
    await endWindowAndRelease(h, order.id);
    const net = await sellerAvailable(h.ctx.db, seller.id);
    expect(net).toBe(80_00); // the seller keeps their price; the buyer paid 84.22

    const cb = await admin.api.post('/v1/admin/chargebacks', { orderId: order.id, network: 'mastercard', reasonCode: '4853', amountCents: order.amount_cents });
    expect(cb.body.category).toBe('not_as_described');
    expect(await sellerAvailable(h.ctx.db, seller.id)).toBe(0);
    const row = (await h.ctx.db.query('SELECT status, evidence FROM chargebacks WHERE id = $1', [cb.body.id])).rows[0];
    expect(row.status).toBe('packet_ready'); // no provider ref -> kept for manual submission
    expect(row.evidence.allocation).toEqual({ seller_available: net, reserve: order.amount_cents - net });
    expect(row.evidence.packet.specific.listing_snapshot_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.evidence.packet.specific.customer_opened_platform_dispute).toBe(false);
  });
});
