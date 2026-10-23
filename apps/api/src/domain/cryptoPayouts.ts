import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, maybeOne, one, withTx } from '../db.js';
import { hmacSha256, randomToken } from '../lib/crypto.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import type { PaymentEvent } from '../providers/payments/types.js';
import { NowPaymentsProvider } from '../providers/payments/nowpayments.js';
import { accountId, post } from './ledger.js';
import { availableCredit } from './referrals.js';
import { enqueueEmail } from './notifications.js';
import { enqueueWebhook } from './webhooks.js';
import { withScope } from './events.js';
import { checkSecondFactor } from './mfa.js';
import { withdrawable } from './payoutholds.js';
import { PUBLIC_USER_COLUMNS, type User } from './users.js';
import { ensureScreenedForPayout } from './aml.js';
import { coinName } from './cryptoPayments.js';

/**
 * Seller withdrawals in crypto (migration 053).
 *  1. The seller sets a payout address once: confirmed through an email link, plus their 2FA code
 *     when they have one. No waiting period after confirmation.
 *  2. A withdrawal takes WITHDRAWAL_FEE_BPS (6%) with a floor of WITHDRAWAL_FEE_MIN_CENTS ($1.50);
 *     no minimum amount. The gross leaves the seller's balance at once (`withdrawals_pending`).
 *  3. The CFO approves or rejects it. Approval books the fee as revenue and sends the net through
 *     NOWPayments; the IPN marks it paid (hash) or failed (money back to the seller).
 */
const CONFIRM_TTL_MINUTES = 60;
export const PAYOUT_COINS = ['usdttrc20', 'usdterc20', 'usdtbsc', 'usdcerc20', 'usdcbsc', 'usdcsol', 'btc', 'eth', 'ltc', 'trx', 'bnb', 'sol'] as const;

export function withdrawalFee(ctx: Ctx, amountCents: number) {
  return Math.min(amountCents, Math.max(ctx.cfg.WITHDRAWAL_FEE_MIN_CENTS, Math.ceil((amountCents * ctx.cfg.WITHDRAWAL_FEE_BPS) / 10_000)));
}

const tokenHash = (ctx: Ctx, token: string) => hmacSha256(ctx.cfg.FINGERPRINT_KEY, `payout_address:${token}`);

export async function payoutAddressOf(q: Queryable, userId: string) {
  const u = await one<{ payout_address: string | null; payout_address_currency: string | null; payout_address_set_at: string | null }>(
    q, 'SELECT payout_address, payout_address_currency, payout_address_set_at FROM users WHERE id = $1', [userId],
  );
  const pending = await maybeOne<{ address: string; currency: string; created_at: string }>(
    q, `SELECT address, currency, created_at FROM payout_address_changes WHERE user_id = $1 AND confirmed_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1`, [userId],
  );
  return {
    address: u.payout_address,
    currency: u.payout_address_currency,
    currencyName: u.payout_address_currency ? coinName(u.payout_address_currency) : null,
    setAt: u.payout_address_set_at,
    pending: pending ? { address: pending.address, currency: pending.currency, since: pending.created_at } : null,
    coins: PAYOUT_COINS.map((c) => ({ coin: c, name: coinName(c) })),
  };
}

/** Step 1: the seller asks to use a new address; a confirmation link goes to their email. */
export async function requestPayoutAddress(ctx: Ctx, user: User, input: { address: string; currency: string }) {
  const currency = input.currency.toLowerCase();
  if (!(PAYOUT_COINS as readonly string[]).includes(currency)) throw badRequest('unsupported_coin', `Payouts are sent in ${PAYOUT_COINS.map(coinName).join(', ')}`);
  const address = input.address.trim();
  if (!/^[A-Za-z0-9:_-]{10,128}$/.test(address)) throw badRequest('invalid_address', 'That does not look like a wallet address');
  const recent = await one<{ n: number }>(ctx.db, `SELECT count(*)::int AS n FROM payout_address_changes WHERE user_id = $1 AND created_at > now() - interval '1 hour'`, [user.id]);
  if (recent.n >= 5) throw new AppError(429, 'too_many_requests', 'Too many address changes; try again in an hour');
  const token = randomToken(32);
  await withScope(ctx, async (s) => {
    await s.tx.query(`UPDATE payout_address_changes SET expires_at = now() WHERE user_id = $1 AND confirmed_at IS NULL`, [user.id]);
    await s.tx.query(
      `INSERT INTO payout_address_changes (user_id, address, currency, token_hash, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5))`,
      [user.id, address, currency, tokenHash(ctx, token), CONFIRM_TTL_MINUTES],
    );
    await enqueueEmail(s.tx, user.id, 'payout_address_confirm', {
      address, coin: coinName(currency), minutes: CONFIRM_TTL_MINUTES,
      url: `${ctx.cfg.PUBLIC_WEB_URL}/sell/money?confirm-payout-address=${token}`,
      mfa: !!(user as any).totp_enabled_at,
    });
  });
  return payoutAddressOf(ctx.db, user.id);
}

/** Step 2: the link from the email, with the 2FA code when the account has one. Takes effect at once. */
export async function confirmPayoutAddress(ctx: Ctx, user: User, input: { token: string; code?: string }) {
  const row = await maybeOne<{ id: string; address: string; currency: string }>(
    ctx.db, `SELECT id, address, currency FROM payout_address_changes WHERE user_id = $1 AND token_hash = $2 AND confirmed_at IS NULL AND expires_at > now()`, [user.id, tokenHash(ctx, input.token)],
  );
  if (!row) throw badRequest('link_expired', 'This confirmation link is no longer valid; request the change again');
  const mfaOn = !!(await maybeOne(ctx.db, 'SELECT 1 FROM users WHERE id = $1 AND totp_enabled_at IS NOT NULL', [user.id]));
  if (mfaOn) {
    if (!input.code) throw badRequest('mfa_code_required', 'Enter your two-factor code to confirm the new address');
    await checkSecondFactor(ctx, user.id, input.code);
  }
  await withScope(ctx, async (s) => {
    await s.tx.query('UPDATE payout_address_changes SET confirmed_at = now() WHERE id = $1', [row.id]);
    await s.tx.query('UPDATE users SET payout_address = $2, payout_address_currency = $3, payout_address_set_at = now(), payouts_enabled = true WHERE id = $1', [user.id, row.address, row.currency]);
    await enqueueEmail(s.tx, user.id, 'payout_address_changed', { address: row.address, coin: coinName(row.currency) });
    s.notifyUser(user.id, 'payout_address.changed', {});
  });
  return payoutAddressOf(ctx.db, user.id);
}

export async function removePayoutAddress(ctx: Ctx, userId: string) {
  await ctx.db.query('UPDATE users SET payout_address = NULL, payout_address_currency = NULL, payout_address_set_at = NULL, payouts_enabled = false WHERE id = $1', [userId]);
  return payoutAddressOf(ctx.db, userId);
}

/** A withdrawal request: fee computed, gross moved out of the balance, waits for the CFO. */
export async function requestCryptoWithdrawal(ctx: Ctx, userId: string, amountCents: number, currency = ctx.cfg.SETTLEMENT_CURRENCY, opts: { source?: 'balance' | 'credit' } = {}) {
  const source = opts.source ?? 'balance';
  if (!(ctx.payments instanceof NowPaymentsProvider)) throw new AppError(503, 'payouts_unavailable', 'Crypto payouts are not configured');
  await ensureScreenedForPayout(ctx, userId);
  return withScope(ctx, async (s) => {
    const user = await one<User & { payout_address: string | null; payout_address_currency: string | null }>(
      s.tx, `SELECT ${PUBLIC_USER_COLUMNS}, payout_address, payout_address_currency FROM users WHERE id = $1 FOR UPDATE`, [userId],
    );
    if (user.withdrawals_frozen || user.status !== 'active') throw new AppError(423, 'withdrawals_frozen', 'Withdrawals are frozen pending a security review');
    const { aml_hold } = await one<{ aml_hold: boolean }>(s.tx, 'SELECT aml_hold FROM users WHERE id = $1', [userId]);
    if (aml_hold) throw new AppError(423, 'withdrawals_frozen', 'Withdrawals are paused while we complete a routine review');
    if (!user.payout_address || !user.payout_address_currency) throw badRequest('no_payout_address', 'Add and confirm a payout address first');
    // Unverified sellers withdraw freely for their first 30 days; after the ID deadline passes, earnings wait for verification (refund credit does not).
    if (source === 'balance' && user.selling_restricted_at && user.kyc_tier < 2) {
      throw new AppError(403, 'kyc_overdue', 'Verify your identity to withdraw: the 30-day deadline has passed');
    }
    const owing = await maybeOne<{ currency: string }>(
      s.tx,
      `SELECT a.currency FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
        WHERE a.kind = 'seller_available' AND a.owner_id = $1 GROUP BY a.currency HAVING SUM(e.amount_cents) < 0 LIMIT 1`,
      [userId],
    );
    if (owing) throw new AppError(409, 'debt_outstanding', `Your ${owing.currency} balance is below zero; settle it before withdrawing`);
    if (source === 'credit') {
      // Buyer credit (refund-free underpayments, promo credit): no payout hold, just what is not promised to unpaid orders.
      const credit = await availableCredit(s.tx, userId, currency);
      if (amountCents > credit) throw badRequest('insufficient_funds', `Available credit is ${credit} cents`, { availableCents: credit });
    } else {
      const bal = await withdrawable(ctx, s.tx, userId, currency);
      if (amountCents > bal.withdrawableCents) {
        throw badRequest(
          'insufficient_funds',
          bal.heldCents ? `You can withdraw ${bal.withdrawableCents} cents now; ${bal.heldCents} cents from recent sales is on a ${bal.holdDays}-day payout hold` : `Available balance is ${bal.availableCents} cents`,
          { withdrawableCents: bal.withdrawableCents, heldCents: bal.heldCents, upcoming: bal.upcoming },
        );
      }
    }
    const fee = withdrawalFee(ctx, amountCents);
    const net = amountCents - fee;
    if (net <= 0) throw badRequest('amount_too_small', `The fee (${(ctx.cfg.WITHDRAWAL_FEE_MIN_CENTS / 100).toFixed(2)} ${currency} minimum) would take the whole amount`);
    const w = await one(
      s.tx,
      `INSERT INTO withdrawals (user_id, amount_cents, currency, status, fee_cents, net_cents, destination_address, destination_currency, source)
       VALUES ($1, $2, $3, 'pending_approval', $4, $5, $6, $7, $8) RETURNING *`,
      [userId, amountCents, currency, fee, net, user.payout_address, user.payout_address_currency, source],
    );
    await post(
      s.tx,
      [
        { account: await accountId(s.tx, source === 'credit' ? 'user_credit' : 'seller_available', currency, userId), amountCents: -amountCents },
        { account: await accountId(s.tx, 'withdrawals_pending', currency), amountCents },
      ],
      `withdrawal:${w.id}`,
    );
    await enqueueEmail(s.tx, userId, 'withdrawal_requested', { amount_cents: amountCents, fee_cents: fee, net_cents: net, currency, coin: coinName(user.payout_address_currency) });
    return w;
  });
}

export async function listPendingWithdrawals(q: Queryable) {
  return many(
    q,
    `SELECT w.*, u.email, u.display_name, u.kyc_tier, u.trust_level FROM withdrawals w JOIN users u ON u.id = w.user_id
      WHERE w.status IN ('pending_approval', 'processing') ORDER BY w.created_at`,
  );
}

/** CFO decision. Approve: fee to treasury, net sent through NOWPayments. Reject: everything back to the seller. */
export async function decideWithdrawal(ctx: Ctx, id: string, staffId: string, approve: boolean, note?: string) {
  if (!(ctx.payments instanceof NowPaymentsProvider)) throw new AppError(503, 'payouts_unavailable', 'Crypto payouts are not configured');
  const np = ctx.payments;
  const w = await withScope(ctx, async (s) => {
    const w = await maybeOne<any>(s.tx, 'SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE', [id]);
    if (!w) throw notFound('Withdrawal');
    if (w.user_id === staffId) throw forbidden('own_withdrawal', 'You cannot decide your own withdrawal');
    if (w.status !== 'pending_approval') throw conflict('invalid_state', `This withdrawal is ${w.status}`);
    const amount = Number(w.amount_cents);
    const fee = Number(w.fee_cents);
    const net = Number(w.net_cents);
    if (!approve) {
      await s.tx.query(`UPDATE withdrawals SET status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3, updated_at = now() WHERE id = $1`, [id, staffId, note ?? null]);
      await post(
        s.tx,
        [
          { account: await accountId(s.tx, 'withdrawals_pending', w.currency), amountCents: -amount },
          { account: await accountId(s.tx, w.source === 'credit' ? 'user_credit' : 'seller_available', w.currency, w.user_id), amountCents: amount },
        ],
        `withdrawal_rejected:${id}`,
      );
      await enqueueEmail(s.tx, w.user_id, 'withdrawal_failed', { amount_cents: amount, currency: w.currency, reason: note || 'not approved' });
      await enqueueWebhook(s.tx, w.user_id, 'payout.failed', { withdrawal_id: id, amount_cents: amount, currency: w.currency, status: 'rejected', provider_ref: null, failure_reason: note ?? 'not approved' });
      return { ...w, status: 'rejected' };
    }
    await s.tx.query(`UPDATE withdrawals SET status = 'processing', decided_by = $2, decided_at = now(), decision_note = $3, updated_at = now() WHERE id = $1`, [id, staffId, note ?? null]);
    await post(
      s.tx,
      [
        { account: await accountId(s.tx, 'withdrawals_pending', w.currency), amountCents: -amount },
        { account: await accountId(s.tx, 'payouts', w.currency), amountCents: net },
        { account: await accountId(s.tx, 'treasury', w.currency), amountCents: fee },
      ],
      `withdrawal_approved:${id}`,
    );
    return { ...w, status: 'processing', net_cents: net };
  });
  if (w.status !== 'processing') return w;

  try {
    const { batchId, payout } = await np.createPayout({
      address: w.destination_address,
      currency: w.destination_currency,
      amount: Number(w.net_cents) / 100,
      ipnCallbackUrl: `${ctx.apiBaseUrl}/v1/payments/webhook/nowpayments`,
    });
    return await withTx(ctx.db, async (tx) =>
      one(tx, `UPDATE withdrawals SET provider_ref = $2, payout_id = $3, updated_at = now() WHERE id = $1 RETURNING *`, [id, batchId, String(payout.id)]),
    );
  } catch (err) {
    await failWithdrawal(ctx, id, (err as Error).message.slice(0, 200));
    throw new AppError(502, 'payout_failed', 'NOWPayments rejected this payout; the amount is back in the seller’s balance', { reason: (err as Error).message.slice(0, 200) });
  }
}

/** Reverses an approved withdrawal that the provider could not send: fee and net return to the seller. */
async function failWithdrawal(ctx: Ctx, id: string, reason: string) {
  await withScope(ctx, async (s) => {
    const w = await maybeOne<any>(s.tx, 'SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE', [id]);
    if (!w || w.status !== 'processing') return;
    await s.tx.query(`UPDATE withdrawals SET status = 'failed', failure_reason = $2, updated_at = now() WHERE id = $1`, [id, reason]);
    await post(
      s.tx,
      [
        { account: await accountId(s.tx, 'payouts', w.currency), amountCents: -Number(w.net_cents) },
        { account: await accountId(s.tx, 'treasury', w.currency), amountCents: -Number(w.fee_cents) },
        { account: await accountId(s.tx, w.source === 'credit' ? 'user_credit' : 'seller_available', w.currency, w.user_id), amountCents: Number(w.amount_cents) },
      ],
      `withdrawal_failed:${id}`,
    );
    await enqueueEmail(s.tx, w.user_id, 'withdrawal_failed', { amount_cents: Number(w.amount_cents), currency: w.currency, reason });
    await enqueueWebhook(s.tx, w.user_id, 'payout.failed', { withdrawal_id: id, amount_cents: Number(w.amount_cents), currency: w.currency, status: 'failed', provider_ref: w.provider_ref, failure_reason: reason });
  });
}

/** IPN from NOWPayments about a payout (or a poll): paid with a hash, or failed and reversed. */
export async function applyCryptoPayout(ctx: Ctx, ev: Extract<PaymentEvent, { type: 'crypto.payout' }>) {
  const w = await maybeOne<any>(ctx.db, 'SELECT * FROM withdrawals WHERE payout_id = $1 OR (provider_ref = $2 AND $2 IS NOT NULL)', [ev.payoutId, ev.batchId]);
  if (!w) {
    ctx.log.warn({ payoutId: ev.payoutId }, 'IPN for an unknown payout');
    return null;
  }
  if (w.status !== 'processing') return w;
  if (ev.status === 'FINISHED') {
    return withScope(ctx, async (s) => {
      const cur = await one<any>(s.tx, 'SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE', [w.id]);
      if (cur.status !== 'processing') return cur;
      const paid = await one<any>(s.tx, `UPDATE withdrawals SET status = 'paid', tx_hash = $2, updated_at = now() WHERE id = $1 RETURNING *`, [w.id, ev.hash]);
      await enqueueEmail(s.tx, w.user_id, 'withdrawal_paid', { amount_cents: Number(w.net_cents), currency: w.currency, provider_ref: ev.hash ?? w.provider_ref });
      await enqueueWebhook(s.tx, w.user_id, 'payout.paid', { withdrawal_id: w.id, amount_cents: Number(w.net_cents), currency: w.currency, status: 'paid', provider_ref: ev.hash ?? w.provider_ref });
      s.notifyUser(w.user_id, 'withdrawal.paid', { withdrawalId: w.id });
      return paid;
    });
  }
  if (ev.status === 'FAILED' || ev.status === 'REJECTED') {
    await failWithdrawal(ctx, w.id, ev.error ?? ev.status.toLowerCase());
    return maybeOne(ctx.db, 'SELECT * FROM withdrawals WHERE id = $1', [w.id]);
  }
  return w;
}
