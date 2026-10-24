import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { client, makeOffer, makeUser, setup, type Harness } from './helpers.js';
import { NowPaymentsProvider, ipnSignature, sortDeep } from '../src/providers/payments/nowpayments.js';
import { FakeNow } from './fakeNowPayments.js';
import { recheckUnknownPayouts } from '../src/domain/cryptoPayouts.js';
import { cancelUnpaidExpired } from '../src/domain/orders.js';
import { grossUp, splitGross } from '../src/domain/commission.js';
import { withdrawalFee } from '../src/domain/cryptoPayouts.js';
import { taxInside } from '../src/domain/tax.js';
import { runReconciliation } from '../src/domain/reconciliation.js';

/**
 * Launch gate §2 — money invariants, two layers:
 *  1. Pure arithmetic (thousands of random cases): commission gross-up, split-dispute allocation, withdrawal fee, VAT inside.
 *  2. Randomised end-to-end scenarios against the real ledger ON THE NOWPAYMENTS PATH (Round 22): a fake NOWPayments
 *     (test/fakeNowPayments.ts) takes the payments and the payouts, so a double payout or a lost deposit is visible at
 *     the provider. Exact, over-, under- and late payments, a second transfer, IPN vs the unpaid-order reaper, confirm vs
 *     dispute, staff release, refunds, splits, refunds after release, invite and creator codes, withdrawals whose payout
 *     call succeeds, times out, finds the provider down, is rejected or fails its 2FA verify — then the books balance,
 *     nothing is paid twice, every deposit is accounted for exactly once, and the provider wallet matches the ledger.
 */
const RUNS = Number(process.env.MONEY_FUZZ_RUNS ?? 25);

describe('money arithmetic (property tests)', () => {
  it('gross-up: the seller always receives exactly their price and the commission is never negative or more than one cent above the rate', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000_00 }), fc.integer({ min: 0, max: 5000 }), (seller, bps) => {
        const buyer = grossUp(seller, bps);
        const { commissionCents, sellerNetCents } = splitGross(buyer, seller);
        expect(sellerNetCents).toBe(seller);
        expect(commissionCents).toBeGreaterThanOrEqual(0);
        expect(buyer).toBeGreaterThanOrEqual(seller);
        // Rounding is always in the platform's favour, by at most one cent.
        const exact = (seller * 10_000) / (10_000 - bps);
        expect(buyer - exact).toBeGreaterThanOrEqual(0);
        expect(buyer - exact).toBeLessThan(1);
        expect(commissionCents + sellerNetCents).toBe(buyer);
      }),
      { numRuns: 5000 },
    );
  });

  it('split decisions: refund + seller part + commission share + reserve + tax == the amount held, with nothing negative', () => {
    fc.assert(
      fc.property(
        fc.record({ amount: fc.integer({ min: 2, max: 1_000_000_00 }), rateBps: fc.integer({ min: 0, max: 2000 }), discountBps: fc.integer({ min: 0, max: 5000 }), taxBps: fc.integer({ min: 0, max: 2700 }) }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        ({ amount, rateBps, discountBps, taxBps }, refundFraction) => {
          const commissionFull = Math.floor((amount * rateBps) / 10_000);
          const discount = Math.floor((amount * discountBps) / 10_000);
          const refund = Math.max(1, Math.min(amount - 1, Math.round(amount * refundFraction)));
          const released = amount - refund;
          const commission = Math.round((commissionFull * released) / amount);
          const reserveCut = Math.floor((commission * 1000) / 10_000);
          const tax = taxInside(commission, taxBps);
          const promoShare = Math.min(refund, Math.round((discount * refund) / amount));
          const buyerCredit = refund - promoShare;
          const treasury = commission - reserveCut - tax + promoShare;
          const seller = released - commission;
          for (const v of [buyerCredit, treasury, reserveCut, tax, seller, promoShare]) expect(v).toBeGreaterThanOrEqual(0);
          expect(buyerCredit + treasury + reserveCut + tax + seller).toBe(amount);
          expect(seller).toBeLessThanOrEqual(amount - commissionFull); // never more than a full release would give
        },
      ),
      { numRuns: 5000 },
    );
  });

  it('withdrawal fee: 6% with a $1.50 floor, never more than the amount, net never negative', () => {
    const ctx = { cfg: { WITHDRAWAL_FEE_BPS: 600, WITHDRAWAL_FEE_MIN_CENTS: 150 } } as any;
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100_000_00 }), (amount) => {
        const fee = withdrawalFee(ctx, amount);
        expect(fee).toBeLessThanOrEqual(amount);
        expect(fee).toBeGreaterThanOrEqual(Math.min(amount, 150));
        expect(fee).toBeGreaterThanOrEqual(Math.min(amount, Math.ceil(amount * 0.06)));
        expect(amount - fee).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 5000 },
    );
  });
});

describe('money invariants on the NOWPayments path (randomised scenarios)', () => {
  const IPN_SECRET = 'ipn-secret-fuzz';
  let h: Harness;
  let fake: FakeNow;
  /** What reached the custody wallet per payment id (max seen), in cents; payouts are read from the fake. */
  const deposits = new Map<string, number>();
  /** What the buyer's wallet sent per payment id (gross, before the provider's fee), in cents. */
  const sent = new Map<string, number>();
  beforeAll(async () => {
    fake = new FakeNow();
    fake.minUsd = { usdttrc20: 0.01, btc: 0.01 };
    const payments = new NowPaymentsProvider({ apiKey: 'k', ipnSecret: IPN_SECRET, apiUrl: 'https://np.test', email: 'e', password: 'p', twoFactorSecret: 'JBSWY3DPEHPK3PXP', fetch: fake.fetch as any });
    h = await setup({ PAYMENT_PROVIDER: 'nowpayments', NOWPAYMENTS_API_KEY: 'k', NOWPAYMENTS_IPN_SECRET: IPN_SECRET }, { payments });
  });
  afterAll(async () => h.close());

  const ipn = (body: Record<string, unknown>) =>
    h.app.inject({ method: 'POST', url: '/v1/payments/webhook/nowpayments', headers: { 'content-type': 'application/json', 'x-nowpayments-sig': ipnSignature(IPN_SECRET, body) }, payload: JSON.stringify(sortDeep(body)) });
  /** The buyer's wallet sends `paidCents` worth; 1% is the provider's fee, the rest reaches the store wallet. */
  const deposit = async (p: any, paidCents: number, status = 'finished', times = 1) => {
    const outcomeCents = Math.floor(paidCents * 0.99);
    deposits.set(String(p.payment_id), Math.max(deposits.get(String(p.payment_id)) ?? 0, outcomeCents));
    sent.set(String(p.payment_id), Math.max(sent.get(String(p.payment_id)) ?? 0, paidCents));
    const body = {
      payment_id: Number(p.payment_id), payment_status: status, pay_address: p.pay_address, price_amount: p.price_amount, price_currency: 'usd',
      pay_amount: p.pay_amount, actually_paid: (p.pay_amount * paidCents) / Math.round(p.price_amount * 100), actually_paid_at_fiat: paidCents / 100,
      pay_currency: p.pay_currency, order_id: p.order_id, purchase_id: p.purchase_id, outcome_amount: outcomeCents / 100, outcome_currency: 'usdttrc20',
    };
    for (let i = 0; i < times; i++) expect((await ipn(body)).statusCode).toBe(200);
    return outcomeCents;
  };
  const startPay = async (buyer: { api: any }, orderId: string) => {
    const r = await buyer.api.post(`/v1/orders/${orderId}/crypto/pay`, { coin: 'usdttrc20' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return fake.payments.get(r.body.payment_id);
  };
  const balances = async () => {
    const rows = await h.ctx.db.query(`SELECT a.kind, COALESCE(SUM(e.amount_cents), 0)::bigint AS s FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id WHERE a.currency = 'USD' GROUP BY a.kind`);
    return Object.fromEntries(rows.rows.map((r) => [r.kind, Number(r.s)])) as Record<string, number>;
  };
  const ownerSum = async (kind: string, owner: string) => Number((await h.ctx.db.query(`SELECT COALESCE(SUM(e.amount_cents), 0)::bigint AS s FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.kind = $1 AND a.owner_id = $2`, [kind, owner])).rows[0].s);
  const orderSum = async (kind: string, orderId: string) => Number((await h.ctx.db.query(`SELECT COALESCE(SUM(e.amount_cents), 0)::bigint AS s FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.kind = $1 AND e.order_id = $2`, [kind, orderId])).rows[0].s);
  const orderPostings = async (orderId: string) => (await h.ctx.db.query(`SELECT memo, count(DISTINCT txn_id)::int AS n FROM ledger_entries WHERE order_id = $1 GROUP BY memo`, [orderId])).rows as Array<{ memo: string; n: number }>;
  const settledOfOrder = async (orderId: string, of = deposits) => {
    const ids = (await h.ctx.db.query('SELECT payment_id FROM crypto_payments WHERE order_id = $1', [orderId])).rows.map((r) => String(r.payment_id));
    return ids.reduce((s, id) => s + (of.get(id) ?? 0), 0);
  };
  /** Provider wallet = deposits − payouts the provider created (and did not fail). */
  const syncWallet = () => {
    const inCents = [...deposits.values()].reduce((s, v) => s + v, 0);
    const outCents = fake.payouts.filter((p) => !['FAILED', 'REJECTED'].includes(p.status)).reduce((s, p) => s + Math.round(Number(p.amount) * 100), 0);
    fake.walletUsd = (inCents - outCents) / 100;
  };

  type Pay = 'exact' | 'over' | 'under_topup' | 'under_lapse' | 'late' | 'race';
  type Step = 'confirm' | 'release' | 'refund' | 'seller' | 'split' | 'confirm_vs_dispute' | 'refund_after_release';
  const scenario = fc.record({
    priceCents: fc.integer({ min: 1_00, max: 400_00 }),
    quantity: fc.integer({ min: 1, max: 2 }),
    promo: fc.option(fc.integer({ min: 5, max: 50 }), { nil: undefined }),
    pay: fc.constantFrom<Pay>('exact', 'exact', 'over', 'under_topup', 'under_lapse', 'late', 'race'),
    overBps: fc.integer({ min: 100, max: 5000 }),
    replay: fc.boolean(),
    extra: fc.boolean(),
    step: fc.constantFrom<Step>('confirm', 'release', 'refund', 'seller', 'split', 'confirm_vs_dispute', 'refund_after_release'),
    splitFraction: fc.double({ min: 0.05, max: 0.95, noNaN: true }),
    buyerKind: fc.constantFrom('plain', 'invite', 'creator'),
    withdraw: fc.option(fc.record({ fraction: fc.double({ min: 0.1, max: 1, noNaN: true }), mode: fc.constantFrom('ok', 'ok', 'timeout', 'down', 'reject', 'verify_fail') }), { nil: undefined }),
  });

  it('every random NOWPayments path keeps the books balanced, pays nobody twice and matches the provider wallet', async () => {
    const admin = await makeUser(h, { role: 'admin' });
    const finance = await makeUser(h, { role: 'finance' });
    // Code owners: a referrer and a creator, with one long-lived buyer each (so later orders earn).
    const referrer = await makeUser(h, { tier: 1 });
    const { code: inviteCode } = (await referrer.api.get('/v1/me/referral')).body;
    const creator = await makeUser(h, { tier: 1 });
    expect((await finance.api.post('/v1/admin/affiliates', { userId: creator.id, code: 'FUZZ-CREATOR', rateBps: 2500 })).status).toBe(201);
    const register = async (code: string) => {
      const reg = await client(h.app).post('/v1/auth/register', { email: `fuzz_${code}_${Date.now()}_${Math.random()}@example.com`, password: 'correct horse battery', displayName: 'Fuzz buyer', acceptTerms: true, code });
      expect(reg.status, JSON.stringify(reg.body)).toBe(201);
      await h.ctx.db.query('UPDATE users SET kyc_tier = 1 WHERE id = $1', [reg.body.user.id]);
      return { id: reg.body.user.id as string, api: client(h.app, reg.body.token) };
    };
    const inviteBuyer = await register(inviteCode);
    const creatorBuyer = await register('FUZZ-CREATOR');
    let promoN = 0;

    await fc.assert(
      fc.asyncProperty(scenario, async (sc) => {
        const seller = await makeUser(h, { tier: 2 });
        await h.ctx.db.query(`UPDATE users SET payout_hold_days = 0, payout_address = 'TFuzzSeller1234567890abcd', payout_address_currency = 'usdttrc20', payout_address_set_at = now() WHERE id = $1`, [seller.id]);
        const buyer = sc.buyerKind === 'invite' ? inviteBuyer : sc.buyerKind === 'creator' ? creatorBuyer : await makeUser(h, { tier: 1 });
        const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 10, priceCents: sc.priceCents, categorySlug: 'currency', title: 'Fuzz gold' });
        let promoCode: string | undefined;
        if (sc.promo) {
          promoCode = `FUZZ${++promoN}`;
          await admin.api.post('/v1/admin/promos', { code: promoCode, percentOff: sc.promo, maxDiscountCents: 1_000_00 });
        }
        const creditBefore = await ownerSum('user_credit', buyer.id);
        const created = await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: sc.quantity, acceptTos: true, ...(promoCode ? { promoCode } : {}) });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        const order = created.body.order;
        const owed = Number(order.charged_cents);
        const times = sc.replay ? 2 : 1;

        // ---- Payment ----
        if (owed > 0) {
          const p = await startPay(buyer, order.id);
          const expire = () => h.ctx.db.query(`UPDATE orders SET payment_expires_at = now() - interval '2 hours' WHERE id = $1`, [order.id]);
          if (sc.pay === 'exact') await deposit(p, owed, 'finished', times);
          else if (sc.pay === 'over') await deposit(p, owed + Math.ceil((owed * sc.overBps) / 10_000), 'finished', times);
          else if (sc.pay === 'under_topup' || sc.pay === 'under_lapse') {
            const half = Math.max(1, Math.floor(owed / 2));
            await deposit(p, half, 'partially_paid', times);
            if (sc.pay === 'under_topup') {
              const settledHalf = Math.floor(half * 0.99);
              void settledHalf;
              const p2 = await startPay(buyer, order.id);
              await deposit(p2, Math.round(p2.price_amount * 100), 'finished', times);
            } else {
              await expire();
              await cancelUnpaidExpired(h.ctx);
            }
          } else if (sc.pay === 'late') {
            await expire();
            await cancelUnpaidExpired(h.ctx);
            await deposit(p, owed, 'finished', times);
          } else {
            // IPN vs the reaper, at the same moment.
            await expire();
            const outcomeCents = Math.floor(owed * 0.99);
            deposits.set(String(p.payment_id), outcomeCents);
            sent.set(String(p.payment_id), owed);
            const body = { payment_id: Number(p.payment_id), payment_status: 'finished', pay_address: p.pay_address, price_amount: p.price_amount, price_currency: 'usd', pay_amount: p.pay_amount, actually_paid: p.pay_amount, actually_paid_at_fiat: owed / 100, pay_currency: p.pay_currency, order_id: p.order_id, purchase_id: p.purchase_id, outcome_amount: outcomeCents / 100, outcome_currency: 'usdttrc20' };
            await Promise.allSettled([ipn(body), cancelUnpaidExpired(h.ctx), ipn(body)]);
            await ipn(body);
          }
          // A second transfer to the same address after the order was funded.
          const st = (await h.ctx.db.query('SELECT status FROM orders WHERE id = $1', [order.id])).rows[0].status;
          if (sc.extra && st === 'paid') {
            const rows = (await h.ctx.db.query('SELECT payment_id FROM crypto_payments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1', [order.id])).rows;
            const last = fake.payments.get(String(rows[0].payment_id));
            const already = deposits.get(String(last.payment_id)) ?? 0;
            await deposit(last, Math.ceil(already / 0.99) + 5_00, 'finished', times);
          }
        }

        // Every deposit is in the books exactly once: what reached the wallet for this order left gateway_clearing once.
        expect(0 - (await orderSum('gateway_clearing', order.id)) + 0).toBe(await settledOfOrder(order.id));
        const paidStatus = (await h.ctx.db.query('SELECT status FROM orders WHERE id = $1', [order.id])).rows[0].status;
        if (paidStatus === 'cancelled') {
          expect(await orderSum('escrow', order.id)).toBe(0);
          expect(await ownerSum('user_credit', buyer.id) - creditBefore).toBe(await settledOfOrder(order.id)); // all of it is the buyer's credit
          return;
        }
        expect(paidStatus).toBe('paid');
        expect(await orderSum('escrow', order.id)).toBe(Number(order.amount_cents));
        // The fraud engine may hold a fuzzed order (fresh accounts, odd amounts) for review; that path has its own tests.
        await h.ctx.db.query('UPDATE orders SET escrow_frozen = false WHERE id = $1', [order.id]);
        const dl = await seller.api.post(`/v1/orders/${order.id}/deliver`, { payload: 'done' });
        expect(dl.status, JSON.stringify(dl.body)).toBeLessThan(300);

        // ---- Outcome ----
        const before = await balances();
        const resolve = async (body: Record<string, unknown>) => {
          const d = (await h.ctx.db.query(`SELECT id FROM disputes WHERE order_id = $1`, [order.id])).rows[0];
          const [a, b] = await Promise.all([admin.api.post(`/v1/admin/disputes/${d.id}/resolve`, body), admin.api.post(`/v1/admin/disputes/${d.id}/resolve`, body)]);
          expect([a.status, b.status].filter((s) => s === 200), JSON.stringify([a.body, b.body])).toHaveLength(1);
        };
        if (sc.step === 'confirm' || sc.step === 'refund_after_release') {
          const [a, b] = await Promise.all([buyer.api.post(`/v1/orders/${order.id}/confirm`), buyer.api.post(`/v1/orders/${order.id}/confirm`)]);
          expect([a.status, b.status].filter((s) => s === 200)).toHaveLength(1);
        } else if (sc.step === 'release') {
          await h.ctx.db.query(`UPDATE orders SET delivered_at = now() - interval '2 days' WHERE id = $1`, [order.id]);
          const [a, b] = await Promise.all([admin.api.post(`/v1/admin/orders/${order.id}/release`, { note: 'Proof checked' }), admin.api.post(`/v1/admin/orders/${order.id}/release`, { note: 'Proof checked' })]);
          expect([a.status, b.status].filter((s) => s === 200), JSON.stringify([a.body, b.body])).toHaveLength(1);
        } else if (sc.step === 'confirm_vs_dispute') {
          const [a, b] = await Promise.all([buyer.api.post(`/v1/orders/${order.id}/confirm`), buyer.api.post(`/v1/orders/${order.id}/dispute`, { reason: 'Changed my mind halfway', category: 'other' })]);
          expect([a.status, b.status].filter((s) => s === 200 || s === 201), JSON.stringify([a.body, b.body])).toHaveLength(1);
          if ((await h.ctx.db.query('SELECT status FROM orders WHERE id = $1', [order.id])).rows[0].status === 'disputed') await resolve({ outcome: 'buyer', note: 'Refund the buyer' });
        } else {
          await buyer.api.post(`/v1/orders/${order.id}/dispute`, { reason: 'Something is wrong with it', category: 'not_as_described' });
          await resolve(
            sc.step === 'refund' ? { outcome: 'buyer', note: 'Refund the buyer' }
            : sc.step === 'seller' ? { outcome: 'seller', note: 'Release to the seller' }
            : { outcome: 'split', refundCents: Math.max(1, Math.min(order.amount_cents - 1, Math.round(order.amount_cents * sc.splitFraction))), note: 'Split it' },
          );
        }
        if (sc.step === 'refund_after_release') {
          const r = await admin.api.post(`/v1/admin/orders/${order.id}/refund-after-release`, { paidBy: 'platform', reason: 'Goodwill refund after release' });
          expect(r.status, JSON.stringify(r.body)).toBe(200);
        }

        // 1. Closed: nothing left in escrow; exactly one closing posting.
        const final = (await h.ctx.db.query('SELECT status, amount_cents, discount_cents, commission_cents, seller_net_cents FROM orders WHERE id = $1', [order.id])).rows[0];
        expect(['completed', 'refunded']).toContain(final.status);
        expect(await orderSum('escrow', order.id)).toBe(0);
        const postings = await orderPostings(order.id);
        expect(postings.filter((p) => ['escrow_release', 'dispute_split', 'refund'].includes(p.memo)).map((p) => p.n)).toEqual([1]);
        expect(postings.filter((p) => p.memo === 'payment_captured').map((p) => p.n)).toEqual([1]); // funded once, whatever the replays
        // 2. Conservation and nobody paid twice.
        const after = await balances();
        const delta = (k: string) => (after[k] ?? 0) - (before[k] ?? 0);
        for (const k of ['seller_available', 'reserve', 'tax_payable']) expect(delta(k)).toBeGreaterThanOrEqual(sc.step === 'refund_after_release' ? -Number(final.amount_cents) : 0);
        expect(delta('refunds_payable')).toBe(0); // never the hidden crypto-refund queue
        expect(await ownerSum('seller_available', seller.id)).toBeLessThanOrEqual(Number(final.seller_net_cents));
        // The buyer never gets back more than their wallet sent (promo money never becomes withdrawable credit).
        expect(await ownerSum('user_credit', buyer.id) - creditBefore).toBeLessThanOrEqual(await settledOfOrder(order.id, sent));
        // 3. Codes: at most one reward per order, never both kinds, never above half the commission, booked exactly as recorded.
        const ref = (await h.ctx.db.query(`SELECT amount_cents FROM referral_rewards WHERE order_id = $1 AND status = 'granted'`, [order.id])).rows;
        const aff = (await h.ctx.db.query(`SELECT earned_cents FROM affiliate_earnings WHERE order_id = $1`, [order.id])).rows;
        expect(ref.length + aff.length).toBeLessThanOrEqual(1);
        if (sc.buyerKind !== 'invite') expect(ref).toHaveLength(0);
        if (sc.buyerKind !== 'creator') expect(aff).toHaveLength(0);
        const reward = Number(ref[0]?.amount_cents ?? aff[0]?.earned_cents ?? 0);
        expect(reward).toBeLessThanOrEqual(Math.floor(Number(final.commission_cents) / 2));
        const booked = 0 - Number((await h.ctx.db.query(`SELECT COALESCE(SUM(e.amount_cents), 0) AS s FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.kind = 'treasury' AND e.order_id = $1 AND e.memo IN ('referral_reward', 'affiliate_commission')`, [order.id])).rows[0].s);
        expect(booked).toBe(reward);

        // 4. Withdrawal through the provider: one payout at most, and a reversed withdrawal has none.
        await h.ctx.db.query('UPDATE users SET withdrawals_frozen = false WHERE id = $1', [seller.id]);
        const avail = await ownerSum('seller_available', seller.id);
        if (sc.withdraw && avail > 150) {
          const amount = Math.max(151, Math.floor(avail * sc.withdraw.fraction));
          const w = await seller.api.post('/v1/seller/withdrawals', { amountCents: amount });
          expect(w.status, JSON.stringify(w.body)).toBe(201);
          expect((await seller.api.post('/v1/seller/withdrawals', { amountCents: avail })).status).toBe(400);
          fake.payoutMode = sc.withdraw.mode as any;
          const [x, y] = await Promise.all([finance.api.post(`/v1/admin/withdrawals/${w.body.id}/decide`, { approve: true }), finance.api.post(`/v1/admin/withdrawals/${w.body.id}/decide`, { approve: true })]);
          expect([x.status, y.status].filter((s) => s !== 409 && s !== 403).length, JSON.stringify([x.body, y.body])).toBe(1);
          fake.payoutMode = 'ok';
          // The hourly job, hours later: unknowns are rechecked (twice, 30+ min apart), processing ones polled.
          for (let i = 0; i < 3; i++) {
            await h.ctx.db.query(`UPDATE withdrawals SET updated_at = now() - interval '5 minutes', provider_attempted_at = now() - interval '7 hours', last_not_found_at = last_not_found_at - interval '31 minutes', last_polled_at = NULL WHERE id = $1`, [w.body.id]);
            await recheckUnknownPayouts(h.ctx);
          }
          // The provider finishes what it has, and says so by IPN (replayed).
          for (const p of fake.payouts.filter((q) => q.unique_external_id === w.body.id && q.status !== 'FINISHED')) {
            p.status = 'FINISHED';
            for (let i = 0; i < 2; i++) await ipn({ id: p.id, batch_withdrawal_id: p.batch_withdrawal_id, unique_external_id: p.unique_external_id, status: 'FINISHED', error: null, currency: 'usdttrc20', amount: p.amount, address: p.address, hash: `0x${p.id}` });
          }
          const row = (await h.ctx.db.query('SELECT status, amount_cents, fee_cents, net_cents FROM withdrawals WHERE id = $1', [w.body.id])).rows[0];
          const atProvider = fake.payouts.filter((p) => p.unique_external_id === w.body.id && !['FAILED', 'REJECTED'].includes(p.status));
          expect(atProvider.length).toBeLessThanOrEqual(1);
          expect(['paid', 'failed']).toContain(row.status);
          if (row.status === 'failed') expect(atProvider, 'reversed but the provider sent it: paid twice').toHaveLength(0);
          if (row.status === 'paid') expect(atProvider).toHaveLength(1);
          expect(Number(row.fee_cents) + Number(row.net_cents)).toBe(Number(row.amount_cents));
          const moves = (await h.ctx.db.query(`SELECT memo, count(DISTINCT txn_id)::int AS n FROM ledger_entries WHERE memo LIKE $1 GROUP BY memo`, [`withdrawal%:${w.body.id}`])).rows;
          for (const m of moves) expect(m.n, m.memo).toBe(1);
        }
      }),
      { numRuns: RUNS, endOnFailure: true },
    );

    // 5. The whole ledger: every transaction sums to zero, and the provider wallet equals what the books say it holds.
    syncWallet();
    const r = await runReconciliation(h.ctx);
    expect(r.report.issues, JSON.stringify(r.report.psp)).toEqual([]);
    const all = await balances();
    expect(Object.values(all).reduce((s, v) => s + v, 0)).toBe(0);
  }, 900_000);

  it('late deposits (the real code): any sequence of IPNs on a closed order credits the buyer exactly the most that arrived, once', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: 0, max: 500_00 }), { minLength: 1, maxLength: 6 }), fc.boolean(), async (paidSeq, cancelFirst) => {
        const seller = await makeUser(h, { tier: 2 });
        const buyer = await makeUser(h, { tier: 1 });
        const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 2, priceCents: 600_00, categorySlug: 'currency', title: 'Late gold' });
        const order = (await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 1, acceptTos: true })).body.order;
        const p = await startPay(buyer, order.id);
        const before = await ownerSum('user_credit', buyer.id);
        if (cancelFirst) {
          await h.ctx.db.query(`UPDATE orders SET payment_expires_at = now() - interval '2 hours' WHERE id = $1`, [order.id]);
          await cancelUnpaidExpired(h.ctx);
        }
        // Each IPN reports a total below the price (never enough to fund it), in any order, with repeats.
        for (const paid of paidSeq) {
          const outcomeCents = Math.floor(paid * 0.99);
          deposits.set(String(p.payment_id), Math.max(deposits.get(String(p.payment_id)) ?? 0, outcomeCents));
          await ipn({ payment_id: Number(p.payment_id), payment_status: 'partially_paid', pay_address: p.pay_address, price_amount: p.price_amount, price_currency: 'usd', pay_amount: p.pay_amount, actually_paid: (p.pay_amount * paid) / Math.round(p.price_amount * 100), actually_paid_at_fiat: paid / 100, pay_currency: p.pay_currency, order_id: p.order_id, purchase_id: p.purchase_id, outcome_amount: outcomeCents / 100, outcome_currency: 'usdttrc20' });
        }
        if (!cancelFirst) {
          await h.ctx.db.query(`UPDATE orders SET payment_expires_at = now() - interval '2 hours' WHERE id = $1`, [order.id]);
          await cancelUnpaidExpired(h.ctx);
        }
        const credited = (await ownerSum('user_credit', buyer.id)) - before;
        const last = Math.floor(paidSeq.at(-1)! * 0.99);
        const max = Math.max(...paidSeq.map((v) => Math.floor(v * 0.99)));
        // Cancelled first: every later IPN only ever adds (the most that arrived). Cancelled after: the reaper credits the
        // last reported total, never more than the most that arrived.
        if (cancelFirst) expect(credited).toBe(max);
        else expect(credited).toBe(last);
        expect(0 - (await orderSum('gateway_clearing', order.id)) + 0).toBe(credited);
      }),
      { numRuns: RUNS, endOnFailure: true },
    );
  }, 600_000);
});
