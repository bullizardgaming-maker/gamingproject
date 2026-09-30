import Stripe from 'stripe';
import type { CheckoutRequest, PaymentEvent, PaymentProvider } from './types.js';

/**
 * Stripe Connect using "separate charges and transfers": the platform account
 * captures the buyer's payment (funds sit in the platform balance = escrow),
 * and on release we create a Transfer of the seller's net amount to their
 * connected account. The commission simply never leaves the platform balance.
 *
 * Checkout uses Stripe-hosted Checkout Sessions (SAQ-A eligible).
 */
export class StripePaymentProvider implements PaymentProvider {
  readonly name = 'stripe';
  private stripe: Stripe;

  constructor(
    secretKey: string,
    private readonly webhookSecret: string,
  ) {
    this.stripe = new Stripe(secretKey);
  }

  async createCheckout(req: CheckoutRequest) {
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'payment',
        customer_email: req.buyerEmail,
        client_reference_id: req.orderId,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: req.currency.toLowerCase(),
              unit_amount: req.amountCents,
              product_data: { name: req.description },
            },
          },
        ],
        payment_intent_data: {
          transfer_group: req.orderId,
          metadata: { orderId: req.orderId },
        },
        metadata: { orderId: req.orderId },
        success_url: req.successUrl,
        cancel_url: req.cancelUrl,
        expires_at: Math.floor(req.expiresAt.getTime() / 1000),
      },
      { idempotencyKey: `checkout_${req.orderId}` },
    );
    return { provider: this.name, ref: session.id, redirectUrl: session.url! };
  }

  async parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<PaymentEvent> {
    const event = this.stripe.webhooks.constructEvent(rawBody, String(headers['stripe-signature'] ?? ''), this.webhookSecret);
    const obj: any = event.data.object;

    switch (event.type) {
      case 'checkout.session.completed': {
        if (obj.payment_status !== 'paid') return { type: 'ignored' };
        const pi: any = await this.stripe.paymentIntents.retrieve(obj.payment_intent as string, { expand: ['latest_charge'] });
        const charge = pi.latest_charge;
        const card = charge?.payment_method_details?.card;
        const checks = card?.checks ?? {};
        return {
          type: 'payment.captured',
          ref: obj.id,
          orderId: obj.metadata.orderId,
          amountCents: obj.amount_total,
          currency: String(obj.currency).toUpperCase(),
          details: {
            avsResult: [checks.address_line1_check, checks.address_postal_code_check].filter(Boolean).join('/') || undefined,
            cvvResult: checks.cvc_check ?? undefined,
            cardBrand: card?.brand,
            cardLast4: card?.last4,
            cardFingerprint: card?.fingerprint,
            billingCountry: charge?.billing_details?.address?.country ?? card?.country,
            raw: { payment_intent: pi.id, charge: charge?.id, outcome: charge?.outcome },
          },
        };
      }
      case 'checkout.session.expired':
        return { type: 'payment.failed', ref: obj.id, orderId: obj.metadata.orderId };
      case 'charge.dispute.created': {
        const charge: any = await this.stripe.charges.retrieve(obj.charge as string);
        const session = await this.stripe.checkout.sessions.list({ payment_intent: charge.payment_intent, limit: 1 });
        const brand = charge.payment_method_details?.card?.brand;
        return {
          type: 'chargeback.created',
          disputeRef: obj.id,
          paymentRef: session.data[0]?.id ?? '',
          network: brand === 'mastercard' ? 'mastercard' : 'visa',
          reasonCode: obj.network_reason_code ?? mapStripeReason(obj.reason, brand),
          amountCents: obj.amount,
        };
      }
      case 'charge.dispute.closed':
        return { type: 'chargeback.closed', disputeRef: obj.id, won: obj.status === 'won' };
      default:
        return { type: 'ignored' };
    }
  }

  async refund(paymentRef: string, amountCents: number) {
    const session = await this.stripe.checkout.sessions.retrieve(paymentRef);
    const refund = await this.stripe.refunds.create(
      { payment_intent: session.payment_intent as string, amount: amountCents },
      { idempotencyKey: `refund_${paymentRef}_${amountCents}` },
    );
    return { ref: refund.id };
  }

  async payout(destination: string, amountCents: number, currency: string, idempotencyKey: string) {
    const transfer = await this.stripe.transfers.create(
      { amount: amountCents, currency: currency.toLowerCase(), destination },
      { idempotencyKey },
    );
    return { ref: transfer.id };
  }

  async submitChargebackEvidence(disputeRef: string, evidence: { summary: string; pdf: Buffer }) {
    const file = await this.stripe.files.create({
      purpose: 'dispute_evidence',
      file: { data: evidence.pdf, name: `representment-${disputeRef}.pdf`, type: 'application/pdf' },
    });
    await this.stripe.disputes.update(disputeRef, {
      evidence: { uncategorized_text: evidence.summary.slice(0, 20_000), uncategorized_file: file.id },
      submit: true,
    });
  }
}

function mapStripeReason(reason: string, brand: string): string {
  const mc = brand === 'mastercard';
  switch (reason) {
    case 'fraudulent':
      return mc ? '4837' : '10.4';
    case 'product_unacceptable':
      return mc ? '4853' : '13.3';
    case 'credit_not_processed':
      return mc ? '4853' : '13.6';
    default:
      return mc ? '4853' : '13.3';
  }
}
