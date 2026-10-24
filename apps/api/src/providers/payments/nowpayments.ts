import { createHmac } from 'node:crypto';
import { safeEqual } from '../../lib/crypto.js';
import { totpAt, currentStep } from '../../domain/mfa.js';
import type { CheckoutRequest, PaymentEvent, PaymentProvider } from './types.js';

/**
 * NOWPayments: crypto in (350+ coins, auto-converted to the store's outcome wallet, USDT/USDC) and
 * crypto out (mass payouts to sellers' addresses). The buyer never leaves Bullizard: checkout shows
 * our own coin picker, creates a payment here and displays the address and amount; status changes
 * arrive by IPN (HMAC-SHA512 over the alphabetically sorted JSON body, header `x-nowpayments-sig`).
 * Card-era parts of the provider interface (refunds, chargebacks, Connect accounts) have no
 * equivalent: refunds are sent by hand from the treasury (domain/cryptoPayments.ts), chargebacks
 * don't exist, and a seller's "payout account" is a confirmed crypto address.
 */
export type NowPaymentStatus = 'waiting' | 'confirming' | 'confirmed' | 'sending' | 'partially_paid' | 'finished' | 'failed' | 'refunded' | 'expired';
export type NowPayoutStatus = 'CREATING' | 'WAITING' | 'PROCESSING' | 'SENDING' | 'FINISHED' | 'FAILED' | 'REJECTED';

export interface NowPayment {
  payment_id: number | string;
  payment_status: NowPaymentStatus;
  pay_address: string;
  payin_extra_id?: string | null;
  price_amount: number;
  price_currency: string;
  pay_amount: number;
  pay_currency: string;
  actually_paid?: number;
  actually_paid_at_fiat?: number;
  outcome_amount?: number;
  outcome_currency?: string;
  order_id?: string;
  purchase_id?: string | number;
  expiration_estimate_date?: string;
  network?: string;
  created_at?: string;
  updated_at?: string;
}

/** A provider answer with an HTTP status; a 4xx is a definite rejection, anything else leaves the outcome unknown. */
export class NowPaymentsError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
  /** The provider definitely did not act (bad request, auth, not found): safe to reverse. */
  get rejected() {
    return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429;
  }
}

export interface NowPayout {
  unique_external_id?: string | null;
  id: string | number;
  batch_withdrawal_id?: string | number;
  status: NowPayoutStatus;
  address: string;
  currency: string;
  amount: number | string;
  hash?: string | null;
  error?: string | null;
}

export interface NowPaymentsOptions {
  apiKey: string;
  ipnSecret: string;
  apiUrl?: string;
  /** Account login for payouts (they need a short-lived JWT on top of the API key). */
  email?: string;
  password?: string;
  /** The account's 2FA secret (base32): payouts are verified automatically with a TOTP code. */
  twoFactorSecret?: string;
  /** Wallet the store converts into, e.g. usdttrc20; sets the pair for minimum amounts. */
  outcomeCurrency?: string;
  fetch?: typeof fetch;
}

/** Recursively sort object keys: the IPN signature is computed over this canonical form. */
export function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, sortDeep((v as Record<string, unknown>)[k])]));
  }
  return v;
}

export function ipnSignature(secret: string, body: unknown): string {
  return createHmac('sha512', secret).update(JSON.stringify(sortDeep(body))).digest('hex');
}

export class NowPaymentsProvider implements PaymentProvider {
  readonly name = 'nowpayments';
  private readonly apiUrl: string;
  private readonly fetchFn: typeof fetch;
  private jwt: { token: string; expiresAt: number } | null = null;
  /** `GET /v1/min-amount` is slow and rarely changes; cached per coin for ten minutes. */
  private readonly minAmounts = new Map<string, { usd: number; at: number }>();
  private coins: { list: string[]; at: number } | null = null;

  constructor(private readonly opts: NowPaymentsOptions) {
    this.apiUrl = (opts.apiUrl ?? 'https://api.nowpayments.io').replace(/\/+$/, '');
    this.fetchFn = opts.fetch ?? fetch;
  }

  get outcomeCurrency() {
    return this.opts.outcomeCurrency ?? 'usdttrc20';
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    const res = await this.fetchFn(`${this.apiUrl}${path}`, {
      method,
      headers: { 'x-api-key': this.opts.apiKey, 'content-type': 'application/json', ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON error page */
    }
    if (!res.ok) throw new NowPaymentsError(`NOWPayments ${method} ${path} failed (${res.status}): ${json?.message ?? text.slice(0, 200)}`, res.status);
    return json as T;
  }

  // --- Payments in ---------------------------------------------------------------------

  /** Coins the store accepts (Store Settings → Payment options). */
  async availableCoins(): Promise<string[]> {
    if (this.coins && Date.now() - this.coins.at < 10 * 60_000) return this.coins.list;
    const r = await this.call<{ selectedCurrencies?: string[]; currencies?: string[] }>('GET', '/v1/merchant/coins');
    const list = (r.selectedCurrencies ?? r.currencies ?? []).map((c) => c.toLowerCase());
    this.coins = { list, at: Date.now() };
    return list;
  }

  /** Smallest payment NOWPayments accepts in this coin, in USD. */
  async minAmountUsd(coin: string): Promise<number> {
    const hit = this.minAmounts.get(coin);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.usd;
    const r = await this.call<{ min_amount: number; fiat_equivalent?: number }>(
      'GET',
      `/v1/min-amount?currency_from=${encodeURIComponent(coin)}&currency_to=${encodeURIComponent(this.outcomeCurrency)}&fiat_equivalent=usd`,
    );
    const usd = Number(r.fiat_equivalent ?? 0);
    this.minAmounts.set(coin, { usd, at: Date.now() });
    return usd;
  }

  /** Coins whose minimum covers `amountUsd`, so the buyer never picks one that can't pay the order. */
  /** Every coin NOWPayments offers, with its minimum and whether it fits the amount owed. */
  async coinsFor(amountUsd: number): Promise<Array<{ coin: string; minUsd: number; available: boolean }>> {
    const coins = await this.availableCoins();
    const out: Array<{ coin: string; minUsd: number; available: boolean }> = [];
    await Promise.all(
      coins.map(async (coin) => {
        try {
          const minUsd = await this.minAmountUsd(coin);
          out.push({ coin, minUsd, available: minUsd <= amountUsd });
        } catch {
          /* a coin whose minimum can't be read right now is left out rather than offered blindly */
        }
      }),
    );
    return out.sort((a, b) => Number(b.available) - Number(a.available) || a.coin.localeCompare(b.coin));
  }

  async estimate(amountUsd: number, coin: string): Promise<number> {
    const r = await this.call<{ estimated_amount: number }>('GET', `/v1/estimate?amount=${amountUsd}&currency_from=usd&currency_to=${encodeURIComponent(coin)}`);
    return Number(r.estimated_amount);
  }

  /** Creates a payment the buyer sends to; `purchaseId` groups a top-up with the first payment of the same order. */
  async createPayment(input: { amountUsd: number; coin: string; orderId: string; description: string; ipnCallbackUrl: string; purchaseId?: string | null; sandboxCase?: string }): Promise<NowPayment> {
    return this.call<NowPayment>('POST', '/v1/payment', {
      price_amount: input.amountUsd,
      price_currency: 'usd',
      pay_currency: input.coin,
      order_id: input.orderId,
      order_description: input.description,
      ipn_callback_url: input.ipnCallbackUrl,
      ...(input.purchaseId ? { purchase_id: input.purchaseId } : {}),
      ...(input.sandboxCase ? { case: input.sandboxCase } : {}),
    });
  }

  async getPayment(paymentId: string | number): Promise<NowPayment> {
    return this.call<NowPayment>('GET', `/v1/payment/${paymentId}`);
  }

  // --- PaymentProvider: the parts that still apply ----------------------------------------

  /** The "hosted checkout" is our own crypto page; nothing is created at NOWPayments until the buyer picks a coin. */
  async createCheckout(req: CheckoutRequest) {
    // A single order's success URL is /orders/<id>?checkout=success; a cart's is /orders?checkout=success.
    const web = req.successUrl.replace(/\/orders(\/[^?]*)?\?checkout=success$/, '');
    const single = /\/orders\/[^/?]+\?checkout=success$/.test(req.successUrl);
    const redirectUrl = single ? req.successUrl.replace(/\?checkout=success$/, '?pay=crypto') : `${web}/checkouts/${req.orderId}/pay`;
    return { provider: this.name, ref: `np:${req.orderId}`, redirectUrl };
  }

  async parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<PaymentEvent> {
    const sig = String(headers['x-nowpayments-sig'] ?? '');
    const text = rawBody.toString('utf8');
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error('NOWPayments IPN is not JSON');
    }
    if (!sig || !safeEqual(sig, ipnSignature(this.opts.ipnSecret, body))) throw new Error('invalid NOWPayments IPN signature');
    if (body.payment_id !== undefined && body.payment_status) {
      return {
        type: 'crypto.payment',
        paymentId: String(body.payment_id),
        orderId: body.order_id ? String(body.order_id) : null,
        purchaseId: body.purchase_id != null ? String(body.purchase_id) : null,
        status: String(body.payment_status) as NowPaymentStatus,
        payCurrency: String(body.pay_currency ?? ''),
        payAmount: Number(body.pay_amount ?? 0),
        actuallyPaid: Number(body.actually_paid ?? 0),
        actuallyPaidUsd: body.actually_paid_at_fiat != null ? Number(body.actually_paid_at_fiat) : null,
        priceUsd: Number(body.price_amount ?? 0),
        outcomeAmount: body.outcome_amount != null ? Number(body.outcome_amount) : null,
        outcomeCurrency: body.outcome_currency ? String(body.outcome_currency) : null,
        raw: body,
      };
    }
    if (body.batch_withdrawal_id !== undefined || (body.id !== undefined && body.address)) {
      return {
        type: 'crypto.payout',
        payoutId: String(body.id),
        batchId: body.batch_withdrawal_id != null ? String(body.batch_withdrawal_id) : null,
        status: String(body.status).toUpperCase() as NowPayoutStatus,
        hash: body.hash ? String(body.hash) : null,
        error: body.error ? String(body.error) : null,
        raw: body,
      };
    }
    return { type: 'ignored' };
  }

  /** Crypto has no refund API: the treasury sends the coins back by hand (domain/cryptoPayments.ts queues it). */
  async refund(paymentRef: string, amountCents: number, currency: string, idempotencyKey?: string) {
    return { ref: `manual:${idempotencyKey ?? paymentRef}:${amountCents}:${currency}` };
  }

  // --- Payouts ------------------------------------------------------------------------------

  private async bearer(): Promise<string> {
    if (this.jwt && this.jwt.expiresAt > Date.now() + 15_000) return this.jwt.token;
    if (!this.opts.email || !this.opts.password) throw new Error('NOWPAYMENTS_EMAIL and NOWPAYMENTS_PASSWORD are required for payouts');
    const r = await this.call<{ token: string }>('POST', '/v1/auth', { email: this.opts.email, password: this.opts.password });
    this.jwt = { token: r.token, expiresAt: Date.now() + 4.5 * 60_000 }; // tokens live five minutes
    return r.token;
  }

  /**
   * Sends `amount` of `currency` to `address`; returns the batch and the withdrawal row. The batch is
   * verified at once with a TOTP from the account's 2FA secret, as NOWPayments documents for
   * automated payouts; without the secret the batch waits for the code in the dashboard.
   */
  async createPayout(input: { address: string; currency: string; amount: number; ipnCallbackUrl: string; extraId?: string | null; externalId?: string }): Promise<{ batchId: string; payout: NowPayout }> {
    const token = await this.bearer();
    const r = await this.call<{ id: string | number; withdrawals: NowPayout[] }>(
      'POST',
      '/v1/payout',
      {
        ipn_callback_url: input.ipnCallbackUrl,
        // unique_external_id: our withdrawal id, so a retry can never create a second payout for the same money.
        withdrawals: [{ address: input.address, currency: input.currency, amount: input.amount, ipn_callback_url: input.ipnCallbackUrl, ...(input.externalId ? { unique_external_id: input.externalId } : {}), ...(input.extraId ? { extra_id: input.extraId } : {}) }],
      },
      { Authorization: `Bearer ${token}` },
    );
    const batchId = String(r.id);
    if (this.opts.twoFactorSecret) {
      await this.call('POST', `/v1/payout/${batchId}/verify`, { verification_code: totpAt(this.opts.twoFactorSecret, currentStep()) }, { Authorization: `Bearer ${token}` });
    }
    return { batchId, payout: r.withdrawals[0]! };
  }

  async getPayout(payoutId: string): Promise<NowPayout> {
    return this.call<NowPayout>('GET', `/v1/payout/${payoutId}`, undefined, { Authorization: `Bearer ${await this.bearer()}` });
  }

  /** After a timeout: did the provider create a payout for this withdrawal? Looks through recent payouts for our unique_external_id. */
  async findPayoutByExternalId(externalId: string, since: Date): Promise<NowPayout | null> {
    const token = await this.bearer();
    const from = since.toISOString().slice(0, 10);
    for (let page = 0; page < 10; page++) {
      const r = await this.call<{ data?: NowPayout[] } | NowPayout[]>('GET', `/v1/payout?limit=100&page=${page}&date_from=${from}&order_by=created_at&order=desc`, undefined, { Authorization: `Bearer ${token}` });
      const rows = Array.isArray(r) ? r : (r.data ?? []);
      const hit = rows.find((w) => String(w.unique_external_id ?? '') === externalId);
      if (hit) return hit;
      if (rows.length < 100) break;
    }
    return null;
  }

  /** Legacy interface: used by the old synchronous withdrawal path; the new flow goes through createPayout. */
  async payout(destination: string, amountCents: number, currency: string, _idempotencyKey: string) {
    const [address, coin] = destination.split('|');
    const { batchId } = await this.createPayout({ address: address!, currency: coin ?? this.outcomeCurrency, amount: amountCents / 100, ipnCallbackUrl: '' });
    void currency;
    return { ref: batchId };
  }

  async platformPayout(amountCents: number, currency: string, idempotencyKey: string) {
    return { ref: `manual:${idempotencyKey}:${amountCents}:${currency}` };
  }

  /** Store balance in the outcome currency, read as USD (USDT/USDC); other wallets are not summed. */
  async platformBalance(currency: string) {
    if (currency !== 'USD') return null;
    try {
      const r = await this.call<Record<string, { amount: number; pendingAmount?: number }>>('GET', '/v1/balance');
      const w = r[this.outcomeCurrency];
      if (!w) return null;
      return Math.round((Number(w.amount) + Number(w.pendingAmount ?? 0)) * 100);
    } catch {
      return null;
    }
  }

  // --- Card-era parts with no crypto equivalent ---------------------------------------------
  async submitChargebackEvidence() {
    throw new Error('Chargebacks do not exist for crypto payments');
  }
  async createPayoutAccount(seller: { id: string }) {
    return { accountRef: `crypto:${seller.id}` };
  }
  async payoutOnboardingLink(_accountRef: string, returnUrl: string) {
    return { url: returnUrl };
  }
  async payoutAccountStatus() {
    return { payoutsEnabled: false, requirementsDue: ['payout_address'] };
  }
}
