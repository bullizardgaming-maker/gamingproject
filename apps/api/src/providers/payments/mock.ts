import { randomUUID } from 'node:crypto';
import { hmacSha256, safeEqual } from '../../lib/crypto.js';
import type { CheckoutRequest, PaymentEvent, PaymentProvider } from './types.js';

/**
 * Development/test provider. The "hosted checkout" is a page on the API
 * (/v1/payments/mock/checkout/:ref) which, when submitted, posts a signed
 * webhook back — the same shape of flow as a real PSP.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';
  readonly submittedEvidence: Array<{ disputeRef: string; summary: string; bytes: number }> = [];

  constructor(
    private readonly secret: string,
    private readonly apiBaseUrl: string,
  ) {}

  async createCheckout(req: CheckoutRequest) {
    const ref = `mock_pi_${randomUUID()}`;
    return { provider: this.name, ref, redirectUrl: `${this.apiBaseUrl}/v1/payments/mock/checkout/${ref}` };
  }

  sign(body: string): string {
    return hmacSha256(this.secret, body);
  }

  async parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<PaymentEvent> {
    const sig = String(headers['x-mock-signature'] ?? '');
    if (!safeEqual(sig, this.sign(rawBody.toString('utf8')))) throw new Error('invalid mock webhook signature');
    return JSON.parse(rawBody.toString('utf8')) as PaymentEvent;
  }

  async refund(paymentRef: string) {
    if (this.faults.refund) throw new Error(this.faults.refund);
    return { ref: `mock_re_${paymentRef}_${randomUUID().slice(0, 8)}` };
  }

  /** Fault injection for tests and failover drills: the next calls of that kind throw this message. */
  faults: { payout?: string; refund?: string } = {};

  async payout(_destination: string, _amount: number, _currency: string, idempotencyKey: string) {
    if (this.faults.payout) throw new Error(this.faults.payout);
    return { ref: `mock_tr_${idempotencyKey}` };
  }

  async submitChargebackEvidence(disputeRef: string, evidence: { summary: string; pdf: Buffer }) {
    this.submittedEvidence.push({ disputeRef, summary: evidence.summary, bytes: evidence.pdf.length });
  }

  /**
   * Tests set this to simulate the PSP's reported balance; null skips the external check.
   * A number is the settlement-currency (USD) balance; a record gives balances per currency.
   */
  balanceOverride: number | Record<string, number> | null = null;

  async platformPayout(_amount: number, _currency: string, idempotencyKey: string) {
    return { ref: `mock_po_${idempotencyKey}` };
  }

  async platformBalance(currency: string) {
    const o = this.balanceOverride;
    if (o === null) return null;
    if (typeof o === 'number') return currency === 'USD' ? o : null;
    return o[currency] ?? null;
  }

  /** Mock accounts become payout-enabled when the mock onboarding page is completed. */
  readonly enabledAccounts = new Set<string>();

  async createPayoutAccount(seller: { id: string }) {
    return { accountRef: `mock_acct_${seller.id.slice(0, 8)}` };
  }

  async payoutOnboardingLink(accountRef: string, returnUrl: string) {
    return { url: `${this.apiBaseUrl}/v1/payments/mock/onboarding/${accountRef}?return=${encodeURIComponent(returnUrl)}` };
  }

  async payoutAccountStatus(accountRef: string) {
    const enabled = this.enabledAccounts.has(accountRef);
    return { payoutsEnabled: enabled, requirementsDue: enabled ? [] : ['external_account'] };
  }
}
