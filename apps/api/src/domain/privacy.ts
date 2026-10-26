import type { Ctx } from '../context.js';
import { many, maybeOne, one, type Queryable } from '../db.js';
import { forgetNewsletterContact } from './newsletter.js';
import { openMessages } from './chat.js';
import { hashPassword, randomToken, verifyPassword } from '../lib/crypto.js';
import { AppError, unauthorized } from '../lib/errors.js';
import { withScope, type TxScope } from './events.js';
import { shredUserChatKey } from './chatkeys.js';
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

/** Round 23e (item 2): any seller balance or store credit, in any currency, blocks deletion. */
async function assertNoMoneyLeft(q: Queryable, userId: string) {
  const money = await many<{ kind: string; currency: string; cents: string }>(
    q,
    `SELECT a.kind, a.currency, COALESCE(SUM(e.amount_cents), 0)::bigint AS cents FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
      WHERE a.owner_id = $1 AND a.kind IN ('seller_available', 'user_credit') GROUP BY a.kind, a.currency`,
    [userId],
  );
  const seller = money.filter((m) => m.kind === 'seller_available').map((m) => Number(m.cents));
  if (seller.some((b) => b > 0)) throw new AppError(409, 'balance_remaining', 'Withdraw your remaining balance first');
  if (seller.some((b) => b < 0)) throw new AppError(409, 'balance_owed', 'Your balance is negative after a chargeback. Contact support to settle it first.');
  if (money.some((m) => m.kind === 'user_credit' && Number(m.cents) > 0)) throw new AppError(409, 'credit_remaining', 'Spend your store credit first, or ask support to pay it out');
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
  await assertNoMoneyLeft(ctx.db, user.id); // checked again inside the transaction below, with the row locked
  const scrambled = await hashPassword(randomToken(32));
  // A newsletter contact that reached Brevo is deleted there before the address is scrubbed here.
  const news = await maybeOne<{ email: string; news_synced_email: string | null; news_synced_at: string | null }>(ctx.db, 'SELECT email, news_synced_email, news_synced_at FROM users WHERE id = $1', [user.id]);
  if (news?.news_synced_at) await forgetNewsletterContact(ctx, news.news_synced_email ?? news.email); // the address Brevo actually has (Round 23d)
  return withScope(ctx, async (s) => {
    // Round 23e (item 2): money is checked inside the deletion transaction with the user row locked, in every currency:
    // seller balance (EUR/EGP sellers too) and store credit. Nothing is silently written off with the account.
    await s.tx.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [user.id]);
    await assertNoMoneyLeft(s.tx, user.id);
    await s.tx.query(
      `UPDATE users SET
          email = 'deleted-' || id || '@deleted.invalid', display_name = 'Deleted user', password_hash = $2,
          phone = NULL, legal_name = NULL, wallet_address = NULL, payout_address = NULL, payout_address_currency = NULL,
          totp_secret_ciphertext = NULL, totp_enabled_at = NULL, email_preferences = '{}', news_opt_in = false, news_opt_in_at = NULL, news_synced_email = NULL, news_synced_list = NULL,
          status = 'suspended', suspension_reason = 'account_deleted', deleted_at = now()
        WHERE id = $1`,
      [user.id, scrambled],
    );
    await revokeOtherSessions(s.tx, user.id, null, 'account_deleted');
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
    // Round 23d (item 5): everything else that names, locates or reaches the person.
    await s.tx.query(`UPDATE payout_address_changes SET address = 'redacted', token_hash = 'redacted:' || id WHERE user_id = $1`, [user.id]);
    await s.tx.query(
      `UPDATE linked_accounts SET external_id = 'redacted:' || id, display_name = 'redacted', profile_url = NULL, unlinked_at = COALESCE(unlinked_at, now()), unlink_reason = COALESCE(unlink_reason, 'account_deleted') WHERE user_id = $1`,
      [user.id],
    );
    await s.tx.query(`DELETE FROM push_subscriptions WHERE user_id = $1`, [user.id]);
    await s.tx.query(`DELETE FROM saved_searches WHERE user_id = $1`, [user.id]);
    await s.tx.query(`DELETE FROM watches WHERE user_id = $1`, [user.id]);
    await s.tx.query(`UPDATE support_tickets SET subject = 'Deleted user' WHERE user_id = $1`, [user.id]);
    await s.tx.query(`UPDATE support_messages SET body = '[deleted with the account]' WHERE author_id = $1 AND NOT staff`, [user.id]);
    // KYC: the raw provider payload (document data, addresses, photos' metadata) goes. What AML retention needs stays:
    // provider, applicant id, level, status and dates (5 years, docs/RUNBOOK.md "Retention"). The provider is asked to
    // delete the applicant through the compliance queue (Ops → Privacy), since that call is irreversible.
    const kyc = await s.tx.query<{ provider: string; external_id: string | null }>(
      `UPDATE kyc_verifications SET result = '{}'::jsonb, updated_at = now() WHERE user_id = $1 RETURNING provider, external_id`,
      [user.id],
    );
    for (const k of kyc.rows) {
      if (!k.external_id) continue;
      await s.tx.query(
        `INSERT INTO kyc_deletion_requests (user_id, provider, external_id) VALUES ($1, $2, $3) ON CONFLICT (provider, external_id) DO NOTHING`,
        [user.id, k.provider, k.external_id],
      );
    }
    return { deleted: true };
  });
}

/**
 * Round 23d (item 5) / 23e (item 1): when a user's chat is erased, the files they uploaded go too — rows, names and
 * stored objects (S3 included). One transaction, in the order the foreign keys need: rows that point at the files
 * (boosting progress screenshots, delivery proofs) let go, the attachment rows are deleted and their storage keys are
 * queued; the objects are deleted after commit, and a failed delete stays queued for the retention job. A crash never
 * leaves a row pointing at a missing file, nor a file nobody can find.
 */
export async function eraseUserAttachmentsTx(s: TxScope, ctx: Ctx, userId: string) {
  const atts = await s.tx.query<{ id: string; storage_key: string | null }>('SELECT id, storage_key FROM chat_attachments WHERE uploader_id = $1 FOR UPDATE', [userId]);
  const ids = atts.rows.map((a) => a.id);
  if (!ids.length) return 0;
  const keys = atts.rows.map((a) => a.storage_key).filter((k): k is string => !!k);
  await s.tx.query('UPDATE order_progress SET attachment_id = NULL WHERE attachment_id = ANY($1::uuid[])', [ids]);
  await s.tx.query('UPDATE orders SET delivery_proof_id = NULL WHERE delivery_proof_id = ANY($1::uuid[])', [ids]);
  await s.tx.query('DELETE FROM chat_attachments WHERE id = ANY($1::uuid[])', [ids]);
  await queueStorageDeletions(s, ctx, keys, 'chat_erasure');
  return ids.length;
}

export async function eraseUserAttachments(ctx: Ctx, userId: string) {
  return withScope(ctx, (s) => eraseUserAttachmentsTx(s, ctx, userId));
}

/** Round 23e (item 1): destroy the chat key and the files in one transaction (admin erase-chat and the retention job). */
export async function eraseUserChat(ctx: Ctx, userId: string, reason: string) {
  return withScope(ctx, async (s) => {
    const shredded = await shredUserChatKey(s.tx, userId, reason);
    const files = await eraseUserAttachmentsTx(s, ctx, userId);
    return { shredded, files };
  });
}

/** Queue stored objects for deletion; they are deleted once the transaction commits (and retried later on failure). */
export async function queueStorageDeletions(s: TxScope, ctx: Ctx, keys: string[], reason: string) {
  if (!keys.length) return;
  await s.tx.query(`INSERT INTO storage_deletions (storage_key, reason) SELECT unnest($1::text[]), $2 ON CONFLICT (storage_key) DO NOTHING`, [keys, reason]);
  s.defer(async () => void (await drainStorageDeletions(ctx, keys)));
}

/** Delete queued objects (all due ones, or just `keys`); a failure backs off 2^n minutes (≤ 1 day) and stays queued. */
export async function drainStorageDeletions(ctx: Ctx, keys?: string[], limit = 500) {
  const due = await many<{ storage_key: string; attempts: number }>(
    ctx.db,
    `SELECT storage_key, attempts FROM storage_deletions WHERE ($1::text[] IS NULL OR storage_key = ANY($1::text[])) AND ($1::text[] IS NOT NULL OR next_at <= now()) ORDER BY next_at LIMIT $2`,
    [keys ?? null, limit],
  );
  let deleted = 0;
  for (const d of due) {
    try {
      await ctx.storage.delete(d.storage_key);
      await ctx.db.query('DELETE FROM storage_deletions WHERE storage_key = $1', [d.storage_key]);
      deleted++;
    } catch (err) {
      ctx.log.warn({ key: d.storage_key, attempts: d.attempts + 1, err: (err as Error).message }, 'stored object could not be deleted; will retry');
      await ctx.db.query(
        `UPDATE storage_deletions SET attempts = attempts + 1, last_error = $2, next_at = now() + make_interval(mins => LEAST(1440, power(2, LEAST(attempts + 1, 11))::int)) WHERE storage_key = $1`,
        [d.storage_key, String((err as Error).message).slice(0, 300)],
      );
    }
  }
  return deleted;
}
