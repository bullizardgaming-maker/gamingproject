import { randomUUID } from 'node:crypto';

/**
 * Currency exchange used to buy the currencies sellers are paid in. Amounts are minor units.
 * `buy` converts from one of the platform's balances into another and returns what was
 * actually spent and received; it must be idempotent on `idempotencyKey`.
 */
export interface FxExchange {
  readonly name: string;
  buy(req: { from: string; to: string; toCents: number; idempotencyKey: string }): Promise<{ ref: string; fromCents: number; toCents: number; rate: number }>;
}

/** Dev/test stand-in: converts at `rates` (units of a currency per 1 unit of the settlement currency) plus a spread. */
export class MockFxExchange implements FxExchange {
  readonly name = 'mock';
  readonly executed = new Map<string, { ref: string; fromCents: number; toCents: number; rate: number }>();
  fail: string | null = null;

  constructor(
    private readonly rateOf: (from: string, to: string) => Promise<number>,
    private readonly spreadBps = 50,
  ) {}

  async buy(req: { from: string; to: string; toCents: number; idempotencyKey: string }) {
    const done = this.executed.get(req.idempotencyKey);
    if (done) return done;
    if (this.fail) throw new Error(this.fail);
    const rate = (await this.rateOf(req.from, req.to)) * (1 - this.spreadBps / 10_000);
    const result = { ref: `mock_fx_${randomUUID().slice(0, 8)}`, fromCents: Math.ceil(req.toCents / rate), toCents: req.toCents, rate };
    this.executed.set(req.idempotencyKey, result);
    return result;
  }
}

/**
 * Wise Business multi-currency balance conversion: a quote for the exact target amount, then a
 * balance movement that converts within the profile (both happen at once). Use it when the
 * balances that fund seller payouts live in Wise; another bank's API plugs in the same way.
 */
export class WiseFxExchange implements FxExchange {
  readonly name = 'wise';

  constructor(
    private readonly opts: { baseUrl: string; token: string; profileId: string },
    private readonly http: typeof fetch = fetch,
  ) {}

  private async call(path: string, body: unknown, headers: Record<string, string> = {}) {
    const res = await this.http(`${this.opts.baseUrl}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.opts.token}`, 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Wise ${path} failed (${res.status}): ${text.slice(0, 300)}`);
    return JSON.parse(text) as any;
  }

  async buy(req: { from: string; to: string; toCents: number; idempotencyKey: string }) {
    const p = encodeURIComponent(this.opts.profileId);
    const quote = await this.call(`/v3/profiles/${p}/quotes`, {
      sourceCurrency: req.from,
      targetCurrency: req.to,
      targetAmount: req.toCents / 100,
      payOut: 'BALANCE',
    });
    // The idempotency key makes a retried conversion return the first one instead of converting twice.
    const move = await this.call(`/v2/profiles/${p}/balance-movements`, { quoteId: quote.id }, { 'X-idempotence-uuid': req.idempotencyKey });
    if (move.state && move.state !== 'COMPLETED') throw new Error(`Wise conversion ${move.id} is ${move.state}`);
    const fromCents = Math.round(Number(move.sourceAmount?.value ?? quote.sourceAmount) * 100);
    const toCents = Math.round(Number(move.targetAmount?.value ?? quote.targetAmount) * 100);
    return { ref: String(move.id), fromCents, toCents, rate: Number(move.rate ?? quote.rate) };
  }
}
