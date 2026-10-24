import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buyAndPay, client, makeOffer, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

describe('ban vs suspend', () => {
  it('suspensions can end on their own; bans never do and only the Lead lifts them', async () => {
    const compliance = await makeUser(h, { role: 'compliance' });
    const lead = await makeUser(h, { role: 'lead' });
    const u = await makeUser(h, { tier: 1 });
    const seller = await makeUser(h, { tier: 2 });
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 5 });

    // A 3-day suspension: blocked now, back when the time has passed.
    const sus = await compliance.api.post(`/v1/admin/users/${u.id}/suspend`, { reason: 'Rude in chat', days: 3 });
    expect(sus.status, JSON.stringify(sus.body)).toBe(200);
    expect(sus.body.until).toBeTruthy();
    expect((await u.api.post('/v1/orders', { offerId: offer.id, quantity: 1, acceptTos: true })).body.error.code).toBe('suspended');
    await h.ctx.db.query(`UPDATE users SET suspended_until = now() - interval '1 minute' WHERE id = $1`, [u.id]);
    expect((await u.api.get('/v1/me')).body.user.status).toBe('active'); // lifted on the next request
    expect((await u.api.post('/v1/orders', { offerId: offer.id, quantity: 1, acceptTos: true })).status).toBe(201);

    // A ban: no end time, sessions revoked, not softened into a suspension, lifted only by the Lead.
    expect((await compliance.api.post(`/v1/admin/users/${u.id}/ban`, { reason: 'Chargeback fraud' })).body.banned).toBe(true);
    expect((await u.api.get('/v1/me')).status).toBe(401);
    const row = async () => (await h.ctx.db.query('SELECT status, banned_at, suspended_until FROM users WHERE id = $1', [u.id])).rows[0];
    expect(await row()).toMatchObject({ status: 'banned', suspended_until: null });
    expect((await row()).banned_at).toBeTruthy();
    expect((await compliance.api.post(`/v1/admin/users/${u.id}/suspend`, { reason: 'oops', days: 1 })).body.error.code).toBe('banned');
    expect((await compliance.api.post(`/v1/admin/users/${u.id}/reinstate`, { note: 'Appeal accepted' })).body.error.code).toBe('insufficient_permission');
    expect((await lead.api.post(`/v1/admin/users/${u.id}/reinstate`, { note: 'Appeal accepted' })).body.active).toBe(true);
    expect((await row()).status).toBe('active');
  });

  it('off-platform: staff-confirmed contact shares walk the ladder (a week\'s suspension); an unambiguous payment link bans', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h);
    const mod = await makeUser(h, { role: 'support' });
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 2 });
    const order = await buyAndPay(h, buyer, offer.id);
    const { room_id } = (await buyer.api.get(`/v1/orders/${order.id}`)).body;
    // Round 22: blocked and queued, no strike, until staff confirm.
    expect((await buyer.api.post(`/v1/chat/rooms/${room_id}/messages`, { body: 'my discord is pat#1' })).body.error.details.action).toBe('queue');
    expect((await buyer.api.post(`/v1/chat/rooms/${room_id}/messages`, { body: 'or telegram maybe' })).body.error.details.action).toBe('queue');
    expect((await h.ctx.db.query('SELECT status FROM users WHERE id = $1', [buyer.id])).rows[0].status).toBe('active');
    const flags = (await mod.api.get('/v1/admin/moderation/chats')).body.filter((f: any) => f.user_id === buyer.id);
    expect((await mod.api.post(`/v1/admin/moderation/chats/${flags[0].id}`, { confirm: true })).body.action).toBe('warn');
    expect((await mod.api.post(`/v1/admin/moderation/chats/${flags[1].id}`, { confirm: true })).body.action).toBe('suspend');
    const b = (await h.ctx.db.query('SELECT status, suspended_until FROM users WHERE id = $1', [buyer.id])).rows[0];
    expect(b.status).toBe('suspended');
    expect(new Date(b.suspended_until).getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    expect((await seller.api.post(`/v1/chat/rooms/${room_id}/messages`, { body: 'pay me on paypal' })).body.error.details.action).toBe('queue');
    const r = await seller.api.post(`/v1/chat/rooms/${room_id}/messages`, { body: 'paypal.me/patgold' });
    expect(r.body.error.details.action).toBe('ban');
    expect((await h.ctx.db.query('SELECT status FROM users WHERE id = $1', [seller.id])).rows[0].status).toBe('banned');
  });
});

describe('referral and creator codes (CEO, Oct 24)', () => {
  const sellerAvailable = async (id: string) => Number((await h.ctx.db.query(`SELECT COALESCE(SUM(e.amount_cents), 0) AS s FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.kind = 'seller_available' AND a.owner_id = $1`, [id])).rows[0].s);
  const signUp = async (extra: Record<string, unknown>, headers: Record<string, string> = {}) => {
    const reg = await client(h.app, undefined, headers).post('/v1/auth/register', { email: `r20_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@example.com`, password: 'correct horse battery', displayName: 'Friend', acceptTerms: true, ...extra });
    if (reg.status !== 201) throw new Error(JSON.stringify(reg.body));
    await h.ctx.db.query(`UPDATE users SET kyc_tier = 1 WHERE id = $1`, [reg.body.user.id]);
    return { id: reg.body.user.id as string, api: client(h.app, reg.body.token, headers), codeApplied: reg.body.codeApplied };
  };
  const complete = async (buyer: { api: ReturnType<typeof client> }, seller: { api: ReturnType<typeof client> }, offerId: string) => {
    const o = await buyAndPay(h, buyer, offerId);
    await seller.api.post(`/v1/orders/${o.id}/deliver`, { payload: 'done' });
    const r = await buyer.api.post(`/v1/orders/${o.id}/confirm`);
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
    return o;
  };

  it('one code per user at sign-up; the code owner never earns on their own sales; rates are capped', async () => {
    const referrer = await makeUser(h, { tier: 2 });
    const { code } = (await referrer.api.get('/v1/me/referral')).body;
    const friend = await signUp({ code });
    expect(friend.codeApplied).toBe('referral');
    expect((await friend.api.get('/v1/me/referral')).body).toBeTruthy();
    // The referrer sells to their own referee: no reward.
    const own = await makeOffer(referrer, { deliveryMode: 'manual', stock: 5, priceCents: 50_00 });
    await complete(friend, referrer, own.id);
    await complete(friend, referrer, own.id);
    expect((await h.ctx.db.query(`SELECT count(*)::int AS n FROM referral_rewards WHERE referrer_id = $1 AND status = 'granted'`, [referrer.id])).rows[0].n).toBe(0);
    // Staff cannot set a share above 50% of the commission.
    const admin = await makeUser(h, { role: 'admin' });
    expect((await admin.api.put('/v1/admin/referral', { rateBps: 6000 })).status).toBe(400);
    expect((await admin.api.put('/v1/admin/referral', { rateBps: 2000 })).status).toBe(200);
  });

  it('accounts linked by subnet earn nothing; two first orders completing together count once; the 30-day window', async () => {
    const referrer = await makeUser(h, { tier: 1, ip: '203.0.113.9' });
    const { code } = (await referrer.api.get('/v1/me/referral')).body;
    const seller = await makeUser(h, { tier: 2 });
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 20, priceCents: 25_00 });

    // Same /24 as the referrer at sign-up → linked, blocked.
    const sock = await signUp({ code }, { 'x-forwarded-for': '203.0.113.77' });
    await complete(sock, seller, offer.id);
    await complete(sock, seller, offer.id);
    const sockRows = (await h.ctx.db.query(`SELECT status, reason FROM referral_rewards WHERE referee_id = $1 ORDER BY created_at`, [sock.id])).rows;
    expect(sockRows.map((r) => [r.status, r.reason])).toEqual([['blocked', 'linked_accounts'], ['blocked', 'linked_accounts']]);

    // Two orders paid and delivered, then confirmed at the same moment: exactly one is the "first". Round 22 (25): "active"
    // is measured when an order was placed, and both were placed before either completed, so the other earns nothing.
    const friend = await signUp({ code }, { 'x-forwarded-for': '198.51.100.5' });
    const a = await buyAndPay(h, friend, offer.id);
    const b = await buyAndPay(h, friend, offer.id);
    await seller.api.post(`/v1/orders/${a.id}/deliver`, { payload: 'a' });
    await seller.api.post(`/v1/orders/${b.id}/deliver`, { payload: 'b' });
    const [ra, rb] = await Promise.all([friend.api.post(`/v1/orders/${a.id}/confirm`), friend.api.post(`/v1/orders/${b.id}/confirm`)]);
    expect([ra.status, rb.status], JSON.stringify([ra.body, rb.body])).toEqual([200, 200]);
    const rewards = async () => (await h.ctx.db.query(`SELECT status, reason FROM referral_rewards WHERE referee_id = $1 ORDER BY created_at`, [friend.id])).rows.map((r) => `${r.status}:${r.reason ?? ''}`);
    expect((await rewards()).sort()).toEqual(['blocked:first_order', 'blocked:inactive']);
    expect(await sellerAvailable(referrer.id)).toBe(0);
    // An order placed after a completed one (within 30 days) earns.
    await complete(friend, seller, offer.id);
    expect(await rewards()).toContain('granted:');
    const earnedOnce = await sellerAvailable(referrer.id);
    expect(earnedOnce).toBeGreaterThan(0);

    // A comeback after 31+ days earns nothing; the next order within 30 days earns again.
    await h.ctx.db.query(`UPDATE orders SET completed_at = now() - interval '32 days' WHERE buyer_id = $1 AND status = 'completed'`, [friend.id]);
    await complete(friend, seller, offer.id);
    expect(await rewards()).toContain('blocked:inactive');
    expect(await sellerAvailable(referrer.id)).toBe(earnedOnce);
    await complete(friend, seller, offer.id);
    expect(await sellerAvailable(referrer.id)).toBe(earnedOnce * 2);
  });
});

describe('split disputes (Round 20)', () => {
  it('keeps the promo-funded part out of withdrawable credit, records commission tax, and shows what the seller received', async () => {
    const admin = await makeUser(h, { role: 'admin' });
    const arbiter = await makeUser(h, { tier: 2, role: 'arbiter' });
    const seller = await makeUser(h, { tier: 2 });
    await seller.api.put('/v1/seller/tax-profile', { country: 'DE', isBusiness: false }); // 19% on the commission
    const buyer = await makeUser(h, { tier: 1 });
    await admin.api.post('/v1/admin/promos', { code: 'SPLIT20', percentOff: 20, maxDiscountCents: 100_00 });
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 5, priceCents: 100_00 });
    const created = await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 1, acceptTos: true, promoCode: 'SPLIT20' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const order = created.body.order;
    expect(order.discount_cents).toBeGreaterThan(0);
    await client(h.app).post(`/v1/payments/mock/checkout/${order.payment_ref}/pay`, {}, { accept: 'application/json' });
    await seller.api.post(`/v1/orders/${order.id}/deliver`, { payload: 'half' });
    const d = (await buyer.api.post(`/v1/orders/${order.id}/dispute`, { reason: 'Half arrived', category: 'not_as_described' })).body;
    const refund = Math.round(order.amount_cents / 2);
    const res = await arbiter.api.post(`/v1/admin/disputes/${d.id}/resolve`, { outcome: 'split', refundCents: refund, note: 'Half delivered' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    // Buyer credit excludes the promo's share of the refund; that share went back to the treasury.
    const promoShare = Math.round((order.discount_cents * refund) / order.amount_cents);
    expect((await buyer.api.get('/v1/me/credit')).body.balanceCents).toBe(refund - promoShare);
    const row = (await h.ctx.db.query('SELECT commission_cents, commission_tax_cents, tax_rate_bps, tax_treatment, seller_received_cents FROM orders WHERE id = $1', [order.id])).rows[0];
    const released = order.amount_cents - refund;
    const commission = Math.round((Number(row.commission_cents) * released) / order.amount_cents);
    // No company yet (CFO B3): every commission is outside the scope of VAT, recorded on the split exactly like a full release.
    expect(row.tax_treatment).toBe('outside_scope');
    expect(Number(row.tax_rate_bps)).toBe(0);
    expect(Number(row.commission_tax_cents)).toBe(0);
    expect(Number(row.seller_received_cents)).toBe(released - commission);
    const wallet = (await seller.api.get('/v1/me/wallet')).body.entries.find((e: any) => e.kind === 'sale' && e.order_id === order.id);
    expect(wallet.amount_cents).toBe(released - commission);
    // Books balance: escrow emptied, every cent accounted for.
    const sums = (await h.ctx.db.query(`SELECT a.kind, SUM(e.amount_cents)::bigint AS s FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE e.order_id = $1 AND e.memo = 'dispute_split' GROUP BY a.kind`, [order.id])).rows;
    expect(sums.reduce((t, r) => t + Number(r.s), 0)).toBe(0);
    expect(sums.find((r) => r.kind === 'tax_payable')).toBeUndefined(); // nothing booked as VAT
  });
});

describe('damage limits (launch gate §4)', () => {
  it('kill switches pause withdrawals, orders, chat and sign-ups; a banner tells the app', async () => {
    const { forgetControlsCache } = await import('../src/domain/controls.js');
    const admin = await makeUser(h, { role: 'admin' });
    const support = await makeUser(h, { role: 'support' });
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 5, priceCents: 20_00 });
    const order = await buyAndPay(h, buyer, offer.id);
    const { room_id } = (await buyer.api.get(`/v1/orders/${order.id}`)).body;
    expect((await support.api.put('/v1/admin/controls', { pause_orders: true })).status).toBe(403);
    const on = await admin.api.put('/v1/admin/controls', { pause_orders: true, pause_chat: true, pause_signups: true, pause_withdrawals: true, pause_message: 'Back in 10 minutes.' });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    forgetControlsCache();
    expect((await client(h.app).get('/v1/features')).body.paused).toMatchObject({ orders: true, chat: true, signups: true, withdrawals: true, message: 'Back in 10 minutes.' });
    const blocked = await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 1, acceptTos: true });
    expect([blocked.status, blocked.body.error.code]).toEqual([503, 'orders_paused']);
    expect((await buyer.api.post(`/v1/chat/rooms/${room_id}/messages`, { body: 'hello' })).body.error.code).toBe('chat_paused');
    expect((await client(h.app).post('/v1/auth/register', { email: `p_${Date.now()}@example.com`, password: 'correct horse battery', displayName: 'Paused', acceptTerms: true })).body.error.code).toBe('signups_paused');
    expect((await seller.api.post('/v1/seller/withdrawals', { amountCents: 500 })).body.error.code).toBe('withdrawals_paused');
    // Existing orders still move: the seller delivers and the buyer confirms during a pause.
    expect((await seller.api.post(`/v1/orders/${order.id}/deliver`, { payload: 'done' })).status).toBe(200);
    expect((await buyer.api.post(`/v1/orders/${order.id}/confirm`)).status).toBe(200);
    await admin.api.put('/v1/admin/controls', { pause_orders: false, pause_chat: false, pause_signups: false, pause_withdrawals: false, pause_message: null });
    forgetControlsCache();
    expect((await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 1, acceptTos: true })).status).toBe(201);
    expect((await h.ctx.db.query(`SELECT count(*)::int AS n FROM admin_audit_log WHERE action = 'controls.update'`)).rows[0].n).toBeGreaterThanOrEqual(2);
  });

  it('beta limits: order size, new-account caps and the daily withdrawal cap', async () => {
    const { forgetControlsCache } = await import('../src/domain/controls.js');
    const admin = await makeUser(h, { role: 'admin' });
    await admin.api.put('/v1/admin/controls', { max_order_cents: 300_00, new_account_days: 7, new_account_max_order_cents: 50_00, new_account_max_open_orders: 2, max_withdrawal_day_cents: 100_00 });
    forgetControlsCache();
    const seller = await makeUser(h, { tier: 2 });
    const big = await makeOffer(seller, { deliveryMode: 'manual', stock: 5, priceCents: 350_00 });
    const mid = await makeOffer(seller, { deliveryMode: 'manual', stock: 5, priceCents: 80_00 });
    const small = await makeOffer(seller, { deliveryMode: 'manual', stock: 10, priceCents: 10_00 });
    const fresh = await makeUser(h, { tier: 1 }); // created now: a new account
    expect((await fresh.api.post('/v1/orders', { offerId: big.id, quantity: 1, acceptTos: true })).body.error.code).toBe('order_too_large');
    expect((await fresh.api.post('/v1/orders', { offerId: mid.id, quantity: 1, acceptTos: true })).body.error.code).toBe('new_account_limit');
    expect((await fresh.api.post('/v1/orders', { offerId: small.id, quantity: 1, acceptTos: true })).status).toBe(201);
    expect((await fresh.api.post('/v1/orders', { offerId: small.id, quantity: 1, acceptTos: true })).status).toBe(201);
    expect((await fresh.api.post('/v1/orders', { offerId: small.id, quantity: 1, acceptTos: true })).body.error.code).toBe('new_account_limit'); // 2 open orders
    const old = await makeUser(h, { tier: 1 });
    await h.ctx.db.query(`UPDATE users SET created_at = now() - interval '30 days' WHERE id = $1`, [old.id]);
    expect((await old.api.post('/v1/orders', { offerId: mid.id, quantity: 1, acceptTos: true })).status).toBe(201);
    expect((await old.api.post('/v1/orders', { offerId: big.id, quantity: 1, acceptTos: true })).body.error.code).toBe('order_too_large');

    // Withdrawals: $100 per day per user.
    await h.ctx.db.query(`UPDATE users SET stripe_account_id = 'acct_limit', payouts_enabled = true, payout_hold_days = 0 WHERE id = $1`, [seller.id]);
    for (let i = 0; i < 3; i++) {
      const o = await buyAndPay(h, old, small.id);
      await seller.api.post(`/v1/orders/${o.id}/deliver`, { payload: 'x' });
      await old.api.post(`/v1/orders/${o.id}/confirm`);
    }
    await h.ctx.db.query(`UPDATE users SET created_at = now() - interval '30 days' WHERE id = $1`, [seller.id]);
    // Give the seller enough balance by hand for the cap to be the binding limit.
    const { post, accountId } = await import('../src/domain/ledger.js');
    const { withTx } = await import('../src/db.js');
    await withTx(h.ctx.db, async (tx) => post(tx, [{ account: await accountId(tx, 'treasury', 'USD'), amountCents: -300_00 }, { account: await accountId(tx, 'seller_available', 'USD', seller.id), amountCents: 300_00 }], 'test_grant'));
    expect((await seller.api.post('/v1/seller/withdrawals', { amountCents: 60_00 })).status).toBe(201);
    const over = await seller.api.post('/v1/seller/withdrawals', { amountCents: 50_00 });
    expect(over.body.error.code).toBe('withdrawal_limit');
    expect(over.body.error.details).toMatchObject({ maxDayCents: 100_00, usedCents: 60_00 });
    expect((await seller.api.post('/v1/seller/withdrawals', { amountCents: 40_00 })).status).toBe(201);
    await admin.api.put('/v1/admin/controls', { max_order_cents: 100000000, new_account_days: 0, new_account_max_order_cents: 100_00, new_account_max_open_orders: 3, max_withdrawal_day_cents: 100000000 });
    forgetControlsCache();
  });

  it('alerts admins on failed payouts, unusual withdrawals and dispute or ban spikes, once per hour', async () => {
    const { detectOpsAlerts, sendOpsAlerts } = await import('../src/domain/opsAlerts.js');
    const admin = await makeUser(h, { role: 'admin' });
    const u = await makeUser(h, { tier: 2 });
    const before = (await detectOpsAlerts(h.ctx)).map((a) => a.key);
    await h.ctx.db.query(`INSERT INTO withdrawals (user_id, amount_cents, currency, status, failure_reason) VALUES ($1, 500, 'USD', 'failed', 'invalid address')`, [u.id]);
    await h.ctx.db.query(`INSERT INTO withdrawals (user_id, amount_cents, currency, status) VALUES ($1, 250000, 'USD', 'pending_approval')`, [u.id]);
    for (let i = 0; i < 3; i++) await h.ctx.db.query(`INSERT INTO withdrawals (user_id, amount_cents, currency, status) VALUES ($1, 100, 'USD', 'pending_approval')`, [u.id]);
    await h.ctx.db.query(`UPDATE users SET banned_at = now(), status = 'banned' WHERE id IN (SELECT id FROM users WHERE role = 'user' AND status = 'active' AND id <> $1 ORDER BY created_at DESC LIMIT 3)`, [u.id]);
    const keys = (await detectOpsAlerts(h.ctx)).map((a) => a.key);
    for (const k of ['payouts_failed', 'withdrawals_large', 'withdrawals_repeat', 'bans_spike']) expect(keys, before.join(',')).toContain(k);
    const sent = await sendOpsAlerts(h.ctx);
    expect(sent).toBeGreaterThan(0);
    const mine = async () => (await h.ctx.db.query(`SELECT count(*)::int AS n FROM notifications WHERE template = 'ops_alert' AND user_id = $1`, [admin.id])).rows[0].n;
    const n1 = await mine();
    expect(n1).toBeGreaterThanOrEqual(4);
    await sendOpsAlerts(h.ctx); // same hour: nothing new
    expect(await mine()).toBe(n1);
    await h.ctx.db.query(`DELETE FROM withdrawals WHERE user_id = $1`, [u.id]);
  });
});

describe('no VAT until a company exists (CFO B3)', () => {
  it('books no tax on any commission when PLATFORM_TAX_COUNTRY is unset, whatever the seller’s country', async () => {
    for (const country of ['DE', 'EG', 'FR']) {
      const seller = await makeUser(h, { tier: 2 });
      await seller.api.put('/v1/seller/tax-profile', { country, isBusiness: false });
      const buyer = await makeUser(h, { tier: 1 });
      const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 2, priceCents: 40_00 });
      const o = await buyAndPay(h, buyer, offer.id);
      await seller.api.post(`/v1/orders/${o.id}/deliver`, { payload: 'x' });
      await buyer.api.post(`/v1/orders/${o.id}/confirm`);
      const row = (await h.ctx.db.query('SELECT tax_treatment, tax_rate_bps, commission_tax_cents FROM orders WHERE id = $1', [o.id])).rows[0];
      expect({ ...row, commission_tax_cents: Number(row.commission_tax_cents), tax_rate_bps: Number(row.tax_rate_bps) }, country).toMatchObject({ tax_treatment: 'outside_scope', tax_rate_bps: 0, commission_tax_cents: 0 });
    }
    expect(Number((await h.ctx.db.query(`SELECT COALESCE(SUM(e.amount_cents), 0) AS s FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.kind = 'tax_payable'`)).rows[0].s)).toBe(0);
  });
});
