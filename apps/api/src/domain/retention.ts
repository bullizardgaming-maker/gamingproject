import type { Ctx } from '../context.js';
import { chatLegalHold, shredUserChatKey } from './chatkeys.js';
import { many, maybeOne, one, withTx } from '../db.js';

/**
 * Data retention: deletes or erases personal data once the reason to keep it has passed.
 * Runs once a day (advisory-lock guarded, so one worker at a time) or on demand by an admin.
 *
 * Not purged here, on purpose: orders, the ledger, payouts, withdrawals, chargebacks, disputes
 * and the staff audit log. Those are kept for accounting and legal-claims periods (set them in
 * the privacy policy); accounts that asked to be deleted are already anonymised.
 */
const BATCH = 500;

export function retentionPolicy(ctx: Ctx) {
  const c = ctx.cfg;
  return {
    chatAfterOrderClosedDays: c.RETENTION_CHAT_DAYS,
    inquiryChatDays: c.RETENTION_INQUIRY_CHAT_DAYS,
    deliveredItemsDays: c.RETENTION_DELIVERED_ITEMS_DAYS,
    fraudSignalsDays: c.RETENTION_FRAUD_SIGNALS_DAYS,
    orderIpDays: c.RETENTION_ORDER_IP_DAYS,
    sessionsDays: c.RETENTION_SESSIONS_DAYS,
    notificationsDays: c.RETENTION_NOTIFICATIONS_DAYS,
    inboxDays: c.RETENTION_INBOX_DAYS,
    securityLogsDays: c.RETENTION_SECURITY_LOGS_DAYS,
  };
}

/** Chat rooms past retention: order closed long ago with nothing still contested, or an idle pre-sale chat. */
async function purgeChats(ctx: Ctx) {
  const rooms = await many<{ id: string; messages: number }>(
    ctx.db,
    `SELECT r.id, r.last_seq::int AS messages FROM chat_rooms r LEFT JOIN orders o ON o.id = r.order_id
      WHERE r.purged_at IS NULL
        AND (
          (o.id IS NOT NULL AND o.status IN ('completed', 'refunded', 'cancelled', 'charged_back')
             AND COALESCE(o.completed_at, o.updated_at) < now() - make_interval(days => $1)
             AND NOT EXISTS (SELECT 1 FROM disputes d WHERE d.order_id = o.id AND d.status = 'open')
             AND NOT EXISTS (SELECT 1 FROM chargebacks c WHERE c.order_id = o.id AND c.status NOT IN ('won', 'lost')))
          OR (r.order_id IS NULL AND COALESCE(
                (SELECT max(m.created_at) FROM chat_messages m WHERE m.room_id = r.id), r.created_at) < now() - make_interval(days => $2))
        )
      LIMIT $3`,
    [ctx.cfg.RETENTION_CHAT_DAYS, ctx.cfg.RETENTION_INQUIRY_CHAT_DAYS, BATCH],
  );
  let messages = 0;
  let files = 0;
  for (const room of rooms) {
    // Delete stored images first: a crash here leaves rows pointing at missing files (harmless,
    // purged on the next run), never files nobody can find any more.
    const atts = await many<{ id: string; storage_key: string | null }>(ctx.db, 'SELECT id, storage_key FROM chat_attachments WHERE room_id = $1', [room.id]);
    for (const a of atts) if (a.storage_key) await ctx.storage.delete(a.storage_key);
    files += atts.length;
    await withTx(ctx.db, async (tx) => {
      await tx.query(`SELECT set_config('bullizard.retention', 'on', true)`);
      await tx.query('DELETE FROM chat_attachments WHERE room_id = $1', [room.id]);
      const res = await tx.query('DELETE FROM chat_messages WHERE room_id = $1', [room.id]);
      messages += res.rowCount ?? 0;
      await tx.query('UPDATE chat_rooms SET purged_at = now(), purged_messages = $2 WHERE id = $1', [room.id, res.rowCount ?? 0]);
    });
  }
  return { chatRooms: rooms.length, chatMessages: messages, chatFiles: files };
}

async function count(ctx: Ctx, sql: string, params: unknown[]) {
  return (await ctx.db.query(sql, params)).rowCount ?? 0;
}

export async function runRetention(ctx: Ctx, existingRunId?: string) {
  const run = existingRunId ? { id: existingRunId } : await one<{ id: string }>(ctx.db, `INSERT INTO retention_runs DEFAULT VALUES RETURNING id`);
  const c = ctx.cfg;
  try {
    const counts: Record<string, number> = { ...(await purgeChats(ctx)) };
    counts.deliveredItems = await count(
      ctx,
      `UPDATE inventory_items SET ciphertext = NULL, purged_at = now()
        WHERE status = 'delivered' AND purged_at IS NULL AND delivered_at < now() - make_interval(days => $1)`,
      [c.RETENTION_DELIVERED_ITEMS_DAYS],
    );
    counts.fraudSignals = await count(ctx, `DELETE FROM risk_signals WHERE last_seen < now() - make_interval(days => $1)`, [c.RETENTION_FRAUD_SIGNALS_DAYS]);
    // Deleted accounts: chat kept as evidence through the chargeback window, then erased by destroying the author's key.
    const toShred = await many<{ id: string }>(
      ctx.db,
      `SELECT u.id FROM users u JOIN chat_user_keys k ON k.user_id = u.id
        WHERE u.deleted_at < now() - make_interval(days => $1) AND k.key_ciphertext IS NOT NULL LIMIT 500`,
      [c.RETENTION_ORDER_IP_DAYS],
    );
    counts.chatKeysDestroyed = 0;
    for (const u of toShred) {
      if (!(await chatLegalHold(ctx.db, u.id)) && (await shredUserChatKey(ctx.db, u.id, 'account deleted; retention period over'))) counts.chatKeysDestroyed++;
    }
    counts.orderIps = await count(ctx, `UPDATE orders SET buyer_ip = NULL WHERE buyer_ip IS NOT NULL AND created_at < now() - make_interval(days => $1)`, [c.RETENTION_ORDER_IP_DAYS]);
    counts.sessions = await count(
      ctx,
      `DELETE FROM sessions WHERE expires_at < now() - make_interval(days => $1) OR revoked_at < now() - make_interval(days => $1)`,
      [c.RETENTION_SESSIONS_DAYS],
    );
    counts.notifications = await count(ctx, `DELETE FROM notifications WHERE status <> 'pending' AND created_at < now() - make_interval(days => $1)`, [c.RETENTION_NOTIFICATIONS_DAYS]);
    counts.inboxItems = await count(ctx, `DELETE FROM inbox_items WHERE created_at < now() - make_interval(days => $1)`, [c.RETENTION_INBOX_DAYS]);
    counts.verificationCodes = await count(ctx, `DELETE FROM verification_codes WHERE created_at < now() - make_interval(days => $1)`, [c.RETENTION_SECURITY_LOGS_DAYS]);
    counts.passwordResets = await count(ctx, `DELETE FROM password_resets WHERE created_at < now() - make_interval(days => $1)`, [c.RETENTION_SECURITY_LOGS_DAYS]);
    counts.cspReports = await count(ctx, `DELETE FROM csp_reports WHERE created_at < now() - make_interval(days => $1)`, [c.RETENTION_SECURITY_LOGS_DAYS]);
    // Direct video uploads (Round 23a) never completed within a day: the object and the reservation go.
    const abandoned = await many<{ id: string; storage_key: string }>(ctx.db, `SELECT id, storage_key FROM chat_attachments WHERE status = 'uploading' AND created_at < now() - interval '1 day' LIMIT 500`);
    for (const a of abandoned) {
      await ctx.storage.delete(a.storage_key).catch(() => {});
      await ctx.db.query(`DELETE FROM chat_attachments WHERE id = $1 AND status = 'uploading'`, [a.id]);
    }
    counts.abandonedUploads = abandoned.length;
    // Only needed for the 15-minute CAPTCHA window.
    counts.loginFailures = await count(ctx, `DELETE FROM login_failures WHERE created_at < now() - interval '1 day'`, []);
    await ctx.db.query(`UPDATE retention_runs SET status = 'ok', counts = $2, finished_at = now() WHERE id = $1`, [run.id, JSON.stringify(counts)]);
    return { id: run.id, status: 'ok', counts };
  } catch (err) {
    await ctx.db.query(`UPDATE retention_runs SET status = 'error', error = $2, finished_at = now() WHERE id = $1`, [run.id, (err as Error).message.slice(0, 500)]);
    throw err;
  }
}

/** Once a day across all workers. */
export async function maybeRunScheduledRetention(ctx: Ctx): Promise<boolean> {
  if (!ctx.cfg.RETENTION_ENABLED) return false;
  const runId = await withTx(ctx.db, async (tx) => {
    const { locked } = await one<{ locked: boolean }>(tx, 'SELECT pg_try_advisory_xact_lock(727277) AS locked');
    if (!locked) return null;
    if (await maybeOne(tx, `SELECT 1 FROM retention_runs WHERE started_at > now() - interval '23 hours' LIMIT 1`)) return null;
    return (await one<{ id: string }>(tx, `INSERT INTO retention_runs DEFAULT VALUES RETURNING id`)).id;
  });
  if (!runId) return false;
  await runRetention(ctx, runId).catch((err) => ctx.log.error({ err: (err as Error).message }, 'retention run failed'));
  return true;
}
