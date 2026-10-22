/**
 * Verify a restored database (run by deploy/backup/restore-drill.sh):
 *
 *   DATABASE_URL=<restored db> [PRIMARY_DATABASE_URL=<live db>] npx tsx scripts/verify-restore.ts
 *
 * Prints a JSON report and exits non-zero if any check fails. With PRIMARY_DATABASE_URL,
 * a passing drill records a `restore_drill` heartbeat there, which the monitoring alert
 * on stale drills watches.
 */
import { createPool } from '../src/db.js';
import { checkIntegrity } from '../src/domain/integrity.js';

const target = createPool(process.env.DATABASE_URL ?? 'postgres://market:market@localhost:5432/market', 2);
try {
  const report = await checkIntegrity(target, { chatSample: Number(process.env.CHAT_SAMPLE ?? 500) });
  console.log(JSON.stringify(report, null, 2));
  if (report.ok && process.env.PRIMARY_DATABASE_URL) {
    const primary = createPool(process.env.PRIMARY_DATABASE_URL, 1);
    await primary.query(
      `INSERT INTO worker_heartbeats (job, last_ok_at) VALUES ('restore_drill', now()) ON CONFLICT (job) DO UPDATE SET last_ok_at = now()`,
    );
    await primary.end();
  }
  process.exitCode = report.ok ? 0 : 1;
} finally {
  await target.end();
}
