import { detectContactIntent } from '../domain/safety.js';
import { badRequest } from './errors.js';
import type { Queryable } from '../db.js';

/**
 * Round 29e (M-A): free text outside the chat is checked for contact INTENT only — handles, phone numbers, links,
 * "add me / contact me on <app>", an address offered for payment — never for a bare app or brand name ("Discord Nitro
 * gift card didn't work" is product talk).
 *  - Public texts (the shop notice, game suggestions) refuse a real contact attempt: 400 offplatform_contact.
 *  - Texts between the two parties (dispute reasons and statements, warranty texts, progress notes, seller messages) are
 *    accepted and flagged for staff (`text_flags`, Ops → Moderation).
 * `allowEmail`: account orders may name the account's email, as their chat rooms do.
 */
export function assertNoContactDetails(text: string | null | undefined, opts: { allowEmail?: boolean } = {}) {
  if (!text) return;
  if (detectContactIntent(text, { allowEmail: opts.allowEmail }).length) {
    throw badRequest('offplatform_contact', 'Keep contact details, links and outside payment methods off Bullizard: deals made elsewhere aren’t protected');
  }
}

export type TextFlagSource = 'dispute_reason' | 'dispute_statement' | 'progress_note' | 'warranty_claim' | 'warranty_reply';
/** Flags a contact attempt in an accepted text for staff; returns the reasons (empty when the text is clean). */
export async function flagContactAttempt(
  q: Queryable,
  text: string | null | undefined,
  ref: { source: TextFlagSource; refType: 'order' | 'claim'; refId: string; userId: string },
  opts: { allowEmail?: boolean } = {},
): Promise<string[]> {
  if (!text) return [];
  const reasons = detectContactIntent(text, { allowEmail: opts.allowEmail });
  if (!reasons.length) return [];
  await q.query(
    `INSERT INTO text_flags (source, ref_type, ref_id, user_id, reasons, excerpt) VALUES ($1, $2, $3, $4, $5, $6)`,
    [ref.source, ref.refType, ref.refId, ref.userId, reasons, text.slice(0, 500)],
  );
  return reasons;
}
