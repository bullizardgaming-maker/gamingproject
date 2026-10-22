import type { Ctx } from '../context.js';
import { many, one, withTx } from '../db.js';

/**
 * Data-key rotation. To rotate: append a new key to DATA_ENCRYPTION_KEYS (it becomes the
 * current key for new data), deploy, and let this job re-encrypt everything still under
 * older keys. When `GET /v1/admin/keys` shows nothing left under a key, remove it.
 *
 * Every encrypted field is listed here; a test fails if a ciphertext column is added
 * without being registered.
 */
interface TextTarget {
  name: string;
  table: string;
  id: string;
  /** SQL expression for the ciphertext. */
  column: string;
  /** SQL that writes the new ciphertext ($2) back for row $1. */
  write: string;
  /** SQL expression for the AAD the value was encrypted with. */
  aad: string;
}

export const TEXT_TARGETS: TextTarget[] = [
  {
    name: 'inventory_items',
    table: 'inventory_items',
    id: 'id',
    column: 'ciphertext',
    write: 'UPDATE inventory_items SET ciphertext = $2 WHERE id = $1 AND ciphertext = $3',
    aad: `'inventory:' || offer_id`,
  },
  {
    name: 'webhook_secrets',
    table: 'webhook_endpoints',
    id: 'id',
    column: 'secret_ciphertext',
    write: 'UPDATE webhook_endpoints SET secret_ciphertext = $2 WHERE id = $1 AND secret_ciphertext = $3',
    aad: `'webhook'`,
  },
  {
    name: 'totp_secrets',
    table: 'users',
    id: 'id',
    column: 'totp_secret_ciphertext',
    write: 'UPDATE users SET totp_secret_ciphertext = $2 WHERE id = $1 AND totp_secret_ciphertext = $3',
    aad: `'totp:' || id`,
  },
  {
    name: 'chat_user_keys',
    table: 'chat_user_keys',
    id: 'user_id',
    column: 'key_ciphertext',
    write: 'UPDATE chat_user_keys SET key_ciphertext = $2 WHERE user_id = $1 AND key_ciphertext = $3',
    aad: `'chatkey:' || user_id`,
  },
  {
    name: 'owner_proof_evidence',
    table: 'owner_proofs',
    id: 'id',
    column: `(evidence->>'sealed')`,
    write: `UPDATE owner_proofs SET evidence = jsonb_set(evidence, '{sealed}', to_jsonb($2::text)) WHERE id = $1 AND evidence->>'sealed' = $3`,
    aad: `'owner_proof:' || offer_id`,
  },
];

const BATCH = 200;

const staleWhere = (t: TextTarget) => `${t.column} IS NOT NULL AND split_part(${t.column}, ':', 1) <> $1`;

export async function keyStatus(ctx: Ctx) {
  const current = ctx.keyring.currentVersion;
  const byTarget: Record<string, Record<string, number>> = {};
  for (const t of TEXT_TARGETS) {
    const rows = await many<{ v: string; n: number }>(
      ctx.db,
      `SELECT split_part(${t.column}, ':', 1) AS v, count(*)::int AS n FROM ${t.table} WHERE ${t.column} IS NOT NULL GROUP BY 1`,
    );
    byTarget[t.name] = Object.fromEntries(rows.map((r) => [r.v, r.n]));
  }
  if (ctx.storage.keyVersion !== null) {
    const rows = await many<{ v: string | null; n: number }>(
      ctx.db,
      `SELECT key_version AS v, count(*)::int AS n FROM chat_attachments WHERE storage_key IS NOT NULL GROUP BY 1`,
    );
    byTarget.chat_files = Object.fromEntries(rows.map((r) => [r.v ?? 'unknown', r.n]));
    const banners = await many<{ v: string | null; n: number }>(ctx.db, `SELECT key_version AS v, count(*)::int AS n FROM shop_banners GROUP BY 1`);
    byTarget.shop_banners = Object.fromEntries(banners.map((r) => [r.v ?? 'unknown', r.n]));
  }
  const inUse = new Set(Object.values(byTarget).flatMap((m) => Object.keys(m)));
  // 'missing' = a file row whose file is gone; reported, but nothing left to re-encrypt.
  const remaining = Object.values(byTarget).reduce((sum, m) => sum + Object.entries(m).filter(([v]) => v !== current && v !== 'missing').reduce((s, [, n]) => s + n, 0), 0);
  return {
    current,
    configured: ctx.keyring.versions,
    byTarget,
    remaining,
    // A key can be removed from DATA_ENCRYPTION_KEYS once nothing is encrypted with it.
    safeToRemove: ctx.keyring.versions.filter((v) => v !== current && !inUse.has(v) && !inUse.has('unknown')),
  };
}

/** Re-encrypt one batch per target. Concurrent-safe: each write only applies if the row still holds what was read. */
export async function rotateBatch(ctx: Ctx) {
  const current = ctx.keyring.currentVersion;
  const done: Record<string, number> = {};
  for (const t of TEXT_TARGETS) {
    const rows = await many<{ id: string; ct: string; aad: string }>(
      ctx.db,
      `SELECT ${t.id} AS id, ${t.column} AS ct, ${t.aad} AS aad FROM ${t.table} WHERE ${staleWhere(t)} LIMIT ${BATCH}`,
      [current],
    );
    let n = 0;
    for (const r of rows) {
      const res = await ctx.db.query(t.write, [r.id, ctx.keyring.reencrypt(r.ct, r.aad), r.ct]);
      n += res.rowCount ?? 0;
    }
    done[t.name] = n;
  }
  if (ctx.storage.keyVersion !== null) {
    const files = await many<{ id: string; storage_key: string }>(
      ctx.db,
      `SELECT id, storage_key FROM chat_attachments WHERE storage_key IS NOT NULL AND key_version IS DISTINCT FROM $1 AND key_version IS DISTINCT FROM 'missing' LIMIT ${BATCH}`,
      [current],
    );
    let n = 0;
    for (const f of files) {
      try {
        const v = await ctx.storage.rekey(f.storage_key);
        await ctx.db.query('UPDATE chat_attachments SET key_version = $2 WHERE id = $1', [f.id, v]);
        n++;
      } catch (err) {
        // Missing file (e.g. storage restored from an older backup): record it rather than retry forever.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') await ctx.db.query(`UPDATE chat_attachments SET key_version = 'missing' WHERE id = $1`, [f.id]);
        else throw err;
      }
    }
    done.chat_files = n;
    const banners = await many<{ seller_id: string; storage_key: string }>(
      ctx.db,
      `SELECT seller_id, storage_key FROM shop_banners WHERE key_version IS DISTINCT FROM $1 AND key_version IS DISTINCT FROM 'missing' LIMIT ${BATCH}`,
      [current],
    );
    let b = 0;
    for (const f of banners) {
      try {
        const v = await ctx.storage.rekey(f.storage_key);
        await ctx.db.query('UPDATE shop_banners SET key_version = $2 WHERE seller_id = $1 AND storage_key = $3', [f.seller_id, v, f.storage_key]);
        b++;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') await ctx.db.query(`UPDATE shop_banners SET key_version = 'missing' WHERE seller_id = $1`, [f.seller_id]);
        else throw err;
      }
    }
    done.shop_banners = b;
  }
  return done;
}

/** Keep rotating until nothing is left or the time budget runs out. */
export async function rotateAll(ctx: Ctx, budgetMs = 20_000) {
  const started = Date.now();
  const total: Record<string, number> = {};
  for (;;) {
    const done = await rotateBatch(ctx);
    for (const [k, v] of Object.entries(done)) total[k] = (total[k] ?? 0) + v;
    if (!Object.values(done).some(Boolean) || Date.now() - started > budgetMs) break;
  }
  return total;
}

let lastScheduled = 0;
/** Worker hook: every 10 minutes one worker (advisory lock) rotates for up to 20 seconds. */
export async function maybeRotateKeys(ctx: Ctx) {
  if (Date.now() - lastScheduled < 10 * 60_000) return null;
  lastScheduled = Date.now();
  return withTx(ctx.db, async (tx) => {
    const { locked } = await one<{ locked: boolean }>(tx, 'SELECT pg_try_advisory_xact_lock(727278) AS locked');
    if (!locked) return null;
    return rotateAll(ctx);
  });
}

