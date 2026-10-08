import { createHash } from 'node:crypto';
import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, maybeOne, one, withTx } from '../db.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { notify } from './notifications.js';

/**
 * Anti-money-laundering controls.
 *
 *  1. Sanctions screening: sellers' verified legal names and linked wallets (and crypto buyers'
 *     wallets) are checked against sanctions lists (OFAC SDN built in; other lists via a simple
 *     CSV). Checked at identity verification, wallet linking, before payouts, and again whenever
 *     a list changes. A strong match pauses payouts and opens a case.
 *  2. Transaction monitoring: daily rules look for patterns typical of laundering through a
 *     marketplace (money passed straight through, structuring, sudden volume, one buyer feeding
 *     one seller). Hits open cases for review; they don't block anyone by themselves.
 *  3. Cases: compliance staff clear, escalate, pause payouts, or record that a suspicious activity
 *     report was filed. The user is never told a case exists (no tipping off): paused payouts
 *     are described as a routine review.
 */

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------
/** Lowercase, strip accents and punctuation, drop titles, sort words: order- and format-insensitive. */
export function nameKey(name: string) {
  const words = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !['mr', 'mrs', 'ms', 'dr', 'the', 'of'].includes(w));
  return words.sort().join(' ');
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------
export interface SanctionsEntry {
  ref: string;
  kind: 'person' | 'entity' | 'wallet' | 'other';
  name: string;
  program?: string | null;
}

/** RFC 4180 CSV (quoted fields, doubled quotes, newlines in quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

const blank = (v: string | undefined) => (!v || v.trim() === '-0-' ? null : v.trim());

/**
 * OFAC SDN list: sdn.csv (one row per party) and alt.csv (aliases). Digital currency addresses
 * are published inside the Remarks field ("Digital Currency Address - ETH 0x...;").
 */
export function parseOfacSdn(sdnCsv: string, altCsv = ''): SanctionsEntry[] {
  const out: SanctionsEntry[] = [];
  const kinds = new Map<string, SanctionsEntry['kind']>();
  const programs = new Map<string, string | null>();
  for (const r of parseCsv(sdnCsv)) {
    const [ref, name, type, program, , , , , , , , remarks] = r;
    if (!ref || !blank(name)) continue;
    const kind: SanctionsEntry['kind'] = type === 'individual' ? 'person' : blank(type) ? 'other' : 'entity';
    kinds.set(ref, kind);
    programs.set(ref, blank(program));
    out.push({ ref, kind, name: name!.trim(), program: blank(program) });
    for (const m of (remarks ?? '').matchAll(/Digital Currency Address - [A-Z0-9]+ ([A-Za-z0-9]{20,})/g)) {
      out.push({ ref, kind: 'wallet', name: m[1]!, program: blank(program) });
    }
  }
  for (const r of parseCsv(altCsv)) {
    const [ref, , , altName] = r;
    if (!ref || !blank(altName) || !kinds.has(ref)) continue;
    out.push({ ref, kind: kinds.get(ref)!, name: altName!.trim(), program: programs.get(ref) ?? null });
  }
  return out;
}

/** Simple format for other lists (EU, UK, UN exports from your data vendor): header ref,kind,name,program. */
export function parseSimpleList(csv: string): SanctionsEntry[] {
  const [header, ...rows] = parseCsv(csv);
  const idx = (k: string) => header!.findIndex((h) => h.trim().toLowerCase() === k);
  const [ref, kind, name, program] = ['ref', 'kind', 'name', 'program'].map(idx);
  if (ref! < 0 || name! < 0) throw new Error('sanctions CSV needs ref and name columns');
  return rows
    .filter((r) => r[name!]?.trim())
    .map((r) => ({
      ref: r[ref!]!.trim(),
      kind: (['person', 'entity', 'wallet', 'other'].includes(r[kind!]?.trim() ?? '') ? r[kind!]!.trim() : 'other') as SanctionsEntry['kind'],
      name: r[name!]!.trim(),
      program: program! >= 0 ? r[program!]?.trim() || null : null,
    }));
}

/** Replace one list's entries atomically. Returns whether its content changed. */
export async function loadList(ctx: Ctx, list: string, entries: SanctionsEntry[], version: string) {
  return withTx(ctx.db, async (tx) => {
    const current = await maybeOne<{ version: string }>(tx, 'SELECT version FROM sanctions_lists WHERE list = $1 FOR UPDATE', [list]);
    if (current?.version === version) return false;
    await tx.query('DELETE FROM sanctions_entries WHERE list = $1', [list]);
    for (let i = 0; i < entries.length; i += 1000) {
      const chunk = entries.slice(i, i + 1000);
      await tx.query(
        `INSERT INTO sanctions_entries (list, ref, kind, name, name_key, program, version)
         SELECT $1, r, k, n, nk, p, $7 FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) AS t(r, k, n, nk, p)`,
        [
          list,
          chunk.map((e) => e.ref),
          chunk.map((e) => e.kind),
          chunk.map((e) => e.name),
          chunk.map((e) => (e.kind === 'wallet' ? e.name.toLowerCase() : nameKey(e.name))),
          chunk.map((e) => e.program ?? null),
          version,
        ],
      );
    }
    await tx.query(
      `INSERT INTO sanctions_lists (list, version, entries) VALUES ($1, $2, $3)
       ON CONFLICT (list) DO UPDATE SET version = EXCLUDED.version, entries = EXCLUDED.entries, loaded_at = now()`,
      [list, version, entries.length],
    );
    return true;
  });
}

const sha = (...parts: string[]) => createHash('sha256').update(parts.join('\u0000')).digest('hex');

async function download(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

/** Fetch the configured lists; unchanged lists are skipped. */
export async function refreshLists(ctx: Ctx) {
  const changed: string[] = [];
  if (ctx.cfg.SANCTIONS_SOURCE === 'ofac') {
    const [sdn, alt] = await Promise.all([download(ctx.cfg.SANCTIONS_OFAC_SDN_URL), download(ctx.cfg.SANCTIONS_OFAC_ALT_URL)]);
    if (await loadList(ctx, 'ofac_sdn', parseOfacSdn(sdn, alt), sha(sdn, alt))) changed.push('ofac_sdn');
  }
  for (const spec of (ctx.cfg.SANCTIONS_EXTRA_LISTS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [list, url] = spec.split('=') as [string, string];
    const csv = await download(url);
    if (await loadList(ctx, list, parseSimpleList(csv), sha(csv))) changed.push(list);
  }
  return changed;
}

async function listVersions(q: Queryable): Promise<Record<string, string>> {
  const rows = await many<{ list: string; version: string }>(q, 'SELECT list, version FROM sanctions_lists');
  return Object.fromEntries(rows.map((r) => [r.list, r.version]));
}

// ---------------------------------------------------------------------------
// Screening
// ---------------------------------------------------------------------------
export async function matchName(q: Queryable, name: string) {
  const key = nameKey(name);
  if (!key) return [];
  return many<{ list: string; ref: string; kind: string; name: string; program: string | null; score: number }>(
    q,
    `SELECT list, ref, kind, name, program, round(similarity(name_key, $1)::numeric, 3)::float AS score
       FROM sanctions_entries WHERE kind <> 'wallet' AND name_key % $1
      ORDER BY score DESC LIMIT 10`,
    [key],
  );
}

export async function matchWallet(q: Queryable, address: string) {
  return many<{ list: string; ref: string; kind: string; name: string; program: string | null; score: number }>(
    q,
    `SELECT list, ref, kind, name, program, 1.0::float AS score FROM sanctions_entries WHERE kind = 'wallet' AND name_key = $1`,
    [address.toLowerCase()],
  );
}

/** Screen a user's legal name and linked wallet; open or update cases on matches. */
export async function screenUser(ctx: Ctx, userId: string) {
  const user = await one<{ legal_name: string | null; wallet_address: string | null }>(ctx.db, 'SELECT legal_name, wallet_address FROM users WHERE id = $1', [userId]);
  const versions = await listVersions(ctx.db);
  if (!Object.keys(versions).length) return { screened: false as const, reason: 'no_lists' };
  const results = [];
  for (const [subject, value] of [['legal_name', user.legal_name], ['wallet', user.wallet_address]] as const) {
    if (!value) continue;
    const matches = subject === 'wallet' ? await matchWallet(ctx.db, value) : await matchName(ctx.db, value);
    const best = matches[0]?.score ?? 0;
    await ctx.db.query(
      `INSERT INTO aml_screenings (user_id, subject, value, best_score, matches, versions) VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, subject, value, best, JSON.stringify(matches), JSON.stringify(versions)],
    );
    if (best >= ctx.cfg.SANCTIONS_HOLD_SCORE) {
      await openCase(ctx, userId, { source: 'sanctions', rule: `sanctions_${subject}`, severity: 'high', holdsPayouts: true, details: { value, matches } });
    } else if (best >= ctx.cfg.SANCTIONS_REVIEW_SCORE) {
      await openCase(ctx, userId, { source: 'sanctions', rule: `sanctions_${subject}`, severity: 'medium', holdsPayouts: false, details: { value, matches } });
    }
    results.push({ subject, bestScore: best });
  }
  return { screened: true as const, results };
}

/** Before money leaves: screen again if the lists changed or the last check is old. */
export async function ensureScreenedForPayout(ctx: Ctx, userId: string) {
  const versions = await listVersions(ctx.db);
  if (!Object.keys(versions).length) {
    if (ctx.cfg.NODE_ENV === 'production') throw new AppError(503, 'screening_unavailable', 'Payouts are paused for a moment. Please try again later.');
    return;
  }
  const last = await maybeOne<{ versions: Record<string, string>; created_at: string }>(
    ctx.db,
    `SELECT versions, created_at FROM aml_screenings WHERE user_id = $1 AND subject = 'legal_name' ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  const stale =
    !last ||
    JSON.stringify(last.versions) !== JSON.stringify(versions) ||
    Date.now() - new Date(last.created_at).getTime() > ctx.cfg.SANCTIONS_RESCREEN_DAYS * 86_400_000;
  if (stale) await screenUser(ctx, userId);
}

/** Crypto buyers: refuse deposits from sanctioned wallets (and open a case on the buyer). */
export async function assertWalletClear(ctx: Ctx, userId: string, address: string) {
  const matches = await matchWallet(ctx.db, address);
  if (!matches.length) return;
  await openCase(ctx, userId, { source: 'sanctions', rule: 'sanctions_payment_wallet', severity: 'high', holdsPayouts: true, details: { value: address, matches } });
  throw new AppError(403, 'payment_declined', 'This payment method cannot be used');
}

// ---------------------------------------------------------------------------
// Transaction monitoring
// ---------------------------------------------------------------------------
interface RuleHit {
  user_id: string;
  details: Record<string, unknown>;
}

export function monitoringRules(ctx: Ctx): Array<{ rule: string; describe: string; sql: string; params: unknown[] }> {
  const c = ctx.cfg;
  return [
    {
      rule: 'rapid_pass_through',
      describe: 'New account (under 30 days) withdrew a large amount within 7 days',
      sql: `SELECT w.user_id, jsonb_build_object('withdrawn_7d_cents', SUM(w.amount_cents), 'account_age_days', extract(day FROM now() - u.created_at)::int) AS details
              FROM withdrawals w JOIN users u ON u.id = w.user_id
             WHERE w.status IN ('paid', 'pending') AND w.created_at > now() - interval '7 days' AND u.created_at > now() - interval '30 days'
             GROUP BY w.user_id, u.created_at HAVING SUM(w.amount_cents) >= $1`,
      params: [c.AML_RAPID_WITHDRAWAL_CENTS],
    },
    {
      rule: 'structuring',
      describe: 'Three or more withdrawals in 7 days just under the reporting threshold',
      sql: `SELECT user_id, jsonb_build_object('count', count(*), 'amounts', jsonb_agg(amount_cents ORDER BY created_at)) AS details
              FROM withdrawals
             WHERE status IN ('paid', 'pending') AND created_at > now() - interval '7 days'
               AND amount_cents >= $1 * 0.8 AND amount_cents < $1
             GROUP BY user_id HAVING count(*) >= 3`,
      params: [c.AML_THRESHOLD_CENTS],
    },
    {
      rule: 'volume_spike',
      describe: 'Sales in the last 7 days are 5x the weekly average of the previous 30 days',
      sql: `SELECT seller_id AS user_id, jsonb_build_object('last_7d_cents', recent, 'prior_weekly_avg_cents', round(prior / 30.0 * 7)) AS details
              FROM (SELECT seller_id,
                           SUM(amount_cents) FILTER (WHERE paid_at > now() - interval '7 days') AS recent,
                           COALESCE(SUM(amount_cents) FILTER (WHERE paid_at <= now() - interval '7 days'), 0) AS prior
                      FROM orders WHERE paid_at > now() - interval '37 days' AND status NOT IN ('awaiting_payment', 'cancelled')
                     GROUP BY seller_id) s
             WHERE recent >= $1 AND recent > 5 * (prior / 30.0 * 7)`,
      params: [c.AML_VOLUME_SPIKE_MIN_CENTS],
    },
    {
      rule: 'buyer_concentration',
      describe: 'Half or more of a seller’s 30-day sales come from one buyer',
      sql: `SELECT seller_id AS user_id, jsonb_build_object('buyer_id', buyer_id, 'buyer_cents', buyer_cents, 'total_cents', total_cents) AS details
              FROM (SELECT seller_id, buyer_id, SUM(amount_cents) AS buyer_cents,
                           SUM(SUM(amount_cents)) OVER (PARTITION BY seller_id) AS total_cents
                      FROM orders WHERE paid_at > now() - interval '30 days' AND status NOT IN ('awaiting_payment', 'cancelled')
                     GROUP BY seller_id, buyer_id) x
             WHERE buyer_cents >= $1 AND buyer_cents * 2 >= total_cents`,
      params: [c.AML_BUYER_CONCENTRATION_MIN_CENTS],
    },
    {
      rule: 'new_account_high_value',
      describe: 'Account younger than 7 days received a large amount of sales',
      sql: `SELECT o.seller_id AS user_id, jsonb_build_object('sales_cents', SUM(o.amount_cents), 'account_age_days', extract(day FROM now() - u.created_at)::int) AS details
              FROM orders o JOIN users u ON u.id = o.seller_id
             WHERE u.created_at > now() - interval '7 days' AND o.status NOT IN ('awaiting_payment', 'cancelled')
             GROUP BY o.seller_id, u.created_at HAVING SUM(o.amount_cents) >= $1`,
      params: [c.AML_NEW_ACCOUNT_VOLUME_CENTS],
    },
  ];
}

export async function runMonitoring(ctx: Ctx) {
  const opened: Array<{ rule: string; userId: string }> = [];
  for (const r of monitoringRules(ctx)) {
    const hits = await many<RuleHit>(ctx.db, r.sql, r.params);
    for (const hit of hits) {
      // A reviewer cleared this pattern for this user recently: don't reopen for 30 days.
      const recent = await maybeOne(
        ctx.db,
        `SELECT 1 FROM aml_cases WHERE user_id = $1 AND rule = $2 AND status = 'cleared' AND decided_at > now() - interval '30 days'`,
        [hit.user_id, r.rule],
      );
      if (recent) continue;
      if (await openCase(ctx, hit.user_id, { source: 'monitoring', rule: r.rule, severity: 'medium', holdsPayouts: false, details: { ...hit.details, why: r.describe } })) {
        opened.push({ rule: r.rule, userId: hit.user_id });
      }
    }
  }
  return opened;
}

let lastAml = 0;
/** Worker: every 6 hours one worker refreshes the lists, re-screens against changes, and runs the rules. */
export async function maybeRunAml(ctx: Ctx) {
  if (Date.now() - lastAml < 6 * 3_600_000) return null;
  lastAml = Date.now();
  return withTx(ctx.db, async (tx) => {
    const { locked } = await one<{ locked: boolean }>(tx, 'SELECT pg_try_advisory_xact_lock(727280) AS locked');
    if (!locked) return null;
    const changed = await refreshLists(ctx).catch((err) => {
      ctx.log.error({ err: (err as Error).message }, 'sanctions list refresh failed');
      return [] as string[];
    });
    const rescreened = await rescreenSellers(ctx);
    const opened = await runMonitoring(ctx);
    return { changed, rescreened, opened: opened.length };
  });
}

/** Re-screen verified sellers whose last check predates the current list versions. */
export async function rescreenSellers(ctx: Ctx, limit = 500) {
  const versions = JSON.stringify(await listVersions(ctx.db));
  if (versions === '{}') return 0;
  const due = await many<{ id: string }>(
    ctx.db,
    `SELECT u.id FROM users u
      WHERE u.kyc_tier >= 2 AND u.deleted_at IS NULL AND (u.legal_name IS NOT NULL OR u.wallet_address IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM aml_screenings s WHERE s.user_id = u.id AND s.versions = $1::jsonb)
      LIMIT $2`,
    [versions, limit],
  );
  for (const u of due) await screenUser(ctx, u.id);
  return due.length;
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------
async function syncHold(q: Queryable, userId: string) {
  await q.query(
    `UPDATE users SET aml_hold = EXISTS (SELECT 1 FROM aml_cases WHERE user_id = $1 AND holds_payouts AND status IN ('open', 'escalated', 'reported'))
      WHERE id = $1`,
    [userId],
  );
}

/** Returns true if a new case was opened (false if an existing live case was updated). */
export async function openCase(
  ctx: Ctx,
  userId: string,
  c: { source: 'sanctions' | 'monitoring' | 'manual'; rule: string; severity: 'high' | 'medium'; holdsPayouts: boolean; details: Record<string, unknown> },
) {
  return withTx(ctx.db, async (tx) => {
    const row = await one<{ inserted: boolean; id: string }>(
      tx,
      `INSERT INTO aml_cases (user_id, source, rule, severity, holds_payouts, details) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, rule) WHERE status IN ('open', 'escalated') DO UPDATE SET
         details = EXCLUDED.details,
         severity = CASE WHEN aml_cases.severity = 'high' OR EXCLUDED.severity = 'high' THEN 'high' ELSE 'medium' END,
         holds_payouts = aml_cases.holds_payouts OR EXCLUDED.holds_payouts
       RETURNING (xmax = 0) AS inserted, id`,
      [userId, c.source, c.rule, c.severity, c.holdsPayouts, JSON.stringify(c.details)],
    );
    await syncHold(tx, userId);
    if (row.inserted) {
      // Tell compliance, never the subject.
      const reviewers = await many<{ id: string }>(
        tx,
        `SELECT id FROM users WHERE (role IN ('compliance', 'admin') OR staff_roles && ARRAY['compliance', 'admin']) AND status = 'active' AND deleted_at IS NULL AND id <> $1`,
        [userId],
      );
      for (const r of reviewers) await notify(tx, r.id, 'aml_case_opened', { case_id: row.id, rule: c.rule, severity: c.severity }, `aml_case:${row.id}:${r.id}`);
    }
    return row.inserted;
  });
}

export async function listCases(ctx: Ctx, status?: string) {
  return many(
    ctx.db,
    `SELECT c.id, c.user_id, u.display_name, c.source, c.rule, c.severity, c.holds_payouts, c.status, c.created_at, c.decided_at
       FROM aml_cases c JOIN users u ON u.id = c.user_id
      WHERE ($1::text IS NULL OR c.status = $1) ORDER BY (c.severity = 'high') DESC, c.created_at LIMIT 200`,
    [status ?? null],
  );
}

/** Everything a reviewer needs on one page. */
export async function getCase(ctx: Ctx, id: string) {
  const c = await maybeOne(ctx.db, 'SELECT * FROM aml_cases WHERE id = $1', [id]);
  if (!c) throw notFound('Case');
  const [user, screenings, money, related] = await Promise.all([
    one(ctx.db, `SELECT id, display_name, email, legal_name, wallet_address, kyc_tier, status, created_at, aml_hold, withdrawals_frozen FROM users WHERE id = $1`, [c.user_id]),
    many(ctx.db, 'SELECT subject, value, best_score, matches, created_at FROM aml_screenings WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10', [c.user_id]),
    one(
      ctx.db,
      `SELECT (SELECT COALESCE(SUM(amount_cents), 0)::bigint FROM orders WHERE seller_id = $1 AND status NOT IN ('awaiting_payment', 'cancelled') AND paid_at > now() - interval '90 days') AS sales_90d_cents,
              (SELECT COALESCE(SUM(amount_cents), 0)::bigint FROM orders WHERE buyer_id = $1 AND status NOT IN ('awaiting_payment', 'cancelled') AND paid_at > now() - interval '90 days') AS purchases_90d_cents,
              (SELECT COALESCE(SUM(amount_cents), 0)::bigint FROM withdrawals WHERE user_id = $1 AND status = 'paid' AND created_at > now() - interval '90 days') AS withdrawn_90d_cents`,
      [c.user_id],
    ),
    many(ctx.db, `SELECT id, rule, status, created_at FROM aml_cases WHERE user_id = $1 AND id <> $2 ORDER BY created_at DESC`, [c.user_id, id]),
  ]);
  return { case: c, user, screenings, money, otherCases: related };
}

export async function addNote(ctx: Ctx, id: string, staffId: string, note: string) {
  const row = await maybeOne(
    ctx.db,
    `UPDATE aml_cases SET notes = notes || jsonb_build_array(jsonb_build_object('by', $2::text, 'at', now(), 'note', $3::text)) WHERE id = $1 RETURNING id`,
    [id, staffId, note],
  );
  if (!row) throw notFound('Case');
}

export type CaseDecision = 'clear' | 'escalate' | 'hold' | 'report';

export async function decideCase(ctx: Ctx, id: string, staffId: string, d: { decision: CaseDecision; note: string; sarReference?: string }) {
  return withTx(ctx.db, async (tx) => {
    const c = await maybeOne(tx, 'SELECT * FROM aml_cases WHERE id = $1 FOR UPDATE', [id]);
    if (!c) throw notFound('Case');
    if (c.status === 'cleared' || c.status === 'reported') throw conflict('closed', `Case is ${c.status}`);
    if (d.decision === 'report' && !d.sarReference) throw badRequest('sar_reference_required', 'Record the reference of the report filed with the FIU');
    if (d.decision === 'clear' && c.severity === 'high' && d.note.length < 20) throw badRequest('reason_required', 'Explain why a strong match is a false positive');
    const status = { clear: 'cleared', escalate: 'escalated', hold: c.status, report: 'reported' }[d.decision];
    const holds = d.decision === 'hold' || d.decision === 'report' ? true : d.decision === 'clear' ? false : c.holds_payouts;
    const updated = await one(
      tx,
      `UPDATE aml_cases SET status = $2, holds_payouts = $3, sar_reference = COALESCE($4, sar_reference),
              decided_by = CASE WHEN $2 IN ('cleared', 'reported') THEN $5::uuid ELSE decided_by END,
              decided_at = CASE WHEN $2 IN ('cleared', 'reported') THEN now() ELSE decided_at END,
              notes = notes || jsonb_build_array(jsonb_build_object('by', $5::text, 'at', now(), 'decision', $6::text, 'note', $7::text))
        WHERE id = $1 RETURNING *`,
      [id, status, holds, d.sarReference ?? null, staffId, d.decision, d.note],
    );
    await syncHold(tx, c.user_id);
    return updated;
  });
}
