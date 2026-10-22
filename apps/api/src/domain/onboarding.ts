import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, maybeOne, one } from '../db.js';
import { badRequest, conflict, forbidden } from '../lib/errors.js';
import { notify } from './notifications.js';
import type { User } from './users.js';

/**
 * Seller onboarding (brief CHANGE 8 / NEW 5):
 *  1. Tier 1 (email + phone) and a passed rules test before the first listing or proposal.
 *  2. Identity verification (Tier 2) within `id_due_days` of starting to sell. Reminders go out
 *     7 days and 1 day before; once overdue, listings pause and selling and withdrawals stop
 *     until the ID is verified, then everything comes back on its own.
 * Questions and the pass mark are edited by staff (rules.manage).
 */
export interface RulesQuestion {
  id: string;
  position: number;
  question: string;
  options: string[];
  correct: number;
  explanation: string;
  active: boolean;
}

export async function rulesSettings(q: Queryable) {
  const r = await one<{ pass_mark_pct: number; id_due_days: number }>(q, 'SELECT pass_mark_pct, id_due_days FROM rules_settings');
  return { passMarkPct: Number(r.pass_mark_pct), idDueDays: Number(r.id_due_days) };
}

export async function listQuestions(q: Queryable, opts: { activeOnly?: boolean } = {}): Promise<RulesQuestion[]> {
  const rows = await many<any>(q, `SELECT id, position, question, options, correct, explanation, active FROM rules_questions ${opts.activeOnly ? 'WHERE active' : ''} ORDER BY position, created_at`);
  return rows.map((r) => ({ ...r, position: Number(r.position), correct: Number(r.correct), options: r.options as string[] }));
}

/** The test as a seller sees it: no answers. */
export async function rulesTestFor(q: Queryable, user: Pick<User, 'id' | 'kyc_tier'>) {
  const [questions, settings, me] = await Promise.all([
    listQuestions(q, { activeOnly: true }),
    rulesSettings(q),
    one<{ rules_passed_at: string | null; rules_attempts: number }>(q, 'SELECT rules_passed_at, rules_attempts FROM users WHERE id = $1', [user.id]),
  ]);
  return {
    passMarkPct: settings.passMarkPct,
    passedAt: me.rules_passed_at,
    attempts: Number(me.rules_attempts),
    tier1: user.kyc_tier >= 1,
    questions: questions.map(({ id, position, question, options }) => ({ id, position, question, options })),
  };
}

/** Grade a submission: every active question answered by index. Passing is recorded on the user. */
export async function submitRulesTest(ctx: Ctx, user: Pick<User, 'id' | 'kyc_tier' | 'status'>, answers: Record<string, number>) {
  if (user.status !== 'active') throw forbidden('suspended', 'Account suspended');
  if (user.kyc_tier < 1) throw forbidden('tier1_required', 'Verify your email and phone before taking the rules test');
  const [questions, settings] = await Promise.all([listQuestions(ctx.db, { activeOnly: true }), rulesSettings(ctx.db)]);
  if (!questions.length) throw conflict('no_test', 'The rules test is not set up yet');
  const results = questions.map((qn) => {
    const given = answers[qn.id];
    return { id: qn.id, correct: given === qn.correct, explanation: given === qn.correct ? null : qn.explanation };
  });
  const right = results.filter((r) => r.correct).length;
  const scorePct = Math.round((right * 100) / questions.length);
  const passed = scorePct >= settings.passMarkPct;
  await ctx.db.query(
    `UPDATE users SET rules_attempts = rules_attempts + 1, rules_passed_at = CASE WHEN $2::boolean THEN COALESCE(rules_passed_at, now()) ELSE rules_passed_at END WHERE id = $1`,
    [user.id, passed],
  );
  return { passed, scorePct, passMarkPct: settings.passMarkPct, results };
}

export async function updateRulesTest(ctx: Ctx, staffId: string, input: { questions: Array<Omit<RulesQuestion, 'id'> & { id?: string }>; settings?: { passMarkPct?: number; idDueDays?: number } }) {
  for (const qn of input.questions) {
    if (qn.options.length < 2 || qn.options.length > 6) throw badRequest('invalid_question', 'Each question has 2 to 6 options');
    if (qn.correct < 0 || qn.correct >= qn.options.length) throw badRequest('invalid_question', 'The correct answer must be one of the options');
  }
  await ctx.db.query('BEGIN');
  try {
    const keep: string[] = [];
    for (const qn of input.questions) {
      const row = qn.id
        ? await maybeOne<{ id: string }>(
            ctx.db,
            `UPDATE rules_questions SET position = $2, question = $3, options = $4, correct = $5, explanation = $6, active = $7, updated_by = $8, updated_at = now() WHERE id = $1 RETURNING id`,
            [qn.id, qn.position, qn.question.trim(), JSON.stringify(qn.options), qn.correct, qn.explanation ?? '', qn.active ?? true, staffId],
          )
        : null;
      const id =
        row?.id ??
        (
          await one<{ id: string }>(
            ctx.db,
            `INSERT INTO rules_questions (position, question, options, correct, explanation, active, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [qn.position, qn.question.trim(), JSON.stringify(qn.options), qn.correct, qn.explanation ?? '', qn.active ?? true, staffId],
          )
        ).id;
      keep.push(id);
    }
    // Questions left out are retired, not deleted: past attempts keep their meaning.
    await ctx.db.query(`UPDATE rules_questions SET active = false, updated_at = now() WHERE NOT (id = ANY($1::uuid[])) AND active`, [keep]);
    if (input.settings) {
      await ctx.db.query('UPDATE rules_settings SET pass_mark_pct = COALESCE($1, pass_mark_pct), id_due_days = COALESCE($2, id_due_days), updated_at = now()', [input.settings.passMarkPct ?? null, input.settings.idDueDays ?? null]);
    }
    await ctx.db.query('COMMIT');
  } catch (err) {
    await ctx.db.query('ROLLBACK');
    throw err;
  }
  return { questions: await listQuestions(ctx.db), settings: await rulesSettings(ctx.db) };
}

/** What the seller hub shows: where they are in onboarding and when the ID is due. */
export async function onboardingStatus(q: Queryable, userId: string) {
  const [u, settings] = await Promise.all([
    one<{ kyc_tier: number; rules_passed_at: string | null; seller_since: string | null; selling_restricted_at: string | null }>(q, 'SELECT kyc_tier, rules_passed_at, seller_since, selling_restricted_at FROM users WHERE id = $1', [userId]),
    rulesSettings(q),
  ]);
  const idDueAt = u.seller_since && u.kyc_tier < 2 ? new Date(new Date(u.seller_since).getTime() + settings.idDueDays * 86_400_000).toISOString() : null;
  return {
    tier1: u.kyc_tier >= 1,
    rulesPassedAt: u.rules_passed_at,
    identityVerified: u.kyc_tier >= 2,
    sellerSince: u.seller_since,
    idDueAt,
    idDueDays: settings.idDueDays,
    sellingRestrictedAt: u.selling_restricted_at,
    canSell: u.kyc_tier >= 1 && !!u.rules_passed_at && !u.selling_restricted_at,
  };
}

/**
 * Worker (daily): remind sellers whose ID is due in 7 days and in 1 day, and restrict those who are
 * overdue (listings paused with reason 'id_overdue', selling and withdrawals off).
 */
export async function enforceIdDeadlines(ctx: Ctx) {
  const settings = await rulesSettings(ctx.db);
  const due = await many<{ id: string; seller_since: string; id_reminders_sent: number; days_left: number }>(
    ctx.db,
    `SELECT id, seller_since, id_reminders_sent,
            CEIL(EXTRACT(EPOCH FROM (seller_since + make_interval(days => $1) - now())) / 86400)::int AS days_left
       FROM users WHERE seller_since IS NOT NULL AND kyc_tier < 2 AND selling_restricted_at IS NULL AND status = 'active' AND deleted_at IS NULL`,
    [settings.idDueDays],
  );
  let reminded = 0;
  let restricted = 0;
  for (const u of due) {
    if (u.days_left <= 0) {
      await ctx.db.query(`UPDATE users SET selling_restricted_at = now() WHERE id = $1`, [u.id]);
      await ctx.db.query(`UPDATE offers SET status = 'paused', expired_reason = 'id_overdue', version = version + 1, updated_at = now() WHERE seller_id = $1 AND status = 'active'`, [u.id]);
      await notify(ctx.db, u.id, 'id_overdue', {}, `id_overdue:${u.id}`);
      restricted++;
    } else if ((u.days_left <= 7 && u.id_reminders_sent < 1) || (u.days_left <= 1 && u.id_reminders_sent < 2)) {
      await ctx.db.query(`UPDATE users SET id_reminders_sent = $2 WHERE id = $1`, [u.id, u.days_left <= 1 ? 2 : 1]);
      await notify(ctx.db, u.id, 'id_reminder', { days_left: u.days_left }, `id_reminder:${u.id}:${u.days_left <= 1 ? 'last' : 'week'}`);
      reminded++;
    }
  }
  return { reminded, restricted };
}

/** Called when Tier 2 is approved: the restriction lifts and paused listings come back. */
export async function liftIdRestriction(q: Queryable, userId: string) {
  const r = await q.query(`UPDATE users SET selling_restricted_at = NULL WHERE id = $1 AND selling_restricted_at IS NOT NULL`, [userId]);
  if (r.rowCount) await q.query(`UPDATE offers SET status = 'active', expired_reason = NULL, version = version + 1, updated_at = now() WHERE seller_id = $1 AND status = 'paused' AND expired_reason = 'id_overdue'`, [userId]);
  return !!r.rowCount;
}
