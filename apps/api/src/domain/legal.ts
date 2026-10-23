import { createHash } from 'node:crypto';
import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, maybeOne, one } from '../db.js';
import { badRequest, notFound } from '../lib/errors.js';
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
  return row?.version ?? '2026-10-24';
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

export async function acceptTerms(q: Queryable, userId: string) {
  const version = await tosVersion(q);
  await q.query('UPDATE users SET tos_version = $2, tos_accepted_at = now() WHERE id = $1', [userId, version]);
  return { tosVersion: version, acceptedAt: new Date().toISOString() };
}

export interface PublishInput {
  doc: LegalDoc;
  lang?: string;
  version: string;
  effectiveAt?: string;
  title: string;
  contentMd: string;
  material?: boolean;
}

/** Staff publish a version. A material change needs at least NOTICE_DAYS before it takes effect; the notice email goes out at once. */
export async function publishDocument(ctx: Ctx, staffId: string, input: PublishInput) {
  const locale = lang(input.lang);
  const effective = input.effectiveAt ? new Date(input.effectiveAt) : new Date();
  if (Number.isNaN(effective.getTime())) throw badRequest('invalid_date', 'effectiveAt must be a date');
  if (input.material && effective.getTime() < Date.now() + (NOTICE_DAYS - 1) * 86_400_000) {
    throw badRequest('notice_required', `A material change takes effect at least ${NOTICE_DAYS} days after it is published`);
  }
  const sha = createHash('sha256').update(input.contentMd, 'utf8').digest('hex');
  const row = await one<LegalRow>(
    ctx.db,
    `INSERT INTO legal_documents (doc, locale, version, effective_at, title, content_md, sha256, material, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (doc, locale, version) DO UPDATE SET effective_at = EXCLUDED.effective_at, title = EXCLUDED.title, content_md = EXCLUDED.content_md, sha256 = EXCLUDED.sha256, material = EXCLUDED.material, created_by = EXCLUDED.created_by
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
  return row;
}
