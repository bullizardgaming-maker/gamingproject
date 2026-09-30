import PDFDocument from 'pdfkit';
import type { Ctx } from '../context.js';
import { many, maybeOne, one, withTx } from '../db.js';
import { notFound } from '../lib/errors.js';
import { notify } from './notifications.js';
import { enqueueWebhook } from './webhooks.js';

/**
 * Monthly commission invoices. One per seller, month and currency, covering every order
 * whose commission was earned (escrow released) that month. Numbers are gapless per
 * series and year ("BZ-2026-000042"), invoices are immutable (DB trigger), and the
 * seller's and platform's details are snapshotted at issue time.
 */
export interface InvoiceLine {
  orderId: string;
  completedAt: string;
  description: string;
  grossCents: number;
  taxCents: number;
  netCents: number;
  rateBps: number;
  treatment: string;
  country: string;
}

const TREATMENT_NOTE: Record<string, string> = {
  standard: '',
  reverse_charge: 'Reverse charge: VAT to be accounted for by the recipient (Art. 196 Directive 2006/112/EC).',
  outside_scope: 'Outside the scope of VAT/GST of the issuer.',
};

/** First day of the month of `d` (UTC), as YYYY-MM-DD. */
export const monthStart = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
const nextMonth = (start: string) => {
  const d = new Date(`${start}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return monthStart(d);
};

/** Issue invoices for one month (idempotent: sellers already invoiced for it are skipped). */
export async function issueMonthlyInvoices(ctx: Ctx, periodStart: string) {
  const periodEnd = nextMonth(periodStart);
  const due = await many<{ seller_id: string; currency: string }>(
    ctx.db,
    `SELECT DISTINCT o.seller_id, o.currency FROM orders o
      WHERE o.tax_treatment IS NOT NULL AND o.commission_cents > 0 AND o.completed_at >= $1::date AND o.completed_at < $2::date
        AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.seller_id = o.seller_id AND i.period_start = $1::date AND i.currency = o.currency)`,
    [periodStart, periodEnd],
  );
  const issued: string[] = [];
  for (const d of due) {
    const inv = await issueInvoice(ctx, d.seller_id, d.currency, periodStart, periodEnd);
    if (inv) issued.push(inv.number);
  }
  return { period: periodStart, issued };
}

async function issueInvoice(ctx: Ctx, sellerId: string, currency: string, periodStart: string, periodEnd: string) {
  return withTx(ctx.db, async (tx) => {
    const series = `${ctx.cfg.INVOICE_SERIES}-${periodStart.slice(0, 4)}`;
    // Taking the sequence row lock first serializes issuers, so the existence check below is reliable
    // and a number is only consumed by an invoice that is actually written.
    await tx.query('INSERT INTO invoice_sequences (series) VALUES ($1) ON CONFLICT DO NOTHING', [series]);
    const seq = await one<{ next: number }>(tx, 'SELECT next FROM invoice_sequences WHERE series = $1 FOR UPDATE', [series]);
    if (await maybeOne(tx, 'SELECT 1 FROM invoices WHERE seller_id = $1 AND period_start = $2 AND currency = $3', [sellerId, periodStart, currency])) return null;

    const orders = await many(
      tx,
      `SELECT o.id, o.completed_at, o.commission_cents, o.commission_tax_cents, o.tax_rate_bps, o.tax_treatment, o.tax_country, f.title
         FROM orders o JOIN offers f ON f.id = o.offer_id
        WHERE o.seller_id = $1 AND o.currency = $2 AND o.tax_treatment IS NOT NULL AND o.commission_cents > 0
          AND o.completed_at >= $3::date AND o.completed_at < $4::date
        ORDER BY o.completed_at`,
      [sellerId, currency, periodStart, periodEnd],
    );
    if (!orders.length) return null;
    const lines: InvoiceLine[] = orders.map((o) => ({
      orderId: o.id,
      completedAt: new Date(o.completed_at).toISOString(),
      description: `Marketplace commission, order ${String(o.id).slice(0, 8)} (${String(o.title).slice(0, 60)})`,
      grossCents: Number(o.commission_cents),
      taxCents: Number(o.commission_tax_cents),
      netCents: Number(o.commission_cents) - Number(o.commission_tax_cents),
      rateBps: o.tax_rate_bps,
      treatment: o.tax_treatment,
      country: o.tax_country,
    }));
    const totalsMap = new Map<string, { treatment: string; rateBps: number; country: string; netCents: number; taxCents: number; grossCents: number }>();
    for (const l of lines) {
      const k = `${l.treatment}:${l.rateBps}:${l.country}`;
      const t = totalsMap.get(k) ?? { treatment: l.treatment, rateBps: l.rateBps, country: l.country, netCents: 0, taxCents: 0, grossCents: 0 };
      t.netCents += l.netCents;
      t.taxCents += l.taxCents;
      t.grossCents += l.grossCents;
      totalsMap.set(k, t);
    }
    const totals = [...totalsMap.values()];
    const sum = (f: 'netCents' | 'taxCents' | 'grossCents') => lines.reduce((s, l) => s + l[f], 0);

    const seller = await one(
      tx,
      `SELECT COALESCE(legal_name, display_name) AS name, email, tax_country AS country, tax_id, tax_id_verified_at IS NOT NULL AS tax_id_verified,
              is_business, billing_address AS address FROM users WHERE id = $1`,
      [sellerId],
    );
    const issuer = { name: ctx.cfg.PLATFORM_LEGAL_NAME, country: ctx.cfg.PLATFORM_TAX_COUNTRY, vatId: ctx.cfg.PLATFORM_VAT_ID ?? null, address: ctx.cfg.PLATFORM_ADDRESS };
    const number = `${series}-${String(seq.next).padStart(6, '0')}`;
    await tx.query('UPDATE invoice_sequences SET next = next + 1 WHERE series = $1', [series]);
    const inv = await one(
      tx,
      `INSERT INTO invoices (number, seller_id, period_start, period_end, currency, net_cents, tax_cents, gross_cents, seller, issuer, lines, totals)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [number, sellerId, periodStart, periodEnd, currency, sum('netCents'), sum('taxCents'), sum('grossCents'), seller, issuer, JSON.stringify(lines), JSON.stringify(totals)],
    );
    const summary = {
      invoice_id: inv.id, number, period_start: periodStart, period_end: periodEnd, currency,
      net_cents: sum('netCents'), tax_cents: sum('taxCents'), gross_cents: sum('grossCents'),
    };
    await enqueueWebhook(tx, sellerId, 'invoice.issued', summary);
    await notify(tx, sellerId, 'invoice_issued', { ...summary, period: periodStart.slice(0, 7) }, `invoice_issued:${inv.id}`);
    return inv;
  });
}

let lastCheck = 0;
/** Worker hook: hourly, issue last month's invoices for anyone not yet invoiced. */
export async function maybeIssueInvoices(ctx: Ctx) {
  if (Date.now() - lastCheck < 3_600_000) return null;
  lastCheck = Date.now();
  const now = new Date();
  const lastMonth = monthStart(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
  return issueMonthlyInvoices(ctx, lastMonth);
}

export async function listInvoices(ctx: Ctx, sellerId: string) {
  return many(
    ctx.db,
    'SELECT id, number, period_start, period_end, currency, net_cents, tax_cents, gross_cents, issued_at FROM invoices WHERE seller_id = $1 ORDER BY period_start DESC, number DESC',
    [sellerId],
  );
}

export async function getInvoice(ctx: Ctx, id: string, sellerId: string | null) {
  const inv = await maybeOne(ctx.db, 'SELECT * FROM invoices WHERE id = $1 AND ($2::uuid IS NULL OR seller_id = $2)', [id, sellerId]);
  if (!inv) throw notFound('Invoice');
  return inv;
}

const money = (cents: number, cur: string) => `${(cents / 100).toFixed(2)} ${cur}`;

export function invoicePdf(inv: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Invoice ${inv.number}` } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).text('Invoice', { continued: true }).fontSize(10).text(`   ${inv.number}`);
    doc.moveDown(0.5).fontSize(9);
    doc.text(`Issued: ${new Date(inv.issued_at).toISOString().slice(0, 10)}`);
    doc.text(`Period: ${String(inv.period_start).slice(0, 10)} to ${new Date(new Date(inv.period_end).getTime() - 86_400_000).toISOString().slice(0, 10)}`);
    doc.moveDown();
    const i = inv.issuer;
    doc.fontSize(10).text('From', { underline: true }).fontSize(9).text(i.name).text(i.address || '').text(`Country: ${i.country}${i.vatId ? `   VAT: ${i.vatId}` : ''}`);
    doc.moveDown(0.5);
    const s = inv.seller;
    doc.fontSize(10).text('To', { underline: true }).fontSize(9).text(s.name).text(s.address || '').text(`Country: ${s.country ?? '-'}${s.tax_id ? `   VAT: ${s.country}${s.tax_id}${s.tax_id_verified ? ' (verified)' : ''}` : ''}`);
    doc.moveDown();

    doc.fontSize(10).text('Lines', { underline: true }).fontSize(8);
    for (const l of inv.lines as InvoiceLine[]) {
      doc.text(`${l.completedAt.slice(0, 10)}  ${l.description}`, { continued: true }).text(
        `   net ${money(l.netCents, inv.currency)}  ${l.treatment === 'standard' ? `VAT ${(l.rateBps / 100).toFixed(2)}% ${money(l.taxCents, inv.currency)}` : l.treatment.replace('_', ' ')}`,
        { align: 'right' },
      );
    }
    doc.moveDown();
    doc.fontSize(10).text('Totals', { underline: true }).fontSize(9);
    for (const t of inv.totals) {
      const label = t.treatment === 'standard' ? `VAT ${(t.rateBps / 100).toFixed(2)}% (${t.country})` : t.treatment.replace('_', ' ');
      doc.text(`${label}: net ${money(t.netCents, inv.currency)}, tax ${money(t.taxCents, inv.currency)}`);
      if (TREATMENT_NOTE[t.treatment]) doc.fontSize(8).text(TREATMENT_NOTE[t.treatment]!).fontSize(9);
    }
    doc.moveDown(0.5).fontSize(11).text(`Total: ${money(inv.gross_cents, inv.currency)} (net ${money(inv.net_cents, inv.currency)} + tax ${money(inv.tax_cents, inv.currency)})`);
    doc.moveDown().fontSize(8).text('Commission was deducted from your sales proceeds; nothing is left to pay.');
    doc.end();
  });
}
