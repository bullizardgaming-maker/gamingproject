import type { MessageKey } from '../i18n';

/**
 * Round 23f (copy deck §9.5): a blocked chat message. The API answers 422 `offplatform_blocked` with `details.action`:
 * `queue` (hidden, sent to staff, no strike) or `ban` (automatic ban). Without an action the browser stopped the message
 * before sending it, and nothing reached anyone. No strike counts, no "first warning": staff decide.
 */
export type BlockedAction = 'queue' | 'ban' | 'safety' | null;
export const isBlockedError = (e: any) => e?.code === 'offplatform_blocked' || /^Not sent\./.test(String(e?.message ?? e ?? ''));
export const blockedAction = (e: any): BlockedAction => (e?.details?.action === 'queue' || e?.details?.action === 'ban' ? e.details.action : null);
/**
 * Round 29: a message hidden for safety (the API's `hidden_for_safety`, a queued 422, or the browser's own check) shows the
 * sender the standard "Stay safe" warning every chat carries; the other party sees nothing. A ban keeps its own line.
 */
export const isHiddenForSafety = (r: any) => !!r && (r.hidden_for_safety === true || r.type === 'hidden_for_safety');
/** The keys of the line shown in place of the message. */
export function blockedNoticeKeys(action: BlockedAction): MessageKey[] {
  if (action === 'ban') return ['chat.blocked.ban'];
  return ['chat.notDelivered'];
}
