import { intlLocale, t } from '../i18n';

/** "Usually replies within an hour", from the seller's median first-reply time (null: not enough chats yet). */
export function replyLabel(minutes: number | null | undefined) {
  if (minutes == null) return null;
  if (minutes <= 15) return t('presence.reply15');
  if (minutes <= 60) return t('presence.reply60');
  if (minutes <= 360) return t('presence.reply6h');
  if (minutes <= 1440) return t('presence.reply24h');
  return t('presence.replySlow');
}

/** "Last seen 3 hours ago" in the interface language. */
export function lastSeenLabel(iso: string | null | undefined) {
  if (!iso) return null;
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  const rtf = new Intl.RelativeTimeFormat(intlLocale(), { numeric: 'auto' });
  const when = mins < 60 ? rtf.format(-Math.max(mins, 1), 'minute') : mins < 1440 ? rtf.format(-Math.round(mins / 60), 'hour') : rtf.format(-Math.round(mins / 1440), 'day');
  return t('presence.lastSeen', { when });
}

/** A small green dot with an accessible label. */
export function OnlineDot({ className = '' }: { className?: string }) {
  return <span role="img" aria-label={t('presence.online')} title={t('presence.online')} className={`inline-block size-2 shrink-0 rounded-full bg-released ${className}`} />;
}
