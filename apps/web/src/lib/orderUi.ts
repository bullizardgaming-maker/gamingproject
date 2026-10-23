import { t } from '../i18n';
/**
 * How an order is named and labelled across the site.
 *
 * Order codes look like `order#7F3AK2Q`: 7 uppercase letters and digits. When the API sends a
 * `ref` we show it; until then the code is derived from the order id, so the same order always
 * gets the same code.
 */
export function orderCode(o: { id: string; ref?: string | null } | string): string {
  const id = typeof o === 'string' ? o : o.id;
  const given = typeof o === 'string' ? null : o.ref;
  if (given) return given.replace(/^order#/i, '').toUpperCase();
  const hex = id.replace(/[^0-9a-f]/gi, '').slice(0, 12);
  if (hex.length >= 8) return BigInt('0x' + hex).toString(36).toUpperCase().padStart(7, '0').slice(-7);
  return id.replace(/[^0-9a-z]/gi, '').toUpperCase().slice(-7).padStart(7, '0');
}

export const orderRef = (o: Parameters<typeof orderCode>[0]) => `order#${orderCode(o)}`;

/** True when a search term (with or without "order#") points at this order. */
export function matchesOrder(term: string, o: Parameters<typeof orderCode>[0]): boolean {
  const q = term.trim().toLowerCase().replace(/^order#?|^#/, '');
  if (!q) return false;
  const id = typeof o === 'string' ? o : o.id;
  return orderCode(o).toLowerCase().includes(q) || id.toLowerCase().startsWith(q);
}

/** Money-state colour for an order status: held (amber), released (teal), disputed (rose). */
export const STATUS_CHIP: Record<string, string> = {
  awaiting_payment: '',
  paid: 'held',
  delivered: 'held',
  completed: 'released',
  disputed: 'disputed',
  refunded: '',
  cancelled: '',
  expired: '',
};

const KNOWN = ['awaiting_payment', 'paid', 'delivered', 'completed', 'disputed', 'refunded', 'cancelled', 'expired'] as const;
/** Short, human status for chips: "Paid · held", "Delivered", "In dispute"… */
export function statusLabel(status: string): string {
  return (KNOWN as readonly string[]).includes(status) ? t(`ostatus.${status as (typeof KNOWN)[number]}`) : status.replace(/_/g, ' ');
}
