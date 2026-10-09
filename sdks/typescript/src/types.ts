/** Shapes returned by the Bullizard seller API. Money is always in minor units (cents). */

export type OrderStatus = 'awaiting_payment' | 'paid' | 'delivered' | 'completed' | 'disputed' | 'refunded' | 'cancelled' | 'charged_back';

export interface MerchantOrder {
  id: string;
  offer_id: string;
  offer_title: string;
  buyer_id: string;
  quantity: number;
  amount_cents: number;
  currency: string;
  /** Commission rate in basis points (1299 = 12.99%). */
  commission_bps: number;
  commission_cents: number;
  seller_net_cents: number;
  status: OrderStatus;
  rail: 'fiat' | 'crypto';
  protection: 'inspection_72h' | 'insurance_14d';
  protection_ends_at: string | null;
  paid_at: string | null;
  delivered_at: string | null;
  completed_at: string | null;
  created_at: string;
  chat_room_id: string;
}

export interface ListOrdersQuery {
  status?: OrderStatus;
  /** Only orders updated at or after this time (ISO 8601): use for incremental polling. */
  since?: string;
  /** 1-200, default 50. */
  limit?: number;
}

export interface InventoryUpload {
  offerId: string;
  /** txt: one item per line. json: an array of strings or objects. */
  format: 'txt' | 'json';
  content: string;
}
export interface InventoryResult {
  added: number;
  /** Items skipped because you already uploaded them. */
  duplicates: number;
  available: number;
}

export interface PriceUpdate {
  offerId: string;
  priceCents: number;
  /** Expected offer version; if someone changed the offer first, this update is skipped. */
  version?: number;
}
export interface PriceResult {
  id: string;
  ok: boolean;
  price_cents?: number;
  version?: number;
  error?: string;
}

export interface ChatMessage {
  id: string;
  room_id: string;
  seq: number;
  sender_id: string | null;
  kind: string;
  /** null when the author's chat history was erased. */
  body: string | null;
  flags: string[];
  hash: string;
  created_at: string;
}

export interface Invoice {
  id: string;
  number: string;
  period_start: string;
  period_end: string;
  currency: string;
  net_cents: number;
  tax_cents: number;
  gross_cents: number;
  issued_at: string;
  [key: string]: unknown;
}

export type ReportKind = 'sales' | 'statement' | 'payouts' | 'invoices' | 'credit_notes';
export interface ReportQuery {
  /** YYYY-MM-DD. Default: the first day of this month. */
  from?: string;
  /** YYYY-MM-DD, exclusive. Default: tomorrow. */
  to?: string;
  /** Statement only: which balance (default: your payout currency). */
  currency?: string;
}
export interface ReportJson {
  kind: ReportKind;
  from: string;
  to: string;
  rows: Array<Record<string, unknown>>;
}

export interface WebhookDelivery {
  id: string;
  endpoint_id: string;
  event_type: WebhookEventType;
  status: string;
  attempts: number;
  last_status_code: number | null;
  last_error: string | null;
  created_at: string;
  [key: string]: unknown;
}
export interface WebhookDeliveriesQuery {
  status?: 'failing' | 'dead' | 'pending' | 'succeeded' | 'all';
  endpointId?: string;
  limit?: number;
}

// --- Webhooks ------------------------------------------------------------------------------
interface OrderSummary {
  id: string;
  offer_id: string;
  buyer_id: string;
  quantity: number;
  amount_cents: number;
  currency: string;
  seller_net_cents: number;
  commission_cents: number;
  status: OrderStatus;
  rail: 'fiat' | 'crypto';
  protection: 'inspection_72h' | 'insurance_14d';
}
interface Payout {
  withdrawal_id: string;
  amount_cents: number;
  currency: string;
  status: 'paid' | 'failed';
  provider_ref: string | null;
}

export interface WebhookEventData {
  'order.created': OrderSummary;
  'order.delivered': OrderSummary;
  'order.completed': OrderSummary;
  'order.disputed': OrderSummary & { reason: string };
  'order.refunded': OrderSummary;
  'order.cancelled': OrderSummary;
  'offer.low_stock': { offer_id: string; available: number; threshold: number };
  'chat.message': { room_id: string; order_id: string; seq: number; body: string };
  'chargeback.created': { order_id: string; network: 'visa' | 'mastercard'; reason_code: string; amount_cents: number; seller_protected: boolean };
  'order.clawback': OrderSummary & {
    refund_id: string;
    refund_cents: number;
    paid_by: 'seller' | 'platform' | 'reserve';
    seller_debited_cents: number;
    seller_currency: string;
    credit_note: string;
    fully_refunded: boolean;
  };
  'payout.paid': Payout;
  'payout.failed': Payout & { failure_reason: string };
  'invoice.issued': { invoice_id: string; number: string; period_start: string; period_end: string; currency: string; net_cents: number; tax_cents: number; gross_cents: number };
}
export type WebhookEventType = keyof WebhookEventData;

/** A verified webhook. Narrow on `type` to get the matching `data`. Process each `id` once. */
export type WebhookEvent = { [K in WebhookEventType]: { id: string; type: K; created_at: string; data: WebhookEventData[K] } }[WebhookEventType];
