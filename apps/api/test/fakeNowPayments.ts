import { expect } from 'vitest';

/**
 * A fake NOWPayments: records calls, answers like the real API, and lets the test "pay" by
 * posting a signed IPN exactly as the real one would.
 */
export class FakeNow {
  payments = new Map<string, any>();
  payouts: any[] = [];
  minUsd: Record<string, number> = { btc: 8, usdttrc20: 1, eth: 12, ltc: 2 };
  nextId = 5000;
  /** Next payout call: 'timeout' throws after creating the payout (the provider acted, we never heard), 'down' fails with a 503 before acting. */
  payoutMode: 'ok' | 'timeout' | 'down' | 'reject' | 'verify_fail' = 'ok';
  /** Round 22: verify calls seen, and whether the next verify fails. */
  verifies: string[] = [];
  verifyFails = 0;
  /** Round 22: when set, /v1/balance answers this HTTP status (reconciliation must fail, not pass). */
  balanceStatus: number | null = null;
  /** Round 22 property tests: when set, the custody wallet holds exactly this many USDT (the test keeps it in step). */
  walletUsd: number | null = null;
  /** Extra coins in the custody wallet for the reconciliation valuation test (CFO B7). */
  extraBalance: Record<string, { amount: number; pendingAmount?: number }> | null = null;
  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/v1/merchant/coins') return json({ selectedCurrencies: Object.keys(this.minUsd) });
    if (u.pathname === '/v1/min-amount') {
      const from = u.searchParams.get('currency_from')!;
      return json({ currency_from: from, currency_to: 'usdttrc20', min_amount: 0.0001, fiat_equivalent: this.minUsd[from] ?? 999 });
    }
    if (u.pathname === '/v1/payment' && init?.method === 'POST') {
      const id = String(this.nextId++);
      const p = {
        payment_id: id, payment_status: 'waiting', pay_address: `addr_${body.pay_currency}_${id}`, price_amount: body.price_amount, price_currency: 'usd',
        pay_amount: body.price_amount / 50_000, pay_currency: body.pay_currency, order_id: body.order_id, purchase_id: body.purchase_id ?? `pur_${id}`,
        expiration_estimate_date: new Date(Date.now() + 20 * 60_000).toISOString(),
      };
      this.payments.set(id, p);
      return json(p, 201);
    }
    const m = u.pathname.match(/^\/v1\/payment\/(\w+)$/);
    if (m) return json(this.payments.get(m[1]!));
    if (u.pathname === '/v1/auth') return json({ token: 'jwt-test' });
    if (u.pathname === '/v1/payout' && init?.method === 'POST') {
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer jwt-test' });
      const mode = this.payoutMode;
      this.payoutMode = 'ok';
      if (mode === 'down') return json({ message: 'maintenance' }, 503);
      if (mode === 'reject') return json({ message: 'Invalid address' }, 400);
      // Idempotent on unique_external_id, like the real API.
      const dup = body.withdrawals[0].unique_external_id && this.payouts.find((p) => p.unique_external_id === body.withdrawals[0].unique_external_id);
      const id = dup ? dup.id : String(this.nextId++);
      const w = dup ?? { id, batch_withdrawal_id: `batch_${id}`, status: 'WAITING', ...body.withdrawals[0] };
      if (!dup) this.payouts.push(w);
      if (mode === 'timeout') throw new Error('socket hang up');
      if (mode === 'verify_fail') this.verifyFails = 1;
      return json({ id: `batch_${id}`, withdrawals: [w] });
    }
    const po = u.pathname.match(/^\/v1\/payout\/([\w-]+)$/);
    if (po && (init?.method ?? 'GET') === 'GET') {
      const w = this.payouts.find((x) => String(x.id) === po[1]);
      return w ? json(w) : json({ message: 'not found' }, 404);
    }
    if (u.pathname === '/v1/payout' && (init?.method ?? 'GET') === 'GET') return json({ data: [...this.payouts].reverse() });
    if (/^\/v1\/payout\/.*\/verify$/.test(u.pathname)) {
      expect(body.verification_code).toMatch(/^\d{6}$/);
      if (this.verifyFails > 0) {
        this.verifyFails--;
        return json({ message: 'Invalid verification code' }, 400);
      }
      const batch = u.pathname.split('/')[3]!;
      this.verifies.push(batch);
      for (const w of this.payouts) if (w.batch_withdrawal_id === batch && w.status === 'WAITING') w.status = 'PROCESSING';
      return json('OK');
    }
    if (u.pathname === '/v1/balance' && this.balanceStatus) return json({ message: 'unavailable' }, this.balanceStatus);
    if (u.pathname === '/v1/balance' && this.walletUsd != null) return json({ usdttrc20: { amount: this.walletUsd, pendingAmount: 0 } });
    if (u.pathname === '/v1/balance') return json({ usdttrc20: { amount: 1000, pendingAmount: 0 }, ...(this.extraBalance ?? {}) });
    if (u.pathname === '/v1/estimate' && u.searchParams.get('currency_to') === 'usd') return json({ estimated_amount: Number(u.searchParams.get('amount')) * (u.searchParams.get('currency_from') === 'btc' ? 60000 : 1) });
    return json({ message: `unexpected ${init?.method ?? 'GET'} ${u.pathname}` }, 404);
  };
}

