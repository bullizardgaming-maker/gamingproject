import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, maybeOne, one, withTx } from '../db.js';
import { hmacSha256, randomDigits, randomToken, safeEqual } from '../lib/crypto.js';
import { idDeadlinePassed } from './offers.js';
import { recordSignals } from './fraud.js';
import { assertNotPaused, assertWithdrawalWithinLimits, controls } from './controls.js';
import { hasPermission } from './permissions.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import type { PaymentEvent } from '../providers/payments/types.js';
import { NowPaymentsError, NowPaymentsProvider, type NowPayout } from '../providers/payments/nowpayments.js';
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
import { rulesSettings } from './onboarding.js';

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
/** USDT only at launch (CEO, Oct 24): TRC-20 and BEP-20. More coins need B2's fee booking per coin first. */
export const PAYOUT_COINS = ['usdttrc20', 'usdtbsc'] as const;
/** Coins whose amounts are USD 1:1 for fee booking. */
const USD_STABLE = /^usd[tc]/;
/** What the seller reads when a withdrawal in a coin we no longer pay out in is refused (Round 22b). */
const UNSUPPORTED_COIN_REASON = 'payouts are sent in USDT only; add a USDT (TRC-20 or BEP-20) payout address';

/** Round 22b: every withdrawal is in USD; a balance in another currency waits for Finance's manual conversion (Ops alert). */
export function assertUsdWithdrawal(currency: string) {
  if (String(currency).toUpperCase() !== 'USD') throw badRequest('unsupported_currency', 'Withdrawals are in USD only; contact support about a balance in another currency');
}

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
  // Second factor (always, Round 20): the authenticator when enabled; otherwise a one-time code by SMS to the
  // verified phone, or by a separate email when there is no phone.
  const full = await one<{ totp_enabled_at: string | null; phone: string | null; phone_verified_at: string | null; email: string }>(ctx.db, 'SELECT totp_enabled_at, phone, phone_verified_at, email FROM users WHERE id = $1', [user.id]);
  const via: 'app' | 'sms' | 'email' = full.totp_enabled_at ? 'app' : full.phone && full.phone_verified_at ? 'sms' : 'email';
  const code = via === 'app' ? null : randomDigits(6);
  await withScope(ctx, async (s) => {
    await s.tx.query(`UPDATE payout_address_changes SET expires_at = now() WHERE user_id = $1 AND confirmed_at IS NULL`, [user.id]);
    await s.tx.query(
      `INSERT INTO payout_address_changes (user_id, address, currency, token_hash, expires_at, code_hash, code_via) VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5), $6, $7)`,
      [user.id, address, currency, tokenHash(ctx, token), CONFIRM_TTL_MINUTES, code ? codeHash(ctx, user.id, code) : null, via],
    );
    await enqueueEmail(s.tx, user.id, 'payout_address_confirm', {
      address, coin: coinName(currency), minutes: CONFIRM_TTL_MINUTES,
      url: `${ctx.cfg.PUBLIC_WEB_URL}/sell/money?confirm-payout-address=${token}`,
      mfa: true, via,
    });
    if (code) {
      const body = `Your Bullizard code to confirm a new payout address is ${code}. It expires in ${CONFIRM_TTL_MINUTES} minutes. If you did not ask for this, change your password now.`;
      if (via === 'sms') await ctx.messenger.send({ channel: 'sms', to: full.phone!, body });
      else await enqueueEmail(s.tx, user.id, 'payout_address_code', { code, minutes: CONFIRM_TTL_MINUTES }, `payout_code:${token.slice(0, 16)}`);
    }
  });
  return payoutAddressOf(ctx.db, user.id);
}
const codeHash = (ctx: Ctx, userId: string, code: string) => hmacSha256(ctx.cfg.FINGERPRINT_KEY, `payout_code:${userId}:${code}`);

/** Step 2: the link from the email, with the 2FA code when the account has one. Takes effect at once. */
export async function confirmPayoutAddress(ctx: Ctx, user: User, input: { token: string; code?: string }) {
  const row = await maybeOne<{ id: string; address: string; currency: string; code_hash: string | null; code_attempts: number; code_via: string | null }>(
    ctx.db, `SELECT id, address, currency, code_hash, code_attempts, code_via FROM payout_address_changes WHERE user_id = $1 AND token_hash = $2 AND confirmed_at IS NULL AND expires_at > now()`, [user.id, tokenHash(ctx, input.token)],
  );
  if (!row) throw badRequest('link_expired', 'This confirmation link is no longer valid; request the change again');
  if (!input.code) throw badRequest('mfa_code_required', row.code_via === 'app' || !row.code_hash ? 'Enter your two-factor code to confirm the new address' : `Enter the code we sent by ${row.code_via === 'sms' ? 'SMS' : 'email'} to confirm the new address`);
  const mfaOn = !!(await maybeOne(ctx.db, 'SELECT 1 FROM users WHERE id = $1 AND totp_enabled_at IS NOT NULL', [user.id]));
  if (mfaOn || !row.code_hash) {
    await checkSecondFactor(ctx, user.id, input.code);
  } else {
    if (row.code_attempts >= 5) throw badRequest('link_expired', 'Too many wrong codes; request the change again');
    if (!safeEqual(codeHash(ctx, user.id, input.code), row.code_hash)) {
      await ctx.db.query('UPDATE payout_address_changes SET code_attempts = code_attempts + 1 WHERE id = $1', [row.id]);
      throw new AppError(401, 'invalid_code', 'Incorrect code');
    }
  }
  await withScope(ctx, async (s) => {
    await s.tx.query('UPDATE payout_address_changes SET confirmed_at = now() WHERE id = $1', [row.id]);
    await s.tx.query('UPDATE users SET payout_address = $2, payout_address_currency = $3, payout_address_set_at = now(), payouts_enabled = true WHERE id = $1', [user.id, row.address, row.currency]);
    await recordSignals(s.tx, user.id, { wallet: row.address.toLowerCase() }); // a payout wallet shared between accounts links them
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
  assertUsdWithdrawal(currency);
  if (!(ctx.payments instanceof NowPaymentsProvider)) throw new AppError(503, 'payouts_unavailable', 'Crypto payouts are not configured');
  await ensureScreenedForPayout(ctx, userId);
  return withScope(ctx, async (s) => {
    const user = await one<User & { payout_address: string | null; payout_address_currency: string | null }>(
      s.tx, `SELECT ${PUBLIC_USER_COLUMNS}, payout_address, payout_address_currency FROM users WHERE id = $1 FOR UPDATE`, [userId],
    );
    if (user.withdrawals_frozen || user.status !== 'active') throw new AppError(423, 'withdrawals_frozen', 'Withdrawals are frozen pending a security review');
    const { aml_hold } = await one<{ aml_hold: boolean }>(s.tx, 'SELECT aml_hold FROM users WHERE id = $1', [userId]);
    if (aml_hold) throw new AppError(423, 'withdrawals_frozen', 'Withdrawals are paused while we complete a routine review');
    await assertNotPaused(s.tx, 'withdrawals'); // kill switch (Ops → Controls)
    await assertWithdrawalWithinLimits(s.tx, userId, amountCents); // per-user daily cap (beta)
    if (!user.payout_address || !user.payout_address_currency) throw badRequest('no_payout_address', 'Add and confirm a payout address first');
    // Round 22 (10): only the launch payout coins; an older address in another coin must be replaced with a USDT one.
    if (!(PAYOUT_COINS as readonly string[]).includes(user.payout_address_currency)) {
      throw badRequest('unsupported_coin', `Payouts are sent in ${PAYOUT_COINS.map(coinName).join(', ')}; add a USDT payout address`);
    }
    // Unverified sellers withdraw freely until the ID deadline (rules_settings.id_due_days, staff-set; 30 at launch); after it,
    // earnings wait for verification (refund credit does not).
    const { idDueDays } = await rulesSettings(s.tx);
    if (source === 'balance' && idDeadlinePassed(user, idDueDays)) {
      throw new AppError(403, 'kyc_overdue', `Verify your identity to withdraw: the ${idDueDays}-day deadline has passed`);
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
      WHERE w.status IN ('pending_approval', 'processing', 'unknown') ORDER BY w.created_at`,
  );
}

/** CFO decision. Approve: fee to treasury, net sent through NOWPayments. Reject: everything back to the seller. */
export async function decideWithdrawal(ctx: Ctx, id: string, staff: { id: string; role: string; staff_roles?: string[] | null }, approve: boolean, note?: string) {
  if (!(ctx.payments instanceof NowPaymentsProvider)) throw new AppError(503, 'payouts_unavailable', 'Crypto payouts are not configured');
  const np = ctx.payments;
  const staffId = staff.id;
  const w = await withScope(ctx, async (s) => {
    const w = await maybeOne<any>(s.tx, 'SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE', [id]);
    if (!w) throw notFound('Withdrawal');
    if (w.user_id === staffId) throw forbidden('own_withdrawal', 'You cannot decide your own withdrawal');
    if (w.status !== 'pending_approval') throw conflict('invalid_state', `This withdrawal is ${w.status}`);
    // Kill switch (Round 22): while withdrawals are paused, staff can't approve or send either; rejecting stays possible.
    if (approve) await assertNotPaused(s.tx, 'withdrawals');
    const amount = Number(w.amount_cents);
    const fee = Number(w.fee_cents);
    const net = Number(w.net_cents);
    const c = await controls(s.tx);
    const finance = hasPermission(staff, 'treasury.approve');
    const lead = hasPermission(staff, 'withdrawals.second_approve');
    // CFO B9 + Round 22: Finance always gives the first approval. Above the threshold, or a user above the daily total, the
    // Support Lead (or an admin) adds the second signature, never the same person twice. The Lead never approves alone.
    const userDay = Number((await one<{ s: string }>(s.tx, `SELECT COALESCE(SUM(amount_cents), 0)::bigint AS s FROM withdrawals WHERE user_id = $1 AND status NOT IN ('rejected', 'failed') AND created_at > now() - interval '24 hours'`, [w.user_id])).s);
    // Round 22b: once the first approval said two signatures, it stays two (the user's 24h total can drop afterwards).
    const needsFourEyes = !!w.four_eyes_required || amount > c.four_eyes_withdrawal_cents || userDay > c.four_eyes_user_day_cents;
    const secondStep = needsFourEyes && !!w.first_approved_by;
    if (!finance && !(lead && secondStep)) throw forbidden('finance_first', 'Finance gives the first approval; the Support Lead only adds the second signature on large withdrawals');
    // Round 22b (6): a request made before Round 22 may name a coin we no longer pay out in; it is rejected, money back.
    const unsupported = approve && !(PAYOUT_COINS as readonly string[]).includes(w.destination_currency);
    if (unsupported) {
      approve = false;
      note = 'unsupported_coin';
    }
    if (approve) {
      if (needsFourEyes) {
        if (!w.first_approved_by) {
          await s.tx.query(`UPDATE withdrawals SET first_approved_by = $2, first_approved_at = now(), four_eyes_required = true, decision_note = COALESCE($3, decision_note), updated_at = now() WHERE id = $1`, [id, staffId, note ?? null]);
          return { ...w, first_approved_by: staffId, four_eyes_required: true, status: 'pending_approval', needs_second_approval: true };
        }
        if (w.first_approved_by === staffId) throw forbidden('four_eyes', 'A second person must give the second approval');
        if (!lead) throw forbidden('lead_required', 'Withdrawals above the four-eyes threshold are approved second by the Support Lead or an admin');
      }
      // Round 22 (11): the per-user daily cap is checked again at approval (several requests can each pass on their own).
      const approvedDay = Number((await one<{ s: string }>(s.tx, `SELECT COALESCE(SUM(amount_cents), 0)::bigint AS s FROM withdrawals WHERE user_id = $1 AND id <> $2 AND status IN ('processing', 'unknown', 'paid') AND decided_at > now() - interval '24 hours'`, [w.user_id, id])).s);
      if (approvedDay + amount > c.max_withdrawal_day_cents) {
        throw conflict('withdrawal_limit', `This user's approved withdrawals would exceed ${(c.max_withdrawal_day_cents / 100).toFixed(2)} USD in 24 hours`);
      }
      // B5: the platform pays out at most this much per day, whoever approves. Serialised so two approvals can't both fit.
      await s.tx.query('SELECT pg_advisory_xact_lock(727276)');
      const platformDay = Number((await one<{ s: string }>(s.tx, `SELECT COALESCE(SUM(net_cents), 0)::bigint AS s FROM withdrawals WHERE status IN ('processing', 'unknown', 'paid') AND decided_at > now() - interval '24 hours'`)).s);
      if (platformDay + net > c.max_platform_payout_day_cents) {
        throw conflict('platform_payout_cap', `Today's payouts would exceed the platform cap of ${(c.max_platform_payout_day_cents / 100).toFixed(2)} USD; ${((c.max_platform_payout_day_cents - platformDay) / 100).toFixed(2)} USD is left today`);
      }
    }
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
      await enqueueEmail(s.tx, w.user_id, 'withdrawal_failed', { amount_cents: amount, currency: w.currency, reason: unsupported ? UNSUPPORTED_COIN_REASON : note || 'not approved' });
      await enqueueWebhook(s.tx, w.user_id, 'payout.failed', { withdrawal_id: id, amount_cents: amount, currency: w.currency, status: 'rejected', provider_ref: null, failure_reason: note ?? 'not approved' });
      return { ...w, status: 'rejected', decision_note: note ?? null, ...(unsupported ? { refused: 'unsupported_coin' } : {}) };
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

  return sendPayout(ctx, np, w);
}

/**
 * Hands the payout to the provider, once. The withdrawal id is the idempotency key (NOWPayments
 * unique_external_id), stored on the row BEFORE the call so an IPN or a poll can always find it. A definite
 * rejection (4xx) of the batch reverses the withdrawal; a timeout or a 5xx leaves it `unknown` with the money still
 * booked as paid out — the provider may have sent it — until recheckUnknownPayout() asks the provider. The batch's
 * ids are stored before the 2FA verify step; a failed verify leaves a real (unverified) batch at the provider, so the
 * withdrawal goes `unknown` with `verify_pending` and the job retries the verification. Money never goes back on a guess.
 */
async function sendPayout(ctx: Ctx, np: NowPaymentsProvider, w0: any) {
  const id = w0.id as string;
  await assertNotPaused(ctx.db, 'withdrawals'); // kill switch: nothing leaves while paused; the job sends it once lifted
  // Round 22b (6): an approved withdrawal in a coin we no longer pay out in is reversed, never sent.
  if (!(PAYOUT_COINS as readonly string[]).includes(w0.destination_currency)) {
    await failWithdrawal(ctx, id, 'unsupported_coin', UNSUPPORTED_COIN_REASON);
    throw badRequest('unsupported_coin', `Payouts are sent in ${PAYOUT_COINS.map(coinName).join(', ')}; the amount is back in the seller’s balance`);
  }
  // Round 22b (1): claimed in one statement, and only if it was never handed over (no attempt, no provider ids). Two callers
  // (an approval and the job, or two job processes) can't both get here for the same withdrawal; nothing is sent twice.
  const w = await maybeOne<any>(
    ctx.db,
    `UPDATE withdrawals SET external_id = COALESCE(external_id, $1::text), provider_attempted_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'processing' AND provider_attempted_at IS NULL AND payout_id IS NULL AND provider_ref IS NULL RETURNING *`,
    [id],
  );
  if (!w) {
    ctx.log.warn({ withdrawalId: id }, 'payout already handed to the provider; not sent again');
    throw conflict('payout_already_sent', 'This payout was already handed to the provider; it is checked, never sent twice');
  }
  let batch: { batchId: string; payout: { id: string | number } };
  try {
    batch = await np.createPayoutBatch({
      address: w.destination_address,
      currency: w.destination_currency,
      amount: Number(w.net_cents) / 100,
      ipnCallbackUrl: `${ctx.apiBaseUrl}/v1/payments/webhook/nowpayments`,
      externalId: id,
    });
  } catch (err) {
    const reason = (err as Error).message.slice(0, 200);
    if (err instanceof NowPaymentsError && err.rejected) {
      await failWithdrawal(ctx, id, reason);
      throw new AppError(502, 'payout_failed', 'NOWPayments rejected this payout; the amount is back in the seller’s balance', { reason });
    }
    await ctx.db.query(`UPDATE withdrawals SET status = 'unknown', failure_reason = $2, updated_at = now() WHERE id = $1 AND status = 'processing'`, [id, reason]);
    ctx.log.error({ err, withdrawalId: id }, 'payout outcome unknown; will recheck with the provider');
    throw new AppError(502, 'payout_unknown', 'NOWPayments did not answer; the payout is being checked with the provider before anything is reversed', { reason });
  }
  await ctx.db.query(`UPDATE withdrawals SET provider_ref = $2, payout_id = $3, updated_at = now() WHERE id = $1`, [id, batch.batchId, String(batch.payout.id)]);
  try {
    await np.verifyPayout(batch.batchId);
  } catch (err) {
    const reason = `verify failed: ${(err as Error).message}`.slice(0, 200);
    await ctx.db.query(`UPDATE withdrawals SET status = 'unknown', verify_pending = true, failure_reason = $2, updated_at = now() WHERE id = $1 AND status = 'processing'`, [id, reason]);
    ctx.log.error({ err, withdrawalId: id, batchId: batch.batchId }, 'payout batch created but not verified; will retry the verification');
    throw new AppError(502, 'payout_unknown', 'The payout was created but its verification failed; it is retried before anything is reversed', { reason });
  }
  return withTx(ctx.db, async (tx) =>
    one(tx, `UPDATE withdrawals SET status = 'processing', verify_pending = false, failure_reason = NULL, updated_at = now() WHERE id = $1 AND status IN ('processing', 'unknown') RETURNING *`, [id]),
  );
}

/** Ops "check with provider" waits this long after the payout call (the provider may still be creating it). */
export const RECHECK_MIN_AGE_MINUTES = 10;
/** Two "not found" answers count only this far apart. */
const NOT_FOUND_GAP_MINUTES = 30;

/** What the provider says about one of our payouts, as the IPN would say it. */
const payoutEvent = (id: string, p: NowPayout): Extract<PaymentEvent, { type: 'crypto.payout' }> => ({
  type: 'crypto.payout',
  payoutId: String(p.id),
  batchId: p.batch_withdrawal_id != null ? String(p.batch_withdrawal_id) : null,
  status: String(p.status).toUpperCase() as any,
  hash: p.hash ?? null,
  error: p.error ?? null,
  networkFee: p.fee != null && p.fee !== '' ? Number(p.fee) : null,
  conversionFee: p.conversion_fee != null && p.conversion_fee !== '' ? Number(p.conversion_fee) : null,
  currency: p.currency ? String(p.currency).toLowerCase() : null,
  externalId: id,
  raw: p,
});

/**
 * A withdrawal in `unknown`: ask the provider. With the provider's ids (the batch was created) → its status decides
 * (finished → paid, failed → reversed, unverified → the verification is retried, anything else → processing). Without
 * them → look the payout up by our unique_external_id. "Not found" reverses only after two such answers at least
 * 30 minutes apart AND PAYOUT_UNKNOWN_REVERSE_HOURS after the call. Called by the hourly job and from Ops (`manual`,
 * which must wait RECHECK_MIN_AGE_MINUTES after the call).
 */
export async function recheckUnknownPayout(ctx: Ctx, id: string, opts: { manual?: boolean } = {}) {
  if (!(ctx.payments instanceof NowPaymentsProvider)) throw new AppError(503, 'payouts_unavailable', 'Crypto payouts are not configured');
  const np = ctx.payments;
  const w = await maybeOne<any>(ctx.db, `SELECT * FROM withdrawals WHERE id = $1 AND status = 'unknown'`, [id]);
  if (!w) return null;
  const attemptedAt = new Date(w.provider_attempted_at ?? w.updated_at ?? w.created_at).getTime();
  if (opts.manual && Date.now() - attemptedAt < RECHECK_MIN_AGE_MINUTES * 60_000) {
    throw conflict('too_early', `Wait at least ${RECHECK_MIN_AGE_MINUTES} minutes after the payout call before checking with the provider`);
  }
  const found = w.payout_id ? await np.getPayout(w.payout_id) : await np.findPayoutByExternalId(id, new Date(attemptedAt - 86_400_000));
  if (found) {
    const status = String(found.status).toUpperCase();
    if (w.verify_pending && ['CREATING', 'WAITING'].includes(status) && w.provider_ref) {
      try {
        await np.verifyPayout(w.provider_ref);
      } catch (err) {
        ctx.log.warn({ err, withdrawalId: id }, 'payout verification retry failed; will try again');
        await ctx.db.query(`UPDATE withdrawals SET failure_reason = $2, updated_at = now() WHERE id = $1`, [id, `verify failed: ${(err as Error).message}`.slice(0, 200)]);
        return maybeOne<any>(ctx.db, 'SELECT * FROM withdrawals WHERE id = $1', [id]);
      }
      await ctx.db.query(`UPDATE withdrawals SET verify_pending = false WHERE id = $1`, [id]);
    }
    await applyCryptoPayout(ctx, payoutEvent(id, found));
    return maybeOne<any>(ctx.db, 'SELECT * FROM withdrawals WHERE id = $1', [id]);
  }
  // The provider answered and has no payout for this id. Counted, never acted on at once.
  const r = await one<{ not_found_checks: number }>(
    ctx.db,
    `UPDATE withdrawals SET not_found_checks = not_found_checks + CASE WHEN last_not_found_at IS NULL OR last_not_found_at < now() - make_interval(mins => $2) THEN 1 ELSE 0 END,
            last_not_found_at = CASE WHEN last_not_found_at IS NULL OR last_not_found_at < now() - make_interval(mins => $2) THEN now() ELSE last_not_found_at END, updated_at = now()
      WHERE id = $1 RETURNING not_found_checks`,
    [id, NOT_FOUND_GAP_MINUTES],
  );
  const oldEnough = Date.now() - attemptedAt >= ctx.cfg.PAYOUT_UNKNOWN_REVERSE_HOURS * 3_600_000;
  if (r.not_found_checks >= 2 && oldEnough) {
    await failWithdrawal(ctx, id, `not created at the provider (${w.failure_reason ?? 'timeout'})`);
  }
  return maybeOne<any>(ctx.db, 'SELECT * FROM withdrawals WHERE id = $1', [id]);
}

/**
 * Hourly: every withdrawal left `unknown` is checked with the provider; `processing` ones are polled (an IPN can be
 * lost), and approved ones never handed to the provider (kill switch, crash) are sent.
 */
export async function recheckUnknownPayouts(ctx: Ctx) {
  if (!(ctx.payments instanceof NowPaymentsProvider)) return 0;
  const np = ctx.payments;
  // Round 22b (1): rows are claimed atomically (SKIP LOCKED + a lease: updated_at for `unknown`, last_polled_at for
  // `processing`), so two worker processes never check, poll or send the same withdrawal.
  const rows = await many<{ id: string }>(
    ctx.db,
    `UPDATE withdrawals SET updated_at = now() WHERE id IN (
       SELECT id FROM withdrawals WHERE status = 'unknown' AND updated_at < now() - interval '2 minutes' ORDER BY updated_at LIMIT 50 FOR UPDATE SKIP LOCKED
     ) RETURNING id`,
  );
  let n = 0;
  for (const r of rows) {
    try {
      await recheckUnknownPayout(ctx, r.id);
      n++;
    } catch (err) {
      ctx.log.warn({ err, withdrawalId: r.id }, 'payout recheck failed; will try again');
    }
  }
  const processing = await many<any>(
    ctx.db,
    `UPDATE withdrawals SET last_polled_at = now() WHERE id IN (
       SELECT id FROM withdrawals WHERE status = 'processing' AND (last_polled_at IS NULL OR last_polled_at < now() - interval '30 minutes')
          AND COALESCE(provider_attempted_at, decided_at, updated_at) < now() - interval '10 minutes' ORDER BY updated_at LIMIT 50 FOR UPDATE SKIP LOCKED
     ) RETURNING *`,
  );
  for (const w of processing) {
    try {
      if (!w.provider_attempted_at && !w.payout_id && !w.provider_ref) {
        await sendPayout(ctx, np, w).catch((err) => ctx.log.warn({ err, withdrawalId: w.id }, 'deferred payout not sent'));
      } else if (w.payout_id) {
        await applyCryptoPayout(ctx, payoutEvent(w.id, await np.getPayout(w.payout_id)));
      } else {
        const found = await np.findPayoutByExternalId(w.id, new Date(new Date(w.provider_attempted_at).getTime() - 86_400_000));
        if (found) await applyCryptoPayout(ctx, payoutEvent(w.id, found));
      }
      n++;
    } catch (err) {
      ctx.log.warn({ err, withdrawalId: w.id }, 'payout poll failed; will try again');
    }
  }
  return n;
}

/** Reverses an approved withdrawal that the provider could not send (or definitely failed): fee and net return to the seller. */
async function failWithdrawal(ctx: Ctx, id: string, reason: string, emailReason = reason) {
  await withScope(ctx, async (s) => {
    const w = await maybeOne<any>(s.tx, 'SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE', [id]);
    if (!w || !['processing', 'unknown'].includes(w.status)) return;
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
    await enqueueEmail(s.tx, w.user_id, 'withdrawal_failed', { amount_cents: Number(w.amount_cents), currency: w.currency, reason: emailReason });
    await enqueueWebhook(s.tx, w.user_id, 'payout.failed', { withdrawal_id: id, amount_cents: Number(w.amount_cents), currency: w.currency, status: 'failed', provider_ref: w.provider_ref, failure_reason: reason });
  });
}

/** IPN from NOWPayments about a payout (or a poll): paid with a hash, or failed and reversed. */
export async function applyCryptoPayout(ctx: Ctx, ev: Extract<PaymentEvent, { type: 'crypto.payout' }>) {
  // Matched by the provider's ids, or by our own id (unique_external_id) when they were never stored (Round 22: an IPN
  // arriving while the withdrawal is `unknown` is no longer dropped).
  const w = await maybeOne<any>(
    ctx.db,
    `SELECT * FROM withdrawals WHERE payout_id = $1 OR (provider_ref = $2 AND $2::text IS NOT NULL) OR ($3::text IS NOT NULL AND external_id = $3::text) LIMIT 1`,
    [ev.payoutId, ev.batchId, ev.externalId ?? null],
  );
  if (!w) {
    ctx.log.warn({ payoutId: ev.payoutId }, 'IPN for an unknown payout');
    return null;
  }
  // Round 22b (7): coins sent for a withdrawal we already reversed (balance refunded): the seller was paid twice. Recorded on
  // the withdrawal for Finance and alerted at once; nothing is booked automatically (Finance recovers or writes it off).
  if (w.status === 'failed' && ev.status === 'FINISHED') {
    const first = await maybeOne<any>(
      ctx.db,
      `UPDATE withdrawals SET paid_after_reversal_at = now(), paid_after_reversal_hash = $2, payout_id = COALESCE(payout_id, $3), provider_ref = COALESCE(provider_ref, $4), updated_at = now()
        WHERE id = $1 AND paid_after_reversal_at IS NULL RETURNING *`,
      [w.id, ev.hash, ev.payoutId, ev.batchId],
    );
    if (first) await alertPaidAfterReversal(ctx, first);
    return first ?? w;
  }
  if (w.status !== 'processing' && w.status !== 'unknown') return w;
  if (ev.status === 'FINISHED') {
    return withScope(ctx, async (s) => {
      const cur = await one<any>(s.tx, 'SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE', [w.id]);
      if (cur.status !== 'processing' && cur.status !== 'unknown') return cur;
      // CFO B2: what the provider took on top (network fee, custody conversion) leaves the wallet too; the treasury pays it.
      const feeCents = (v: number | null) => (v && v > 0 && ev.currency && USD_STABLE.test(ev.currency) ? Math.round(v * 100) : 0);
      const networkFee = feeCents(ev.networkFee);
      const conversionFee = feeCents(ev.conversionFee);
      if (ev.networkFee && !(ev.currency && USD_STABLE.test(ev.currency))) ctx.log.warn({ withdrawalId: w.id, currency: ev.currency, fee: ev.networkFee }, 'payout fee in a non-USD coin not booked');
      for (const [memo, cents] of [['payout_network_fee', networkFee], ['payout_conversion_fee', conversionFee]] as const) {
        if (!cents) continue;
        await post(s.tx, [
          { account: await accountId(s.tx, 'gateway_clearing', w.currency), amountCents: cents },
          { account: await accountId(s.tx, 'treasury', w.currency), amountCents: -cents },
        ], `${memo}:${w.id}`);
      }
      const paid = await one<any>(s.tx, `UPDATE withdrawals SET status = 'paid', tx_hash = $2, network_fee_cents = $3, conversion_fee_cents = $4, payout_id = COALESCE(payout_id, $5), provider_ref = COALESCE(provider_ref, $6), verify_pending = false, failure_reason = NULL, updated_at = now() WHERE id = $1 RETURNING *`, [w.id, ev.hash, networkFee, conversionFee, ev.payoutId, ev.batchId]);
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
  // In flight at the provider (WAITING/PROCESSING/SENDING): an `unknown` withdrawal is known again.
  if (w.status === 'unknown' && !(w.verify_pending && ['CREATING', 'WAITING'].includes(ev.status))) {
    return one(ctx.db, `UPDATE withdrawals SET status = 'processing', payout_id = COALESCE(payout_id, $2), provider_ref = COALESCE(provider_ref, $3), failure_reason = NULL, updated_at = now() WHERE id = $1 RETURNING *`, [w.id, ev.payoutId, ev.batchId]);
  }
  return w;
}

/** Finance and admins hear at once (email + an error line for Sentry); Ops alerts repeat it while it is unresolved. */
async function alertPaidAfterReversal(ctx: Ctx, w: any) {
  const title = 'Payout sent after it was reversed';
  const detail = `Withdrawal ${w.id} (user ${w.user_id}, ${(Number(w.net_cents) / 100).toFixed(2)} ${w.currency}) was marked failed and refunded to the balance, then NOWPayments reported it FINISHED (hash ${w.paid_after_reversal_hash ?? 'none'}).`;
  const action = 'Freeze the seller\'s withdrawals, recover the amount from their balance or write it off, and check why the provider sent a payout we had reversed.';
  ctx.log.error({ withdrawalId: w.id, hash: w.paid_after_reversal_hash }, 'payout FINISHED after the withdrawal was reversed');
  const staff = await many<{ id: string }>(ctx.db, `SELECT id FROM users WHERE (role IN ('admin', 'finance') OR staff_roles && ARRAY['admin', 'finance']) AND deleted_at IS NULL AND status = 'active'`);
  for (const st of staff) await enqueueEmail(ctx.db, st.id, 'ops_alert', { title, detail, action }, `paid_after_reversal:${w.id}:${st.id}`);
}
