import type { Queryable } from '../db.js';
import { many, maybeOne, one } from '../db.js';
import { badRequest } from '../lib/errors.js';

/**
 * Accounting exports for sellers: sales, balance statement, payouts and invoices, as CSV
 * (for spreadsheets and bookkeeping tools) or JSON (for bots). Amounts are in cents with
 * a currency column, so nothing is lost to rounding or locale formatting.
 */
export const EXPORT_KINDS = ['sales', 'statement', 'payouts', 'invoices'] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

/** CSV cell: quoted when needed; leading = + - @ neutralised so spreadsheets don't run it as a formula. */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: string[], rows: Array<Record<string, unknown>>) {
  return [columns.join(','), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(','))].join('\r\n') + '\r\n';
}

export function exportRange(from?: string, to?: string) {
  const now = new Date();
  const start = from ?? `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const end = to ?? new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
  if (new Date(end) <= new Date(start)) throw badRequest('invalid_range', '`to` must be after `from`');
  if (new Date(end).getTime() - new Date(start).getTime() > 366 * 86_400_000) throw badRequest('range_too_long', 'Export at most one year at a time');
  return { from: start, to: end };
}

const MEMO_LABELS: Array<[RegExp, string]> = [
  [/^escrow_release$/, 'Sale released from escrow'],
  [/^withdrawal:/, 'Payout to your account'],
  [/^withdrawal_failed:/, 'Payout returned (failed)'],
  [/^chargeback_debit$/, 'Chargeback'],
  [/^chargeback_reversal$/, 'Chargeback won (returned)'],
  [/^clawback/, 'Refund after release'],
  [/^adjustment:/, 'Manual correction by staff'],
];
const describe = (memo: string) => MEMO_LABELS.find(([re]) => re.test(memo))?.[1] ?? memo;

export async function buildExport(q: Queryable, sellerId: string, kind: ExportKind, range: { from: string; to: string }, currency: string) {
  switch (kind) {
    case 'sales': {
      const columns = [
        'order_id', 'created_at', 'paid_at', 'completed_at', 'status', 'offer', 'quantity', 'currency', 'amount_cents',
        'commission_bps', 'commission_cents', 'commission_tax_cents', 'seller_net_cents', 'seller_currency', 'seller_credited_cents', 'rail',
      ];
      const rows = await many(
        q,
        `SELECT o.id AS order_id, o.created_at, o.paid_at, o.completed_at, o.status, f.title AS offer, o.quantity, o.currency, o.amount_cents,
                o.commission_bps, o.commission_cents, o.commission_tax_cents, o.seller_net_cents,
                COALESCE(o.seller_currency, o.currency) AS seller_currency,
                CASE WHEN o.status IN ('completed', 'charged_back') THEN round(o.seller_net_cents * COALESCE(o.seller_fx_rate, 1))::bigint END AS seller_credited_cents,
                o.rail
           FROM orders o JOIN offers f ON f.id = o.offer_id
          WHERE o.seller_id = $1 AND o.created_at >= $2::date AND o.created_at < $3::date AND o.status <> 'awaiting_payment'
          ORDER BY o.created_at`,
        [sellerId, range.from, range.to],
      );
      return { columns, rows };
    }
    case 'statement': {
      // Opening balance, every movement with a running balance, closing balance.
      // Read-only lookup (this may run on a replica): no account yet means an empty statement.
      const acc = await maybeOne<{ id: string }>(q, `SELECT id FROM ledger_accounts WHERE owner_id = $1 AND kind = 'seller_available' AND currency = $2`, [sellerId, currency]);
      const account = acc?.id ?? '00000000-0000-0000-0000-000000000000';
      const opening = await one<{ b: number }>(q, 'SELECT COALESCE(SUM(amount_cents), 0)::bigint AS b FROM ledger_entries WHERE account_id = $1 AND created_at < $2::date', [account, range.from]);
      const entries = await many<{ created_at: string; memo: string; order_id: string | null; amount_cents: number }>(
        q,
        `SELECT created_at, memo, order_id, amount_cents FROM ledger_entries WHERE account_id = $1 AND created_at >= $2::date AND created_at < $3::date ORDER BY id`,
        [account, range.from, range.to],
      );
      let balance = Number(opening.b);
      const rows: Array<Record<string, unknown>> = [{ date: range.from, description: 'Opening balance', currency, balance_cents: balance }];
      for (const e of entries) {
        balance += Number(e.amount_cents);
        rows.push({ date: e.created_at, description: describe(e.memo), reference: e.memo, order_id: e.order_id, currency, amount_cents: e.amount_cents, balance_cents: balance });
      }
      rows.push({ date: range.to, description: 'Closing balance', currency, balance_cents: balance });
      return { columns: ['date', 'description', 'reference', 'order_id', 'currency', 'amount_cents', 'balance_cents'], rows };
    }
    case 'payouts':
      return {
        columns: ['withdrawal_id', 'created_at', 'status', 'currency', 'amount_cents', 'provider_ref'],
        rows: await many(
          q,
          `SELECT id AS withdrawal_id, created_at, status, currency, amount_cents, provider_ref FROM withdrawals
            WHERE user_id = $1 AND created_at >= $2::date AND created_at < $3::date ORDER BY created_at`,
          [sellerId, range.from, range.to],
        ),
      };
    case 'invoices':
      return {
        columns: ['number', 'issued_at', 'period_start', 'period_end', 'currency', 'net_cents', 'tax_cents', 'gross_cents', 'invoice_id'],
        rows: await many(
          q,
          `SELECT number, issued_at, period_start, period_end, currency, net_cents, tax_cents, gross_cents, id AS invoice_id FROM invoices
            WHERE seller_id = $1 AND issued_at >= $2::date AND issued_at < $3::date ORDER BY issued_at, number`,
          [sellerId, range.from, range.to],
        ),
      };
  }
}
