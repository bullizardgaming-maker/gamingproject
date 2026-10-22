import type { Ctx } from '../context.js';
import { many, maybeOne, one } from '../db.js';
import { AppError, badRequest, conflict } from '../lib/errors.js';
import { appendMessage } from './chat.js';
import { withScope } from './events.js';
import { accountId, post, type Posting } from './ledger.js';
import { notify } from './notifications.js';
import { RESERVE_SHARE_BPS, emailData, lockOrder, orderSummary, roomOf, transition } from './orders.js';
import { queueCryptoRefund } from './cryptoPayments.js';
import { sellerLeg, toSellerCurrency } from './sellerfx.js';
import { enqueueWebhook } from './webhooks.js';

/**
 * Refund after release. The protection window is over and the seller was paid, but staff decide
 * the buyer must still get money back (an account reclaimed by its original owner, codes proven
 * invalid, goodwill). Who pays the seller's share:
 *  - seller:   clawed back from their balance; if that goes negative it's a debt repaid by future
 *              sales (and withdrawals stay blocked until it is)
 *  - platform: the platform absorbs it from revenue (goodwill)
 *  - reserve:  the chargeback reserve absorbs it (protected sellers, platform's own failure)
 * The commission share and the tax inside it are always returned, and a credit note is issued.
 * Partial refunds split every part pro rata; the total can't exceed what the buyer paid.
 */
export type RefundPayer = 'seller' | 'platform' | 'reserve';

const share = (part: number, amount: number, total: number) => Math.round((part * amount) / total);

export async function refundAfterRelease(
  ctx: Ctx,
  orderId: string,
  staffId: string,
  input: { amountCents?: number; paidBy: RefundPayer; reason: string },
) {
  return withScope(ctx, async (s) => {
    const order = await lockOrder(s.tx, orderId);
    if (order.rail !== 'fiat') throw badRequest('onchain', 'Crypto escrow refunds are settled on-chain');
    // Checked first: a chargeback (even one won back) means the bank is involved; don't refund twice.
    if (await maybeOne(s.tx, 'SELECT 1 FROM chargebacks WHERE order_id = $1', [order.id])) {
      throw conflict('chargeback_exists', 'The buyer’s bank already reversed this payment');
    }
    if (order.status !== 'completed') throw conflict('not_released', `Only completed orders can be refunded after release (this one is ${order.status})`);
    const done = await one<{ s: number }>(s.tx, 'SELECT COALESCE(SUM(amount_cents), 0)::bigint AS s FROM post_release_refunds WHERE order_id = $1', [order.id]);
    const remaining = Number(order.amount_cents) - Number(done.s);
    const amount = input.amountCents ?? remaining;
    if (amount <= 0 || amount > remaining) throw badRequest('invalid_amount', `Up to ${remaining} cents can still be refunded`);

    // Pro-rata parts of the order: where the money came from, and where it went at release.
    const total = Number(order.amount_cents);
    const card = share(Number(order.charged_cents), amount, total);
    const promo = share(Number(order.discount_cents), amount, total);
    const credit = amount - card - promo;
    const sellerPart = share(Number(order.seller_net_cents), amount, total);
    const commission = amount - sellerPart;
    const tax = share(Number(order.commission_tax_cents ?? 0), amount, total);
    const reserveCut = share(Math.floor((Number(order.commission_cents) * RESERVE_SHARE_BPS) / 10_000), amount, total);
    const cur = order.currency;

    const refund = await one(
      s.tx,
      `INSERT INTO post_release_refunds (order_id, amount_cents, paid_by, seller_cents, commission_cents, tax_cents, card_cents, reason, decided_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [order.id, amount, input.paidBy, sellerPart, commission, tax, card, input.reason, staffId],
    );

    // Card part back through the PSP (presentment currency, pro rata), keyed per refund.
    let settledBack = card;
    let providerRef: string | null = null;
    const manual = order.payment_provider === 'nowpayments';
    if (manual && card > 0) {
      // Crypto goes back by hand: a liability until the treasury sends it (cryptoPayments.ts).
      providerRef = `manual:${await queueCryptoRefund(s.tx, order, card, `post_release:${input.reason}`)}`;
      await s.tx.query('UPDATE post_release_refunds SET provider_ref = $2 WHERE id = $1', [refund.id, providerRef]);
    } else if (card > 0 && order.payment_ref && order.payment_provider !== 'none') {
      const presentment = share(Number(order.presentment_amount_cents), card, Number(order.charged_cents));
      try {
        const r = await ctx.payments.refund(order.payment_ref, presentment, order.presentment_currency, `post_release_refund_${refund.id}`);
        settledBack = r.settledAmountCents ?? card;
        providerRef = r.ref;
        await s.tx.query('UPDATE post_release_refunds SET provider_ref = $2 WHERE id = $1', [refund.id, r.ref]);
      } catch (err) {
        throw new AppError(502, 'refund_failed', `The payment provider refused the refund: ${(err as Error).message.slice(0, 200)}`);
      }
    }

    const memo = `clawback:${refund.id}`;
    const sources: Posting[] = [
      { account: await accountId(s.tx, 'treasury', cur), amountCents: -(commission - reserveCut - tax) },
      { account: await accountId(s.tx, 'reserve', cur), amountCents: -reserveCut },
      { account: await accountId(s.tx, 'tax_payable', cur), amountCents: -tax },
    ];
    if (input.paidBy === 'seller') sources.push(await sellerLeg(s.tx, order, -sellerPart, memo));
    else sources.push({ account: await accountId(s.tx, input.paidBy === 'platform' ? 'treasury' : 'reserve', cur), amountCents: -sellerPart });
    await post(
      s.tx,
      [
        ...sources,
        { account: await accountId(s.tx, manual ? 'refunds_payable' : 'gateway_clearing', cur), amountCents: settledBack },
        { account: await accountId(s.tx, 'fx_pnl', cur), amountCents: card - settledBack },
        { account: await accountId(s.tx, 'treasury', cur), amountCents: promo },
        { account: await accountId(s.tx, 'user_credit', cur, order.buyer_id), amountCents: credit },
      ],
      memo,
      order.id,
    );

    const credited = await issueCreditNote(ctx, s.tx, order, refund, input.reason);
    const full = amount === remaining;
    if (full) await transition(s.tx, order, 'refunded', staffId, 'refunded_after_release');

    const room = await roomOf(s.tx, order.id);
    await appendMessage(s, room.id, null, 'system', `${(amount / 100).toFixed(2)} ${cur} was refunded to the buyer after release (${input.reason}).`);
    await notify(s.tx, order.buyer_id, 'order_refunded', emailData(order, { amount_cents: amount }), `post_release_refund:${refund.id}:buyer`);
    if (input.paidBy === 'seller') {
      await notify(s.tx, order.seller_id, 'clawback', {
        ...emailData(order),
        amount_cents: toSellerCurrency(order, sellerPart),
        currency: order.seller_currency ?? cur,
        reason: input.reason,
        credit_note: credited.number,
      }, `post_release_refund:${refund.id}:seller`);
    }
    await enqueueWebhook(s.tx, order.seller_id, 'order.clawback', {
      ...orderSummary(order),
      refund_id: refund.id,
      refund_cents: amount,
      paid_by: input.paidBy,
      seller_debited_cents: input.paidBy === 'seller' ? toSellerCurrency(order, sellerPart) : 0,
      seller_currency: order.seller_currency ?? cur,
      credit_note: credited.number,
      fully_refunded: full,
    });
    return { refund: { ...refund, provider_ref: providerRef }, creditNote: credited, fullyRefunded: full };
  });
}

async function issueCreditNote(ctx: Ctx, tx: import('../db.js').Tx, order: any, refund: any, reason: string) {
  const year = new Date().getUTCFullYear();
  const series = `${ctx.cfg.INVOICE_SERIES}-CN-${year}`;
  await tx.query('INSERT INTO invoice_sequences (series) VALUES ($1) ON CONFLICT DO NOTHING', [series]);
  const seq = await one<{ next: number }>(tx, 'SELECT next FROM invoice_sequences WHERE series = $1 FOR UPDATE', [series]);
  await tx.query('UPDATE invoice_sequences SET next = next + 1 WHERE series = $1', [series]);
  const invoice = await maybeOne<{ id: string }>(
    tx,
    `SELECT id FROM invoices WHERE seller_id = $1 AND currency = $2 AND lines @> $3::jsonb`,
    [order.seller_id, order.currency, JSON.stringify([{ orderId: order.id }])],
  );
  const seller = await one(
    tx,
    `SELECT COALESCE(legal_name, display_name) AS name, tax_country AS country, tax_id, is_business, billing_address AS address FROM users WHERE id = $1`,
    [order.seller_id],
  );
  const commission = Number(refund.commission_cents);
  const tax = Number(refund.tax_cents);
  return one(
    tx,
    `INSERT INTO credit_notes (number, seller_id, order_id, refund_id, invoice_id, currency, net_cents, tax_cents, gross_cents,
                               tax_country, tax_rate_bps, tax_treatment, reason, seller, issuer)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
    [
      `${series}-${String(seq.next).padStart(6, '0')}`, order.seller_id, order.id, refund.id, invoice?.id ?? null, order.currency,
      commission - tax, tax, commission, order.tax_country, order.tax_rate_bps, order.tax_treatment, reason, seller,
      { name: ctx.cfg.PLATFORM_LEGAL_NAME, country: ctx.cfg.PLATFORM_TAX_COUNTRY, vatId: ctx.cfg.PLATFORM_VAT_ID ?? null, address: ctx.cfg.PLATFORM_ADDRESS },
    ],
  );
}

export async function listCreditNotes(ctx: Ctx, sellerId: string) {
  return many(ctx.db, 'SELECT * FROM credit_notes WHERE seller_id = $1 ORDER BY issued_at DESC', [sellerId]);
}
