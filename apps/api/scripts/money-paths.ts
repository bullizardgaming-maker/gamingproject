/**
 * Staging money-path smoke test. Runs the launch money paths end to end over HTTP against a
 * running API in sandbox mode (SANDBOX_MODE=true, PAYMENT_PROVIDER=mock|nowpayments-sandbox):
 *
 *   API_URL=https://api-staging.example.com STAFF_EMAIL=... STAFF_PASSWORD=... npx tsx scripts/money-paths.ts
 *
 * Paths: pay · confirm · early confirm · staff release (24h rule) · dispute · withdraw (fee quote +
 * request) · double-click (same idempotency key twice, confirm twice) · duplicate webhook (mock
 * capture replayed) · chat filter (outside contact never delivered) · underpay (NOWPayments sandbox
 * only — reported as skipped on the mock provider; crypto-payments.test.ts covers it in CI).
 *
 * STAFF_EMAIL/STAFF_PASSWORD: a support or admin account on the target; without it the staff-release
 * step is skipped. Creates throwaway users and orders; run it against staging, never production.
 */
const API = (process.env.API_URL ?? 'http://127.0.0.1:4000').replace(/\/$/, '');
const PASSWORD = 'correct horse battery staple';
const run = Date.now().toString(36);

type Res = { status: number; body: any };
async function call(method: string, path: string, body?: unknown, token?: string | null, headers: Record<string, string> = {}): Promise<Res> {
  const res = await fetch(`${API}/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed: any = null;
  try {
    parsed = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, body: parsed };
}
const api = (token: string | null, extra: Record<string, string> = {}) => ({
  get: (p: string) => call('GET', p, undefined, token, extra),
  post: (p: string, b: unknown = {}) => call('POST', p, b, token, extra),
});

const results: Array<{ path: string; ok: boolean; note: string }> = [];
function report(path: string, ok: boolean, note = '') {
  results.push({ path, ok, note });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${path}${note ? ` — ${note}` : ''}`);
}
function expect(cond: unknown, path: string, note: string) {
  if (!cond) throw new Error(`${path}: ${note}`);
}

async function user(name: string, device: string) {
  const email = `mp-${run}-${name}@example.com`;
  const reg = await call('POST', '/auth/register', { email, password: PASSWORD, displayName: `MP ${name}` }, null, { 'x-device-fingerprint': device });
  if (reg.status !== 201) throw new Error(`register ${name}: ${JSON.stringify(reg.body)}`);
  const token: string = reg.body.token;
  const v = await call('POST', '/sandbox/verify-me', {}, token, { 'x-device-fingerprint': device });
  if (v.status !== 200) throw new Error(`verify-me ${name} (is SANDBOX_MODE on?): ${JSON.stringify(v.body)}`);
  return { id: reg.body.user.id as string, token, api: api(token, { 'x-device-fingerprint': device }) };
}

async function payMock(order: { payment_ref: string }) {
  const r = await fetch(`${API}/v1/payments/mock/checkout/${encodeURIComponent(order.payment_ref)}/pay`, { method: 'POST', headers: { accept: 'application/json' } });
  return r.status;
}

async function main() {
  const features = await call('GET', '/features');
  expect(features.status === 200 && features.body.sandbox, 'setup', 'target must run with SANDBOX_MODE=true');
  const seller = await user('seller', `dev-seller-${run}`);
  const buyer = await user('buyer', `dev-buyer-${run}`);
  const staff = process.env.STAFF_EMAIL
    ? await (async () => {
        const r = await call('POST', '/auth/login', { email: process.env.STAFF_EMAIL, password: process.env.STAFF_PASSWORD });
        if (r.status !== 200) throw new Error(`staff login: ${JSON.stringify(r.body)}`);
        return api(r.body.token);
      })()
    : null;

  const offer = (await seller.api.post('/offers', { categorySlug: 'currency', game: 'Albion Online', title: `Silver ${run}`, priceCents: 10_00, deliveryMode: 'manual', stock: 100, unitLabel: 'M', unitSize: 1_000_000, minQty: 1, attributes: { server: 'Europe' } })).body;
  expect(offer.id, 'setup', `listing: ${JSON.stringify(offer)}`);
  const order = async (extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    call('POST', '/orders', { offerId: offer.id, quantity: 1, acceptTos: true, characterName: 'MPChar', ...extra }, buyer.token, headers);

  // 1. pay → funds held
  try {
    const o = (await order()).body.order;
    const status = await payMock(o);
    expect(status === 200, 'pay', `mock capture ${status}`);
    const after = (await buyer.api.get(`/orders/${o.id}`)).body;
    expect(after.status === 'paid', 'pay', `status ${after.status}`);
    report('pay', true, `${after.ref} held in escrow`);

    // 2. duplicate webhook: the same capture replayed changes nothing
    const again = await payMock(o);
    const same = (await buyer.api.get(`/orders/${o.id}`)).body;
    expect(same.status === 'paid' && same.events.filter((e: any) => e.to_status === 'paid').length === 1, 'duplicate webhook', 'second capture must be idempotent');
    report('duplicate webhook', true, `replay answered ${again}, one paid event`);

    // 3. seller delivers, buyer confirms → released
    const d = await seller.api.post(`/orders/${o.id}/deliver`, { payload: 'sent in-game' });
    expect(d.status === 200, 'confirm', `deliver: ${JSON.stringify(d.body)} (DELIVERY_PROOF_REQUIRED should be false on staging smoke, or attach a proof)`);
    const c = await buyer.api.post(`/orders/${o.id}/confirm`, {});
    expect(c.status === 200, 'confirm', JSON.stringify(c.body));
    const dash = (await seller.api.get('/seller/dashboard')).body;
    report('confirm', (await buyer.api.get(`/orders/${o.id}`)).body.status === 'completed', `seller balance now ${JSON.stringify(dash.balances)}`);

    // 4. double-click confirm: the second call is a clean 409, nothing double-released
    const c2 = await buyer.api.post(`/orders/${o.id}/confirm`, {});
    report('double-click confirm', c2.status === 409, `second confirm → ${c2.status} ${c2.body?.error?.code}`);
  } catch (e: any) {
    report('pay/confirm', false, e.message);
  }

  // 5. double-click buy: same idempotency key twice → one order
  try {
    const key = `mp-${run}-dbl`;
    const a = await order({}, { 'idempotency-key': key });
    const b = await order({}, { 'idempotency-key': key });
    expect(a.status === 201, 'double-click buy', JSON.stringify(a.body));
    report('double-click buy', b.body?.order?.id === a.body.order.id && b.body.replayed === true, `second create replayed the same order (${b.status})`);
  } catch (e: any) {
    report('double-click buy', false, e.message);
  }

  // 6. early confirm: buyer confirms while still "paid"
  try {
    const o = (await order()).body.order;
    await payMock(o);
    const c = await buyer.api.post(`/orders/${o.id}/confirm`, {});
    const after = (await buyer.api.get(`/orders/${o.id}`)).body;
    report('early confirm', c.status === 200 && after.status === 'completed' && after.events.some((e: any) => e.reason === 'buyer_confirmed_early'), `reason ${after.events.at(-1)?.reason}`);
  } catch (e: any) {
    report('early confirm', false, e.message);
  }

  // 7. staff release: refused before 24h after delivery, allowed after (sandbox fast-forward)
  if (staff) {
    try {
      const o = (await order()).body.order;
      await payMock(o);
      await seller.api.post(`/orders/${o.id}/deliver`, { payload: 'sent' });
      const early = await staff.post(`/admin/orders/${o.id}/release`, { note: 'smoke: too early' });
      expect(early.status === 409, 'staff release', `release before 24h must be refused, got ${early.status}`);
      const ff = await seller.api.post(`/sandbox/orders/${o.id}/age-delivery`, { hours: 25 });
      expect(ff.status === 200, 'staff release', `fast-forward: ${JSON.stringify(ff.body)}`);
      const ok = await staff.post(`/admin/orders/${o.id}/release`, { note: 'smoke: proof checked, buyer silent 24h+' });
      report('staff release', ok.status === 200, `before 24h → ${early.body?.error?.code}; after → ${ok.status}`);
    } catch (e: any) {
      report('staff release', false, e.message);
    }
  } else report('staff release', true, 'skipped: set STAFF_EMAIL/STAFF_PASSWORD to run');

  // 8. dispute: escrow frozen, order disputed
  try {
    const o = (await order()).body.order;
    await payMock(o);
    await seller.api.post(`/orders/${o.id}/deliver`, { payload: 'sent' });
    const d = await buyer.api.post(`/orders/${o.id}/dispute`, { reason: 'Nothing arrived in my mailbox', category: 'not_delivered' });
    const after = (await buyer.api.get(`/orders/${o.id}`)).body;
    report('dispute', d.status === 200 && after.status === 'disputed', `escrow frozen, dispute ${after.dispute?.id ?? ''}`);
    const c = await buyer.api.post(`/orders/${o.id}/confirm`, {});
    report('confirm while disputed', c.status === 409, `→ ${c.status} ${c.body?.error?.code}`);
  } catch (e: any) {
    report('dispute', false, e.message);
  }

  // 9. withdraw: fee quote (6%, min $1.50) and the request path
  try {
    const q = (await seller.api.get('/seller/withdrawals/quote?amountCents=2000')).body;
    expect(q.feeCents === 150 && q.netCents === 1850, 'withdraw', `quote ${JSON.stringify(q)}`);
    const bal = (await seller.api.get('/seller/dashboard')).body.balances;
    const w = await seller.api.post('/seller/withdrawals', { amountCents: 2000 });
    const code = w.body?.error?.code;
    if (w.status === 503 && code === 'payouts_unavailable') report('withdraw', true, 'quote ok; the request needs the NOWPayments sandbox (mock provider has no payouts)');
    else if (code === 'insufficient_funds' && bal.withdrawableCents === 0 && bal.onHoldCents > 0) report('withdraw', true, `quote ok; released sales sit on the payout hold (PAYOUT_HOLD_DAYS) — withdrawable 0, on hold ${bal.onHoldCents}; request refused as expected`);
    else report('withdraw', w.status === 201 || code === 'no_payout_address', `request → ${w.status} ${code ?? 'created'}`);
  } catch (e: any) {
    report('withdraw', false, e.message);
  }

  // 10. chat filter: outside contact is never delivered
  try {
    const o = (await order()).body.order;
    const detail = (await buyer.api.get(`/orders/${o.id}`)).body;
    const blocked = await buyer.api.post(`/chat/rooms/${detail.room_id}/messages`, { body: 'add me on discord: trader#1234' });
    const msgs = (await seller.api.get(`/chat/rooms/${detail.room_id}/messages`)).body;
    const leaked = msgs.some((m: any) => /discord/i.test(m.body ?? ''));
    report('chat filter', blocked.status === 422 && blocked.body?.error?.code === 'offplatform_blocked' && !leaked, `sender got 422 ${blocked.body?.error?.code}; seller sees nothing`);
  } catch (e: any) {
    report('chat filter', false, e.message);
  }

  // 11. underpay: NOWPayments sandbox only
  const coins = await buyer.api.get(`/orders/${(await order()).body.order.id}/crypto/coins`);
  if (coins.status === 503) report('underpay', true, 'skipped on the mock provider: set NOWPAYMENTS_* sandbox keys with NOWPAYMENTS_SANDBOX_CASE=partially_paid (crypto-payments.test.ts covers it in CI)');
  else report('underpay', coins.status === 200, `coins listed (${coins.body?.coins?.length}); use NOWPAYMENTS_SANDBOX_CASE=partially_paid to force a short payment, then check /me/wallet for the kept credit`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} money paths passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
