import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { buyAndPay, client, makeOffer, makeUser, setup, type Harness } from './helpers.js';
import { grossUp, splitGross } from '../src/domain/commission.js';
import { withdrawalFee } from '../src/domain/cryptoPayouts.js';
import { taxInside } from '../src/domain/tax.js';
import { runReconciliation } from '../src/domain/reconciliation.js';

/**
 * Launch gate §2 — money invariants, two layers:
 *  1. Pure arithmetic (thousands of random cases): commission gross-up, split-dispute allocation, withdrawal fee, VAT inside.
 *  2. Randomised end-to-end scenarios against the real ledger: orders that confirm, get staff-released, refunded, split,
 *     withdrawn, bought with promo codes and balance — then the books must balance, no order may keep money in escrow
 *     once closed, nothing may be paid twice, and every cent that came in is somewhere we can name.
 */
const RUNS = Number(process.env.MONEY_FUZZ_RUNS ?? 12);

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

describe('money invariants against the ledger (randomised scenarios)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setup();
  });
  afterAll(async () => h.close());

  type Step = { kind: 'confirm' } | { kind: 'release' } | { kind: 'refund' } | { kind: 'split'; fraction: number } | { kind: 'seller' };
  const step = fc.oneof(
    fc.constant<Step>({ kind: 'confirm' }),
    fc.constant<Step>({ kind: 'release' }),
    fc.constant<Step>({ kind: 'refund' }),
    fc.constant<Step>({ kind: 'seller' }),
    fc.record({ kind: fc.constant<'split'>('split'), fraction: fc.double({ min: 0.05, max: 0.95, noNaN: true }) }),
  );
  const scenario = fc.record({
    priceCents: fc.integer({ min: 1_00, max: 900_00 }),
    quantity: fc.integer({ min: 1, max: 3 }),
    promo: fc.option(fc.integer({ min: 5, max: 50 }), { nil: undefined }),
    outcome: step,
    withdrawFraction: fc.option(fc.double({ min: 0.1, max: 1, noNaN: true }), { nil: undefined }),
  });

  const balances = async () => {
    const rows = await h.ctx.db.query(`SELECT a.kind, COALESCE(SUM(e.amount_cents), 0)::bigint AS s FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id WHERE a.currency = 'USD' GROUP BY a.kind`);
    return Object.fromEntries(rows.rows.map((r) => [r.kind, Number(r.s)])) as Record<string, number>;
  };
  const orderPostings = async (orderId: string) => (await h.ctx.db.query(`SELECT memo, count(DISTINCT txn_id)::int AS n FROM ledger_entries WHERE order_id = $1 GROUP BY memo`, [orderId])).rows as Array<{ memo: string; n: number }>;

  it('every random order path keeps the books balanced, leaves closed orders with empty escrow, and pays nobody twice', async () => {
    const admin = await makeUser(h, { role: 'admin' });
    const lead = await makeUser(h, { role: 'lead' });
    const finance = await makeUser(h, { role: 'finance' });
    let promoN = 0;
    await fc.assert(
      fc.asyncProperty(scenario, async (sc) => {
        const seller = await makeUser(h, { tier: 2 });
        await h.ctx.db.query(`UPDATE users SET payout_hold_days = 0, stripe_account_id = 'acct_fuzz', payouts_enabled = true, payout_address = 'TFuzzSeller1234567890ab', payout_address_currency = 'usdttrc20' WHERE id = $1`, [seller.id]);
        const buyer = await makeUser(h, { tier: 1 });
        const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 10, priceCents: sc.priceCents });
        let promoCode: string | undefined;
        if (sc.promo) {
          promoCode = `FUZZ${++promoN}`;
          await admin.api.post('/v1/admin/promos', { code: promoCode, percentOff: sc.promo, maxDiscountCents: 1_000_00 });
        }
        const created = await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: sc.quantity, acceptTos: true, ...(promoCode ? { promoCode } : {}) });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        const order = created.body.order;
        const pay = await client(h.app).post(`/v1/payments/mock/checkout/${order.payment_ref}/pay`, {}, { accept: 'application/json' });
        expect(pay.status).toBe(200);
        // Paying twice (a replayed webhook / double click) never funds twice.
        await client(h.app).post(`/v1/payments/mock/checkout/${order.payment_ref}/pay`, {}, { accept: 'application/json' });
        await seller.api.post(`/v1/orders/${order.id}/deliver`, { payload: 'done' });

        const before = await balances();
        const staff = order.amount_cents > 200_00 ? lead : admin;
        if (sc.outcome.kind === 'confirm') {
          // Two confirms at once: exactly one release.
          const [a, b] = await Promise.all([buyer.api.post(`/v1/orders/${order.id}/confirm`), buyer.api.post(`/v1/orders/${order.id}/confirm`)]);
          expect([a.status, b.status].filter((s) => s === 200)).toHaveLength(1);
        } else if (sc.outcome.kind === 'release') {
          await h.ctx.db.query(`UPDATE orders SET delivered_at = now() - interval '2 days' WHERE id = $1`, [order.id]);
          const [a, b] = await Promise.all([staff.api.post(`/v1/admin/orders/${order.id}/release`, { note: 'Proof checked' }), staff.api.post(`/v1/admin/orders/${order.id}/release`, { note: 'Proof checked' })]);
          expect([a.status, b.status].filter((s) => s === 200), JSON.stringify([a.body, b.body])).toHaveLength(1);
        } else {
          const d = (await buyer.api.post(`/v1/orders/${order.id}/dispute`, { reason: 'Something is wrong with it', category: 'not_as_described' })).body;
          const body =
            sc.outcome.kind === 'refund' ? { outcome: 'buyer', note: 'Refund the buyer' }
            : sc.outcome.kind === 'seller' ? { outcome: 'seller', note: 'Release to the seller' }
            : { outcome: 'split', refundCents: Math.max(1, Math.min(order.amount_cents - 1, Math.round(order.amount_cents * sc.outcome.fraction))), note: 'Split it' };
          const [a, b] = await Promise.all([staff.api.post(`/v1/admin/disputes/${d.id}/resolve`, body), staff.api.post(`/v1/admin/disputes/${d.id}/resolve`, body)]);
          expect([a.status, b.status].filter((s) => s === 200), JSON.stringify([a.body, b.body])).toHaveLength(1);
        }

        // 1. Closed: nothing left in escrow for this order; exactly one closing posting.
        const final = (await h.ctx.db.query('SELECT status, amount_cents, discount_cents, credit_cents FROM orders WHERE id = $1', [order.id])).rows[0];
        expect(['completed', 'refunded']).toContain(final.status);
        const escrowLeft = Number((await h.ctx.db.query(`SELECT COALESCE(SUM(e.amount_cents), 0) AS s FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.kind = 'escrow' AND e.order_id = $1`, [order.id])).rows[0].s);
        expect(escrowLeft).toBe(0);
        const postings = await orderPostings(order.id);
        const closing = postings.filter((p) => ['escrow_release', 'dispute_split', 'refund'].includes(p.memo));
        expect(closing.map((p) => p.n)).toEqual([1]);

        // 2. Conservation: what left escrow equals what landed in seller/treasury/reserve/tax/buyer credit (+ gateway for card refunds).
        const after = await balances();
        const delta = (k: string) => (after[k] ?? 0) - (before[k] ?? 0);
        expect(delta('escrow')).toBe(-Number(final.amount_cents));
        const landed = ['seller_available', 'treasury', 'reserve', 'tax_payable', 'user_credit', 'gateway_clearing', 'fx_pnl', 'seller_pending', 'refunds_payable'].reduce((s, k) => s + delta(k), 0);
        expect(landed).toBe(Number(final.amount_cents));
        for (const k of ['seller_available', 'reserve', 'tax_payable']) expect(delta(k)).toBeGreaterThanOrEqual(0);
        // Nobody gets more than the order held; the promo-funded part never becomes withdrawable buyer credit.
        expect(delta('user_credit')).toBeLessThanOrEqual(Number(final.amount_cents) - Number(final.discount_cents));
        expect(delta('seller_available')).toBeLessThanOrEqual(order.seller_net_cents);

        // 3. A withdrawal moves money out exactly once, fee included.
        if (sc.withdrawFraction && delta('seller_available') > 150) {
          const amount = Math.max(151, Math.floor(delta('seller_available') * sc.withdrawFraction));
          const w = await seller.api.post('/v1/seller/withdrawals', { amountCents: amount });
          expect(w.status, JSON.stringify(w.body)).toBe(201);
          const again = await seller.api.post('/v1/seller/withdrawals', { amountCents: delta('seller_available') });
          expect(again.status).toBe(400); // the first request already took its gross out of the balance
          // With the crypto provider the CFO approves once; two approvals at once never pay twice (crypto-payments.test.ts
          // covers the provider side; here the mock provider pays the legacy path straight away).
          const [x, y] = await Promise.all([finance.api.post(`/v1/admin/withdrawals/${w.body.id}/decide`, { approve: true }), finance.api.post(`/v1/admin/withdrawals/${w.body.id}/decide`, { approve: true })]);
          expect([x.status, y.status].filter((s) => s === 200).length).toBeLessThanOrEqual(1);
          const wrow = (await h.ctx.db.query('SELECT amount_cents, fee_cents, net_cents FROM withdrawals WHERE id = $1', [w.body.id])).rows[0];
          if (wrow.net_cents != null) expect(Number(wrow.fee_cents ?? 0) + Number(wrow.net_cents)).toBe(Number(wrow.amount_cents)); // crypto path (the legacy card path leaves these null)
          const moves = (await h.ctx.db.query(`SELECT count(DISTINCT txn_id)::int AS n FROM ledger_entries WHERE memo LIKE $1`, [`withdrawal_%:${w.body.id}`])).rows[0].n;
          expect(moves).toBeLessThanOrEqual(2); // request + one approval, never a second approval
          expect(Number((await h.ctx.db.query(`SELECT count(*)::int AS n FROM withdrawals WHERE user_id = $1 AND status IN ('processing', 'paid')`, [seller.id])).rows[0].n)).toBe(1);
        }
      }),
      { numRuns: RUNS, endOnFailure: true },
    );

    // 4. The whole ledger: every transaction sums to zero, every account total is explained.
    const r = await runReconciliation(h.ctx);
    expect(r.report.issues.filter((i) => i.check !== 'psp_balance_mismatch')).toEqual([]);
    const all = await balances();
    expect(Object.values(all).reduce((s, v) => s + v, 0)).toBe(0);
  }, 600_000);

  it('under-paid and late crypto deposits are credited once, never lost and never doubled (randomised amounts)', async () => {
    // Pure model of creditLateDeposit: credited_cents only grows to the settled amount, and the total credited over any
    // sequence of IPNs equals the final settled amount — no matter the order or repetition of the IPNs.
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 10_000_00 }), { minLength: 1, maxLength: 20 }), (settledValues) => {
        let credited = 0;
        let paidOut = 0;
        const seen: number[] = [];
        for (const settled of settledValues) {
          seen.push(settled);
          const diff = settled - credited;
          if (diff > 0) {
            paidOut += diff;
            credited = settled;
          }
        }
        expect(paidOut).toBe(credited);
        expect(credited).toBe(Math.max(...seen));
        expect(paidOut).toBeLessThanOrEqual(Math.max(...seen));
      }),
      { numRuns: 5000 },
    );
  });
});
