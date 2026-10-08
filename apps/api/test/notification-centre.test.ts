import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatchInbox } from '../src/domain/inbox.js';
import { issueMonthlyInvoices, monthStart } from '../src/domain/invoices.js';
import { queueProtectionReminders } from '../src/domain/notifications.js';
import type { MockPaymentProvider } from '../src/providers/payments/mock.js';
import { FakePush } from '../src/providers/push.js';
import { buyAndPay, client, makeOffer, makeUser, setup, type Harness } from './helpers.js';

const push = new FakePush();
let h: Harness;
const live: Array<{ channel: string; payload: any }> = [];
beforeAll(async () => {
  h = await setup({}, { push });
  h.ctx.pubsub.onMessage((channel, payload) => live.push({ channel, payload }));
});
afterAll(async () => h.close());

const FCM = (n: string) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } });

describe('notification centre', () => {
  it('puts every notification in the inbox with a link, counts unread, and marks read', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller, { categorySlug: 'boosting', deliveryMode: 'manual', stock: 2, title: 'Rank boost' });
    const order = await buyAndPay(h, buyer, offer.id);

    const inbox = (await buyer.api.get('/v1/me/notifications')).body;
    const paid = inbox.items.find((i: any) => i.template === 'order_paid');
    expect(paid).toMatchObject({ title: 'Payment received for Rank boost', link: `/orders/${order.id}`, read_at: null, category: 'orders' });
    expect(paid.body).toMatch(/held in escrow/);
    expect(paid.body).not.toMatch(/http|\u0000/);
    expect(inbox.unread).toBeGreaterThanOrEqual(1);
    expect((await seller.api.get('/v1/me/notifications')).body.items.map((i: any) => i.template)).toContain('seller_new_order');

    expect((await buyer.api.post(`/v1/me/notifications/${paid.id}/read`)).body.unread).toBe(inbox.unread - 1);
    expect((await seller.api.post(`/v1/me/notifications/${paid.id}/read`)).status).toBe(404); // not theirs
    await buyer.api.post('/v1/me/notifications/read-all');
    expect((await buyer.api.get('/v1/me/notifications/unread-count')).body).toEqual({ unread: 0 });
  });

  it('keeps secrets out of the inbox and doesn’t duplicate deduplicated notifications', async () => {
    const u = await makeUser(h);
    await client(h.app).post('/v1/auth/password/forgot', { email: u.email });
    expect((await u.api.get('/v1/me/notifications')).body.items.map((i: any) => i.template)).not.toContain('password_reset');

    const seller = await makeUser(h, { tier: 2 });
    const offer = await makeOffer(seller);
    await seller.api.post(`/v1/offers/${offer.id}/inventory`, { format: 'txt', content: 'R1' });
    const order = await buyAndPay(h, u, offer.id);
    await h.ctx.db.query(`UPDATE orders SET protection_ends_at = now() + interval '12 hours' WHERE id = $1`, [order.id]);
    await queueProtectionReminders(h.ctx);
    await queueProtectionReminders(h.ctx);
    const reminders = (await u.api.get('/v1/me/notifications')).body.items.filter((i: any) => i.template === 'protection_ending');
    expect(reminders).toHaveLength(1);
  });

  it('delivers live to open tabs and by Web Push, honouring push preferences and dropping dead subscriptions', async () => {
    const u = await makeUser(h, { tier: 1 });
    expect((await client(h.app).get('/v1/push/config')).body).toEqual({ enabled: true, vapidPublicKey: 'fake-vapid-public-key' });
    expect((await u.api.post('/v1/me/push-subscriptions', { ...FCM('x'), endpoint: 'http://fcm.googleapis.com/x' })).body.error.code).toBe('invalid_endpoint');
    expect((await u.api.post('/v1/me/push-subscriptions', { ...FCM('x'), endpoint: 'https://169.254.169.254/latest' })).body.error.code).toBe('invalid_endpoint');
    expect((await u.api.post('/v1/me/push-subscriptions', FCM(`phone-${u.id}`))).status).toBe(201);
    expect((await u.api.post('/v1/me/push-subscriptions', FCM(`laptop-${u.id}`))).status).toBe(201);
    await dispatchInbox(h.ctx); // flush anything older

    const seller = await makeUser(h, { tier: 2 });
    const offer = await makeOffer(seller, { title: 'Push test key' });
    await seller.api.post(`/v1/offers/${offer.id}/inventory`, { format: 'txt', content: 'P1\nP2' });
    live.length = 0;
    push.sent.length = 0;
    const order = await buyAndPay(h, u, offer.id);
    await dispatchInbox(h.ctx);

    const toU = live.filter((m) => m.channel === `user:${u.id}` && m.payload.event === 'inbox.new');
    expect(toU.map((m) => m.payload.data.title)).toContain('Payment received for Push test key');
    const pushed = push.sent.filter((p) => p.endpoint.endsWith(u.id));
    expect(pushed.length).toBeGreaterThanOrEqual(2); // both devices
    expect(pushed.find((p) => p.msg.tag === 'order_paid')?.msg.url).toBe(`${h.ctx.cfg.PUBLIC_WEB_URL}/orders/${order.id}`);

    // Turn off purchase pushes; kill one device.
    await u.api.patch('/v1/me/push-preferences', { orders: false });
    push.gone.add(FCM(`laptop-${u.id}`).endpoint);
    push.sent.length = 0;
    await buyAndPay(h, u, offer.id);
    await dispatchInbox(h.ctx);
    expect(push.sent.filter((p) => p.endpoint.endsWith(u.id))).toHaveLength(0);
    const { rows } = await h.ctx.db.query(`SELECT push_status FROM inbox_items WHERE user_id = $1 AND template = 'order_paid' ORDER BY created_at DESC LIMIT 1`, [u.id]);
    expect(rows[0].push_status).toBe('skipped');

    await u.api.patch('/v1/me/push-preferences', { orders: true });
    await buyAndPay(h, u, (await makeOffer(seller, { categorySlug: 'boosting', deliveryMode: 'manual', stock: 1 })).id);
    await dispatchInbox(h.ctx);
    const devices = (await u.api.get('/v1/me/push-subscriptions')).body;
    expect(devices).toHaveLength(1); // the gone laptop was removed
    expect(devices[0].last_success_at).toBeTruthy();
  });
});

describe('payout and invoice webhooks', () => {
  it('tells merchants when payouts succeed or fail and when invoices are issued', async () => {
    const seller = await makeUser(h, { tier: 2 });
    await h.ctx.db.query(`UPDATE users SET stripe_account_id = 'acct_w', payouts_enabled = true, payout_hold_days = 0 WHERE id = $1`, [seller.id]);
    await seller.api.post('/v1/developer/webhooks', { url: 'https://merchant.example/hook', events: ['payout.paid', 'payout.failed', 'invoice.issued'] });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller, { categorySlug: 'boosting', deliveryMode: 'manual', stock: 1, priceCents: 30_00 });
    const order = await buyAndPay(h, buyer, offer.id);
    await seller.api.post(`/v1/orders/${order.id}/deliver`, { payload: 'done' });
    await buyer.api.post(`/v1/orders/${order.id}/confirm`);

    const mock = h.ctx.payments as MockPaymentProvider;
    mock.faults.payout = 'account_closed';
    expect((await seller.api.post('/v1/seller/withdrawals', { amountCents: 10_00 })).body.error.code).toBe('payout_failed');
    mock.faults = {};
    const w = await seller.api.post('/v1/seller/withdrawals', { amountCents: 10_00 });
    expect(w.status).toBe(201);
    await issueMonthlyInvoices(h.ctx, monthStart(new Date()));

    const { rows } = await h.ctx.db.query(
      `SELECT d.event_type, d.payload FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id WHERE e.user_id = $1 ORDER BY d.created_at`,
      [seller.id],
    );
    expect(rows.map((r) => r.event_type)).toEqual(['payout.failed', 'payout.paid', 'invoice.issued']);
    expect(rows[0].payload.data).toMatchObject({ amount_cents: 10_00, status: 'failed', failure_reason: 'account_closed' });
    expect(rows[1].payload.data).toMatchObject({ withdrawal_id: w.body.id, status: 'paid', provider_ref: expect.stringMatching(/^mock_tr_/) });
    expect(rows[2].payload.data).toMatchObject({ currency: 'USD', number: expect.stringMatching(/^BZ-/) });

    const titles = (await seller.api.get('/v1/me/notifications')).body.items.map((i: any) => i.template);
    expect(titles).toEqual(expect.arrayContaining(['withdrawal_failed', 'withdrawal_paid', 'invoice_issued']));

    const key = (await seller.api.post('/v1/developer/api-keys', { name: 'books', scopes: ['reports:read'] })).body.key;
    const invoices = (await client(h.app, key).get('/v1/merchant/invoices')).body;
    expect(invoices).toHaveLength(1);
    const pdf = await client(h.app, key).get(`/v1/merchant/invoices/${invoices[0].id}/pdf`);
    expect(String(pdf.body).slice(0, 4)).toBe('%PDF');
  });
});
