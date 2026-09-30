import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Queryable } from '../db.js';
import { many, one } from '../db.js';
import { verifyChain } from './chat.js';

/**
 * Checks that a database (typically one just restored from backup) is complete and
 * internally consistent. A backup that restores but fails these is not a backup.
 */
export interface IntegrityCheck {
  name: string;
  ok: boolean;
  detail?: unknown;
}

const APPEND_ONLY = ['ledger_entries', 'chat_messages', 'order_events', 'offer_snapshots', 'admin_audit_log'];
const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

export async function checkIntegrity(q: Queryable, opts: { chatSample?: number } = {}) {
  const checks: IntegrityCheck[] = [];
  const add = (name: string, ok: boolean, detail?: unknown) => checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) });

  const expected = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql'));
  const applied = new Set((await many<{ name: string }>(q, 'SELECT name FROM schema_migrations')).map((r) => r.name));
  const missing = expected.filter((f) => !applied.has(f));
  add('migrations_applied', missing.length === 0, missing.length ? { missing } : { count: applied.size });

  const triggers = await many<{ table: string }>(
    q,
    `SELECT DISTINCT c.relname AS table FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_proc p ON p.oid = t.tgfoid WHERE p.proname = 'forbid_mutation' AND NOT t.tgisinternal`,
  );
  const guarded = new Set(triggers.map((t) => t.table));
  const unguarded = APPEND_ONLY.filter((t) => !guarded.has(t));
  add('append_only_guards', unguarded.length === 0, unguarded.length ? { unguarded } : undefined);

  const unbalanced = await many(q, `SELECT txn_id, SUM(amount_cents)::bigint AS sum FROM ledger_entries GROUP BY txn_id HAVING SUM(amount_cents) <> 0 LIMIT 20`);
  add('ledger_balanced', unbalanced.length === 0, unbalanced.length ? { unbalanced } : undefined);

  const escrow = await many(
    q,
    `SELECT o.id, o.status, o.amount_cents, COALESCE(e.held, 0)::bigint AS held
       FROM orders o
       LEFT JOIN (SELECT le.order_id, SUM(le.amount_cents) AS held FROM ledger_entries le JOIN ledger_accounts a ON a.id = le.account_id
                   WHERE a.kind = 'escrow' GROUP BY le.order_id) e ON e.order_id = o.id
      WHERE o.rail = 'fiat'
        AND COALESCE(e.held, 0) <> CASE WHEN o.status IN ('paid', 'delivered', 'disputed') THEN o.amount_cents ELSE 0 END
      LIMIT 20`,
  );
  add('escrow_matches_orders', escrow.length === 0, escrow.length ? { mismatched: escrow } : undefined);

  const seqGaps = await many(
    q,
    `SELECT r.id, r.last_seq, COALESCE(max(m.seq), 0) AS max_seq, count(m.id)::int AS n
       FROM chat_rooms r LEFT JOIN chat_messages m ON m.room_id = r.id
      WHERE r.purged_at IS NULL GROUP BY r.id HAVING r.last_seq <> COALESCE(max(m.seq), 0) OR count(m.id) <> r.last_seq LIMIT 20`,
  );
  add('chat_sequences_complete', seqGaps.length === 0, seqGaps.length ? { rooms: seqGaps } : undefined);

  // Hash chains: every room when small, otherwise a random sample.
  const rooms = await many<{ id: string }>(q, `SELECT id FROM chat_rooms WHERE purged_at IS NULL ORDER BY random() LIMIT $1`, [opts.chatSample ?? 500]);
  const broken: unknown[] = [];
  for (const r of rooms) {
    const v = await verifyChain(q, r.id);
    if (!v.valid) broken.push({ room: r.id, brokenAtSeq: v.brokenAtSeq });
  }
  add('chat_hash_chains', broken.length === 0, { checked: rooms.length, ...(broken.length ? { broken } : {}) });

  const summary = await one(
    q,
    `SELECT (SELECT count(*)::int FROM users) AS users, (SELECT count(*)::int FROM orders) AS orders,
            (SELECT count(*)::int FROM ledger_entries) AS ledger_entries,
            (SELECT max(created_at) FROM ledger_entries) AS latest_ledger_entry,
            (SELECT max(created_at) FROM orders) AS latest_order`,
  );
  return { ok: checks.every((c) => c.ok), checks, summary };
}
