import { detectOffPlatform } from '../domain/safety.js';
import { badRequest } from './errors.js';

/**
 * Security audit (Nov 2026): free text that reaches the other party (or the public) outside the chat — dispute reasons and
 * statements, progress notes, warranty messages, shop notices, game suggestions — gets the same off-platform check as
 * reviews and requests: contact details, links and outside payment methods are refused (400 offplatform_contact).
 * `allowEmail`: account orders may name the account's email, as their chat rooms do.
 */
export function assertNoOffPlatform(text: string | null | undefined, opts: { allowEmail?: boolean } = {}) {
  if (!text) return;
  if (detectOffPlatform(text, { allowEmail: opts.allowEmail }).length) {
    throw badRequest('offplatform_contact', 'Keep contact details, links and outside payment methods off Bullizard: deals made elsewhere aren’t protected');
  }
}
