import { createHash } from 'node:crypto';
import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, maybeOne, one } from '../db.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { enqueueEmail } from './notifications.js';

/**
 * Legal documents (Legal pack, Oct 24): every version of the Terms, Privacy Policy, Seller
 * Agreement, Refund & Dispute Policy and the restricted-countries list, per locale, with a hash.
 * The current Terms version is what sign-up and every order record as `tos_version`. A material
 * change is announced 14 days before it takes effect (email + banner) and users accept it again at
 * their next sign-in.
 */
export const LEGAL_DOCS = ['terms', 'privacy', 'seller-agreement', 'refunds', 'restricted-countries'] as const;
export type LegalDoc = (typeof LEGAL_DOCS)[number];
export const NOTICE_DAYS = 14;

export interface LegalRow {
  doc: LegalDoc;
  locale: string;
  version: string;
  effective_at: string;
  title: string;
  content_md: string;
  sha256: string;
  material: boolean;
}
const COLS = 'doc, locale, version, effective_at, title, content_md, sha256, material';
const lang = (l?: string) => (l ?? 'en').slice(0, 2).toLowerCase();

/** The document in force now, in the locale when it exists, English otherwise. */
export async function currentDocument(q: Queryable, doc: LegalDoc, locale?: string): Promise<LegalRow> {
  const row = await maybeOne<LegalRow>(
    q,
    `SELECT ${COLS} FROM legal_documents WHERE doc = $1 AND locale IN ($2, 'en') AND effective_at <= now()
      ORDER BY (locale = $2) DESC, effective_at DESC LIMIT 1`,
    [doc, lang(locale)],
  );
  if (!row) throw notFound('Document');
  return row;
}

export async function documentHistory(q: Queryable, doc: LegalDoc) {
  return many<Omit<LegalRow, 'content_md'>>(q, `SELECT doc, locale, version, effective_at, title, sha256, material FROM legal_documents WHERE doc = $1 ORDER BY effective_at DESC, locale`, [doc]);
}

export async function documentVersion(q: Queryable, doc: LegalDoc, version: string, locale?: string): Promise<LegalRow> {
  const row = await maybeOne<LegalRow>(
    q,
    `SELECT ${COLS} FROM legal_documents WHERE doc = $1 AND version = $2 AND locale IN ($3, 'en') ORDER BY (locale = $3) DESC LIMIT 1`,
    [doc, version, lang(locale)],
  );
  if (!row) throw notFound('Document version');
  return row;
}

/** The Terms version new sign-ups and orders record. */
export async function tosVersion(q: Queryable): Promise<string> {
  const row = await maybeOne<{ version: string }>(q, `SELECT version FROM legal_documents WHERE doc = 'terms' AND locale = 'en' AND effective_at <= now() ORDER BY effective_at DESC LIMIT 1`);
  // Fail closed: without Terms in force nobody can sign up or order (Round 20).
  if (!row) throw new AppError(503, 'terms_unavailable', 'The Terms of Service are not published; sign-up and orders are paused');
  return row.version;
}

/** A material change announced but not yet in force (shown as a banner for NOTICE_DAYS). */
export async function pendingNotice(q: Queryable) {
  return maybeOne<{ version: string; effective_at: string; doc: LegalDoc }>(
    q,
    `SELECT doc, version, effective_at FROM legal_documents WHERE material AND effective_at > now() AND locale = 'en' ORDER BY effective_at LIMIT 1`,
  );
}

export async function acceptanceStatus(q: Queryable, userId: string) {
  const [u, current] = await Promise.all([
    one<{ tos_version: string | null; tos_accepted_at: string | null }>(q, 'SELECT tos_version, tos_accepted_at FROM users WHERE id = $1', [userId]),
    tosVersion(q),
  ]);
  // Re-acceptance is needed only after a material change took effect since the user accepted.
  const material = await maybeOne<{ version: string }>(
    q,
    `SELECT version FROM legal_documents WHERE doc = 'terms' AND locale = 'en' AND material AND effective_at <= now()
        AND ($1::text IS NULL OR effective_at > (SELECT COALESCE(max(effective_at), '1970-01-01') FROM legal_documents WHERE doc = 'terms' AND locale = 'en' AND version = $1))
      ORDER BY effective_at DESC LIMIT 1`,
    [u.tos_version],
  );
  return { tosVersion: u.tos_version, acceptedAt: u.tos_accepted_at, currentVersion: current, reacceptanceRequired: !!material && u.tos_version !== current };
}

/** Round 23d (item 11): every acceptance is kept — who accepted which version, when, and where it happened. */
export async function recordAcceptance(q: Queryable, userId: string, version: string, via: 'signup' | 'settings' | 'order', ip?: string | null) {
  await q.query(`INSERT INTO terms_acceptances (user_id, doc, version, via, ip) VALUES ($1, 'terms', $2, $3, $4)`, [userId, version, via, ip ?? null]);
}

export async function acceptTerms(q: Queryable, userId: string, ip?: string | null) {
  const version = await tosVersion(q);
  await q.query('UPDATE users SET tos_version = $2, tos_accepted_at = now() WHERE id = $1', [userId, version]);
  await recordAcceptance(q, userId, version, 'settings', ip);
  return { tosVersion: version, acceptedAt: new Date().toISOString() };
}

/** Round 23d (item 11): an order cannot be placed while a material change is waiting to be accepted. */
export async function assertTermsCurrent(q: Queryable, userId: string, sawVersion?: string) {
  const status = await acceptanceStatus(q, userId);
  if (status.reacceptanceRequired) throw new AppError(409, 'terms_reacceptance_required', 'Our Terms changed. Read and accept the new version to continue', { currentVersion: status.currentVersion });
  if (sawVersion && sawVersion !== status.currentVersion) throw new AppError(409, 'terms_stale', 'The Terms were updated while you were on this page. Reload to see the current version', { currentVersion: status.currentVersion });
  return status.currentVersion;
}

export interface PublishInput {
  doc: LegalDoc;
  lang?: string;
  version: string;
  effectiveAt?: string;
  title: string;
  contentMd: string;
  /** Required: staff say explicitly whether the change is material (Round 22). */
  material: boolean;
}

/** Staff publish a version. A material change needs at least NOTICE_DAYS before it takes effect; the notice email goes out at once. */
export async function publishDocument(ctx: Ctx, staffId: string, input: PublishInput) {
  const locale = lang(input.lang);
  const effective = input.effectiveAt ? new Date(input.effectiveAt) : new Date();
  if (Number.isNaN(effective.getTime())) throw badRequest('invalid_date', 'effectiveAt must be a date');
  // Round 23d: nothing is backdated. A version takes effect now or later, never before it was published.
  if (effective.getTime() < Date.now() - 60_000) throw badRequest('backdated', 'effectiveAt cannot be in the past');
  // Notice period: a material change takes effect no sooner than exactly NOTICE_DAYS from now.
  if (input.material && effective.getTime() < Date.now() + NOTICE_DAYS * 86_400_000 - 60_000) {
    throw badRequest('notice_required', `A material change takes effect at least ${NOTICE_DAYS} days after it is published`);
  }
  if (typeof input.material !== 'boolean') throw badRequest('materiality_required', 'Say whether this is a material change (material: true or false)');
  const sha = createHash('sha256').update(input.contentMd, 'utf8').digest('hex');
  // A version that is already in force is immutable: the hash users accepted must stay checkable. Changes are a new version.
  const existing = await maybeOne<{ effective_at: string; material: boolean }>(ctx.db, 'SELECT effective_at, material FROM legal_documents WHERE doc = $1 AND locale = $2 AND version = $3', [input.doc, locale, input.version]);
  if (existing && new Date(existing.effective_at) <= new Date()) throw conflict('version_in_force', 'This version is already in force and cannot be edited; publish a new version');
  // Round 23d: a version already in force in any language is closed; a translation added later is a new version.
  if (!existing) {
    const inForce = await maybeOne(ctx.db, 'SELECT 1 FROM legal_documents WHERE doc = $1 AND version = $2 AND effective_at <= now()', [input.doc, input.version]);
    if (inForce) throw conflict('version_in_force', 'This version is already in force in another language; publish the translation as a new version');
  }
  // Round 22 (22): a draft announced as material can't be re-published as non-material to skip the 14-day notice. If the
  // change really is not material, publish it under a new version (staff mark it explicitly; the route audits it).
  if (existing?.material && !input.material) {
    throw conflict('material_draft', 'This draft was announced as a material change; it keeps the 14-day notice. Publish a corrected non-material change as a new version');
  }
  const row = await one<LegalRow>(
    ctx.db,
    `INSERT INTO legal_documents (doc, locale, version, effective_at, title, content_md, sha256, material, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (doc, locale, version) DO UPDATE SET effective_at = EXCLUDED.effective_at, title = EXCLUDED.title, content_md = EXCLUDED.content_md, sha256 = EXCLUDED.sha256, material = EXCLUDED.material, created_by = EXCLUDED.created_by
       WHERE legal_documents.effective_at > now()
     RETURNING ${COLS}`,
    [input.doc, locale, input.version, effective.toISOString(), input.title, input.contentMd, sha, !!input.material, staffId],
  );
  if (input.material && locale === 'en' && input.doc === 'terms') {
    // Everyone active hears about it once (email); the banner comes from GET /features.
    const users = await many<{ id: string }>(ctx.db, `SELECT id FROM users WHERE status = 'active' AND deleted_at IS NULL`);
    for (const u of users) {
      await enqueueEmail(ctx.db, u.id, 'legal_change', { doc: input.doc, version: input.version, effective_at: effective.toISOString(), title: input.title }, `legal_change:${input.doc}:${input.version}:${u.id}`);
    }
  }
  return { ...row, previous_material: existing ? existing.material : null };
}
