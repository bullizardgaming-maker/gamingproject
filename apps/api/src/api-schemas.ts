import { z } from 'zod';

/**
 * Schemas for the public seller (merchant) API. Routes validate with these and
 * the OpenAPI document is generated from them, so docs and behaviour can't drift.
 */
const uuid = z.string().uuid();
const cents = z.number().int().describe('Amount in minor units (cents)');

export const MerchantOrdersQuery = z.object({
  status: z.enum(['awaiting_payment', 'paid', 'delivered', 'completed', 'disputed', 'refunded', 'cancelled', 'charged_back']).optional(),
  since: z.string().datetime().optional().describe('Only orders updated at or after this time (ISO 8601). Use for incremental polling.'),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

export const DeliverBody = z.object({
  payload: z.string().max(8_000).optional().describe('Delivery details (credentials, codes, notes). Stored encrypted; visible only to the buyer.'),
});

export const InventoryUploadBody = z.object({
  offerId: uuid,
  format: z.enum(['txt', 'json']).describe('txt: one item per line. json: array of strings or objects.'),
  content: z.string().min(1).max(10 * 1024 * 1024),
});

export const PricesBody = z.object({
  updates: z
    .array(
      z.object({
        offerId: uuid,
        priceCents: z.number().int().positive().max(100_000_00),
        version: z.number().int().optional().describe('Expected offer version. If another change happened first the update is skipped (optimistic locking).'),
      }),
    )
    .min(1)
    .max(500),
});

export const ChatMessageBody = z.object({ body: z.string().trim().min(1).max(4_000) });

// ---- Responses -------------------------------------------------------------------------
export const MerchantOrder = z.object({
  id: uuid,
  offer_id: uuid,
  offer_title: z.string(),
  buyer_id: uuid,
  quantity: z.number().int(),
  amount_cents: cents,
  currency: z.string(),
  commission_bps: z.number().int().describe('Commission rate in basis points (1299 = 12.99%)'),
  commission_cents: cents,
  seller_net_cents: cents,
  status: z.string(),
  rail: z.enum(['fiat', 'crypto']),
  protection: z.enum(['inspection_72h', 'insurance_14d']),
  protection_ends_at: z.string().nullable(),
  paid_at: z.string().nullable(),
  delivered_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  created_at: z.string(),
  chat_room_id: uuid,
});

export const InventoryResult = z.object({
  added: z.number().int(),
  duplicates: z.number().int().describe('Items skipped because you already uploaded them'),
  available: z.number().int(),
});

export const PricesResult = z.object({
  results: z.array(z.object({ id: uuid, ok: z.boolean(), price_cents: cents.optional(), version: z.number().int().optional(), error: z.string().optional() })),
});

export const ErrorResponse = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});

// ---- Webhooks ---------------------------------------------------------------------------
const OrderSummary = z.object({
  id: uuid,
  offer_id: uuid,
  buyer_id: uuid,
  quantity: z.number().int(),
  amount_cents: cents,
  currency: z.string(),
  seller_net_cents: cents,
  commission_cents: cents,
  status: z.string(),
  rail: z.enum(['fiat', 'crypto']),
  protection: z.enum(['inspection_72h', 'insurance_14d']),
});

const Payout = z.object({
  withdrawal_id: uuid,
  amount_cents: cents,
  currency: z.string(),
  status: z.enum(['paid', 'failed']),
  provider_ref: z.string().nullable(),
});

const envelope = <T extends z.ZodTypeAny>(type: string, data: T) =>
  z.object({
    id: z.string().describe('Event id. Also sent as the Idempotency-Key header and unchanged across retries: process each id once.'),
    type: z.literal(type),
    created_at: z.string(),
    data,
  });

export const WEBHOOK_PAYLOADS = {
  'order.created': envelope('order.created', OrderSummary).describe('A buyer paid; funds are held in escrow. Deliver manual orders now.'),
  'order.delivered': envelope('order.delivered', OrderSummary),
  'order.completed': envelope('order.completed', OrderSummary).describe('Escrow released; the net amount is in your balance.'),
  'order.disputed': envelope('order.disputed', OrderSummary.extend({ reason: z.string() })),
  'order.refunded': envelope('order.refunded', OrderSummary),
  'order.cancelled': envelope('order.cancelled', OrderSummary),
  'offer.low_stock': envelope('offer.low_stock', z.object({ offer_id: uuid, available: z.number().int(), threshold: z.number().int() })),
  'chat.message': envelope('chat.message', z.object({ room_id: uuid, order_id: uuid, seq: z.number().int(), body: z.string() })),
  'chargeback.created': envelope(
    'chargeback.created',
    z.object({ order_id: uuid, network: z.enum(['visa', 'mastercard']), reason_code: z.string(), amount_cents: cents, seller_protected: z.boolean() }),
  ),
  'payout.paid': envelope('payout.paid', Payout).describe('A withdrawal was sent to your payout account.'),
  'payout.failed': envelope('payout.failed', Payout.extend({ failure_reason: z.string() })).describe('A withdrawal was rejected by the payment provider; the amount is back in your balance.'),
  'invoice.issued': envelope(
    'invoice.issued',
    z.object({
      invoice_id: uuid,
      number: z.string(),
      period_start: z.string(),
      period_end: z.string().describe('Exclusive'),
      currency: z.string(),
      net_cents: cents,
      tax_cents: cents,
      gross_cents: cents,
    }),
  ).describe('Your monthly commission invoice was issued. Fetch the PDF with GET /v1/merchant/invoices/{id}/pdf.'),
} as const;

export const WebhookDeliveriesQuery = z.object({
  status: z.enum(['failing', 'dead', 'pending', 'succeeded', 'all']).default('failing').describe('`failing` = still retrying after an error; `dead` = retries used up'),
  endpointId: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
});
export const ReplayBody = z.object({ since: z.string().datetime().optional().describe('Only deliveries created at or after this time') });
