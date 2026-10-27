import { cn } from '@/lib/utils';
import { t } from '../i18n';

/** Which money state an order status shows: yellow paid, green completed, red disputed/cancelled. */
export function eyeState(status: string): 'held' | 'released' | 'disputed' | 'waiting' {
  if (status === 'completed') return 'released';
  if (['disputed', 'refunded', 'cancelled', 'charged_back'].includes(status)) return 'disputed';
  if (['paid', 'delivered'].includes(status)) return 'held';
  return 'waiting';
}

/**
 * The logo eye as an order's status (Round 24): the pupil is a slit while the money is held, opens
 * into a full coin when the order is completed, and narrows to a thin line when disputed. The
 * status word shows on hover or focus.
 */
export function StatusEye({ status, label: fallback, size = 22, className }: { status: string; label: string; size?: number; className?: string }) {
  const s = eyeState(status);
  // One word per state: Paid, Completed, Disputed (other states keep their own word).
  const label = s === 'held' ? t('ostatus.paid') : s === 'released' ? t('ostatus.completed') : status === 'disputed' ? t('eye.disputed') : fallback;
  return (
    <span className={cn('eye-status', s, className)} role="img" aria-label={label} data-tip={label} tabIndex={0}>
      <svg viewBox="0 0 72 64" width={size} height={size * (64 / 72)} fill="currentColor" aria-hidden>
        <path d="M4 8C14 31 58 31 68 8C56 22 16 22 4 8Z" />
        <circle cx="36" cy="41" r="16" fill="none" stroke="currentColor" strokeWidth="6" />
        {s === 'released' ? (
          <circle cx="36" cy="41" r="9.5" />
        ) : s === 'disputed' ? (
          <rect x="34.6" y="29.5" width="2.8" height="23" rx="1.4" />
        ) : (
          <path d="M36 30.5C39.2 35.5 39.2 46.5 36 51.5C32.8 46.5 32.8 35.5 36 30.5Z" />
        )}
      </svg>
    </span>
  );
}
