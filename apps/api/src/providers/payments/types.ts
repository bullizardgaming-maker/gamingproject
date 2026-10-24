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
        /** Crypto: what the buyer sent above the order total beyond the tolerance; goes to their balance, never to FX gain (CFO B6). */
        overpaidCents?: number;
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
  /** A crypto payment's status changed (NOWPayments IPN); domain/cryptoPayments.ts maps it to the order. */
  | {
      type: 'crypto.payment';
      paymentId: string;
      orderId: string | null;
      purchaseId: string | null;
      status: 'waiting' | 'confirming' | 'confirmed' | 'sending' | 'partially_paid' | 'finished' | 'failed' | 'refunded' | 'expired';
      payCurrency: string;
      payAmount: number;
      actuallyPaid: number;
      actuallyPaidUsd: number | null;
      priceUsd: number;
      outcomeAmount: number | null;
      outcomeCurrency: string | null;
      raw?: unknown;
    }
  /** A crypto payout (seller withdrawal) progressed. */
  | {
      type: 'crypto.payout'; payoutId: string; batchId: string | null; status: 'CREATING' | 'WAITING' | 'PROCESSING' | 'SENDING' | 'FINISHED' | 'FAILED' | 'REJECTED'; hash: string | null; error: string | null;
      /** Fees the provider took on top of the amount sent (CFO B2), in the payout currency. */
      networkFee: number | null; conversionFee: number | null; currency: string | null;
      /** Our withdrawal id (NOWPayments unique_external_id): matches the IPN even before the provider's ids are stored. */
      externalId?: string | null; raw?: unknown;
    }
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
