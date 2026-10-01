/**
 * Payment provider abstraction. Card data is only ever entered on the provider's
 * hosted checkout page (redirect / hosted iframe), keeping the platform in
 * PCI DSS SAQ-A scope: raw PANs never reach our servers.
 */
export interface CheckoutRequest {
  orderId: string;
  amountCents: number;
  currency: string;
  description: string;
  buyerEmail: string;
  successUrl: string;
  cancelUrl: string;
  expiresAt: Date;
}

export interface CheckoutSession {
  provider: string;
  ref: string;
  redirectUrl: string;
}

export type PaymentEvent =
  | {
      type: 'payment.captured';
      ref: string;
      orderId: string;
      amountCents: number;
      currency: string;
      details: {
        avsResult?: string;
        cvvResult?: string;
        cardBrand?: string;
        cardLast4?: string;
        cardFingerprint?: string;
        billingCountry?: string;
        /** Amount credited to the platform in the settlement currency (after any currency conversion), gross of fees. */
        settledAmountCents?: number;
        /** Processing fee the PSP deducted from this payment, in minor units. */
        feeCents?: number;
        raw?: unknown;
      };
    }
  | { type: 'payment.failed'; ref: string; orderId: string }
  | {
      type: 'chargeback.created';
      disputeRef: string;
      paymentRef: string;
      network: 'visa' | 'mastercard';
      reasonCode: string;
      amountCents: number;
    }
  | { type: 'chargeback.closed'; disputeRef: string; won: boolean }
  | { type: 'payout_account.updated'; accountRef: string; payoutsEnabled: boolean }
  | { type: 'ignored' };

export interface PaymentProvider {
  readonly name: string;
  createCheckout(req: CheckoutRequest): Promise<CheckoutSession>;
  /** Verify signature and normalize the provider webhook. Must throw on bad signature. */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<PaymentEvent>;
  /** Refund in the currency the card was charged in. settledAmountCents = what the PSP debited in the settlement currency, when known. */
  /** `idempotencyKey` must differ for each separate (partial) refund of the same payment. */
  refund(paymentRef: string, amountCents: number, currency: string, idempotencyKey?: string): Promise<{ ref: string; settledAmountCents?: number }>;
  /** Transfer a seller's released funds to their connected account. */
  payout(destination: string, amountCents: number, currency: string, idempotencyKey: string): Promise<{ ref: string }>;
  submitChargebackEvidence(disputeRef: string, evidence: { summary: string; pdf: Buffer }): Promise<void>;
  /** Create the seller's payout account (Stripe Connect Express). Identity/bank details are collected by the PSP. */
  createPayoutAccount(seller: { id: string; email: string }): Promise<{ accountRef: string }>;
  /** A one-time link to the PSP-hosted onboarding flow. */
  payoutOnboardingLink(accountRef: string, returnUrl: string, refreshUrl: string): Promise<{ url: string }>;
  payoutAccountStatus(accountRef: string): Promise<{ payoutsEnabled: boolean; requirementsDue: string[] }>;
  /** Send platform revenue to the company's own bank account. */
  platformPayout(amountCents: number, currency: string, idempotencyKey: string): Promise<{ ref: string }>;
  /** Total platform balance held at the PSP (available + pending), or null if unsupported. */
  platformBalance(currency: string): Promise<number | null>;
}
