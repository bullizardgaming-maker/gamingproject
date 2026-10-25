import type { Ctx } from '../context.js';
import { many, maybeOne, one } from '../db.js';
import { forgetNewsletterContact } from './newsletter.js';
import { sellerBalances } from './sellerfx.js';
import { openMessages } from './chat.js';
import { hashPassword, randomToken, verifyPassword } from '../lib/crypto.js';
import { AppError, unauthorized } from '../lib/errors.js';
import { withScope } from './events.js';
import { sellerAvailable } from './ledger.js';
import { checkSecondFactor } from './mfa.js';
import { revokeOtherSessions } from './sessions.js';
import type { User } from './users.js';

/**
 * GDPR data access (Art. 15/20) and erasure (Art. 17).
 *
 * Erasure anonymises the account instead of deleting rows, because some records
 * must be kept by law or to defend legal claims (Art. 17(3)(b),(e)):
 *  - orders, ledger entries, payouts and chargebacks (accounting / tax / AML retention)
 *  - order chat logs, which are the evidence in disputes and chargebacks and are
 *    hash-chained, so they can't be edited without breaking tamper evidence
 *  - fraud signals, retained for fraud prevention (legitimate interest)
 * Those records stay linked to an anonymised account with no name, email, phone
 * or login. Everything else personal is removed. Retention periods for the kept
 * records must be set in the privacy policy and enforced by a purge job.
 */
export async function exportData(ctx: Ctx, userId: string) {
  const q = ctx.db;
  const [profile, ordersBought, ordersSold, offers, messages, reviewsWritten, reviewsReceived, withdrawals, sessions, kyc] = await Promise.all([
    one(
      q,
      `SELECT id, email, display_name, role, kyc_tier, legal_name, phone, email_verified_at, phone_verified_at,
              wallet_address, (totp_enabled_at IS NOT NULL) AS two_factor_enabled, email_preferences, created_at
         FROM users WHERE id = $1`,
      [userId],
    ),
    many(q, `SELECT o.id, f.title, o.quantity, o.amount_cents, o.currency, o.status, o.rail, o.created_at, o.completed_at FROM orders o JOIN offers f ON f.id = o.offer_id WHERE o.buyer_id = $1 ORDER BY o.created_at`, [userId]),
    many(q, `SELECT o.id, f.title, o.quantity, o.amount_cents, o.commission_cents, o.seller_net_cents, o.currency, o.status, o.created_at, o.completed_at FROM orders o JOIN offers f ON f.id = o.offer_id WHERE o.seller_id = $1 ORDER BY o.created_at`, [userId]),
    many(q, `SELECT id, title, game, category_slug, price_cents, status, created_at FROM offers WHERE seller_id = $1 ORDER BY created_at`, [userId]),
    many<any>(q, `SELECT * FROM chat_messages WHERE sender_id = $1 ORDER BY created_at`, [userId]).then(async (rows) =>
      (await openMessages(ctx.keyring, q, rows)).map((m) => ({ room_id: m.room_id, seq: m.seq, body: m.body, erased: !!m.erased, created_at: m.created_at })),
    ),
    many(q, `SELECT order_id, rating, comment, created_at FROM reviews WHERE buyer_id = $1`, [userId]),
    many(q, `SELECT order_id, rating, comment, seller_reply, created_at FROM reviews WHERE seller_id = $1 AND NOT hidden`, [userId]),
    many(q, `SELECT id, amount_cents, currency, status, created_at FROM withdrawals WHERE user_id = $1`, [userId]),
    many(q, `SELECT user_agent, host(ip) AS ip, created_at, last_used_at, revoked_at FROM sessions WHERE user_id = $1 ORDER BY created_at`, [userId]),
    many(q, `SELECT provider, level, status, created_at FROM kyc_verifications WHERE user_id = $1`, [userId]),
  ]);
  return {
    exported_at: new Date().toISOString(),
    notice:
      'Identity documents are held by our verification partner; request them from them directly. Fraud-prevention data is withheld where disclosure would undermine fraud detection.',
    profile,
    orders: { bought: ordersBought, sold: ordersSold },
    listings: offers,
    chat_messages: messages,
    reviews: { written: reviewsWritten, received: reviewsReceived },
    withdrawals,
    sign_in_history: sessions,
    identity_verification: kyc,
  };
}

export async function deleteAccount(ctx: Ctx, user: User, password: string, code?: string) {
  const row = await one<{ password_hash: string }>(ctx.db, 'SELECT password_hash FROM users WHERE id = $1', [user.id]);
  if (!(await verifyPassword(password, row.password_hash))) throw unauthorized('Password is incorrect');
  if (user.totp_enabled) {
    if (!code) throw new AppError(400, 'mfa_required', 'Enter your two-factor code to delete your account');
    await checkSecondFactor(ctx, user.id, code);
  }

  // Accounts under compliance review can't be erased (records must be kept); generic wording, no tipping off.
  const review = await maybeOne(ctx.db, `SELECT 1 FROM aml_cases WHERE user_id = $1 AND status IN ('open', 'escalated', 'reported') LIMIT 1`, [user.id]);
  if (review) throw new AppError(409, 'cannot_close_now', 'Your account cannot be closed right now. Please contact support.');
  const open = await maybeOne(
    ctx.db,
    `SELECT count(*)::int AS n FROM orders WHERE (buyer_id = $1 OR seller_id = $1) AND status IN ('awaiting_payment', 'paid', 'delivered', 'disputed')`,
    [user.id],
  );
  if (open?.n) throw new AppError(409, 'open_orders', `Finish or cancel your ${open.n} open order(s) first`);
  // Every currency the seller holds money in (EUR/EGP sellers too).
  const balances = (await sellerBalances(ctx.db, user.id)).map((b) => Number(b.cents));
  if (balances.some((b) => b > 0)) throw new AppError(409, 'balance_remaining', 'Withdraw your remaining balance first');
  if (balances.some((b) => b < 0)) throw new AppError(409, 'balance_owed', 'Your balance is negative after a chargeback. Contact support to settle it first.');

  const scrambled = await hashPassword(randomToken(32));
  // A newsletter contact that reached Brevo is deleted there before the address is scrubbed here.
  const news = await maybeOne<{ email: string; news_synced_at: string | null }>(ctx.db, 'SELECT email, news_synced_at FROM users WHERE id = $1', [user.id]);
  if (news?.news_synced_at) await forgetNewsletterContact(ctx, news.email); // (the address scrubbed below is the one Brevo had)
  return withScope(ctx, async (s) => {
    await s.tx.query(
      `UPDATE users SET
          email = 'deleted-' || id || '@deleted.invalid', display_name = 'Deleted user', password_hash = $2,
          phone = NULL, legal_name = NULL, wallet_address = NULL,
          totp_secret_ciphertext = NULL, totp_enabled_at = NULL, email_preferences = '{}', news_opt_in = false, news_opt_in_at = NULL, news_synced_email = NULL, news_synced_list = NULL,
          status = 'suspended', suspension_reason = 'account_deleted', deleted_at = now()
        WHERE id = $1`,
      [user.id, scrambled],
    );
    await revokeOtherSessions(s.tx, user.id, null, 'account_deleted');
    await s.tx.query(`UPDATE api_keys SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [user.id]);
    await s.tx.query(`UPDATE webhook_endpoints SET active = false WHERE user_id = $1`, [user.id]);
    await s.tx.query(`UPDATE offers SET status = 'removed', updated_at = now(), version = version + 1 WHERE seller_id = $1`, [user.id]);
    // Undelivered stock (codes, credentials) is personal/commercial data with no retention need.
    await s.tx.query(`DELETE FROM inventory_items WHERE seller_id = $1 AND status = 'available'`, [user.id]);
    await s.tx.query(`DELETE FROM recovery_codes WHERE user_id = $1`, [user.id]);
    await s.tx.query(`DELETE FROM verification_codes WHERE user_id = $1`, [user.id]);
    await s.tx.query(`DELETE FROM password_resets WHERE user_id = $1`, [user.id]);
    await s.tx.query(`DELETE FROM notifications WHERE user_id = $1 AND status = 'pending'`, [user.id]);
    await s.tx.query(`UPDATE owner_proofs SET registration_email = 'redacted', billing_name = NULL, evidence = '{}' WHERE seller_id = $1`, [user.id]);
    await s.tx.query(`UPDATE reviews SET comment = '' WHERE buyer_id = $1`, [user.id]);
    // Storefront: intro and pins cleared; the banner file is deleted once this commits.
    await s.tx.query(`UPDATE users SET shop_intro = '', shop_pinned = '{}' WHERE id = $1`, [user.id]);
    const banner = await s.tx.query<{ storage_key: string }>('DELETE FROM shop_banners WHERE seller_id = $1 RETURNING storage_key', [user.id]);
    for (const b of banner.rows) s.afterCommit.push(() => ctx.storage.delete(b.storage_key));
    return { deleted: true };
  });
}
