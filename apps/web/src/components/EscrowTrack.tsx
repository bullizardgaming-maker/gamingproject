import { money } from '../api';
import { t } from '../i18n';

export type TrackVariant = 'held' | 'released' | 'disputed' | 'refunded';

interface Props {
  amountCents: number;
  /** 0 = awaiting payment, 1 = held in escrow, 2 = released */
  stage: 0 | 1 | 2;
  variant: TrackVariant;
  /** 0..1 share of the protection window that has elapsed while held */
  elapsed?: number;
  windowLabel: string;
  clock?: string;
}

/** The money's position in escrow. Colour encodes state: amber held, teal released, magenta frozen. */
export function EscrowTrack({ amountCents, stage, variant, elapsed = 0, windowLabel, clock }: Props) {
  // Coin positions: 0% buyer, 50% escrow, 100% seller. While held it drifts toward release as time elapses.
  const coin = variant === 'refunded' ? 0 : stage === 0 ? 0 : stage === 2 ? 100 : 50 + Math.min(1, Math.max(0, elapsed)) * 30;
  const fill = variant === 'refunded' ? 0 : stage === 2 ? 100 : stage === 1 ? coin : 0;
  const label =
    variant === 'disputed' ? t('escrow.frozen') : variant === 'refunded' ? t('escrow.refunded') : stage === 2 ? t('escrow.released') : stage === 1 ? t('escrow.held') : t('escrow.pending');

  return (
    <div className="track" data-variant={variant} role="img" aria-label={`${money(amountCents)} ${label.toLowerCase()}`}>
      {clock && <div className="track-clock">{clock}</div>}
      <div className="track-rail">
        <div className="track-fill" style={{ width: `${fill}%` }} />
        <div className="coin" style={{ insetInlineStart: `${coin}%` }}>
          {money(amountCents).replace('.00', '')}
        </div>
      </div>
      <div className="track-stops">
        <div className={`track-stop ${stage >= 0 ? 'on' : ''}`}>
          <b>{t('escrow.buyerPays')}</b>
          <span>{variant === 'refunded' ? t('escrow.refundedToCard') : t('escrow.cardOrUsdc')}</span>
        </div>
        <div className={`track-stop ${stage >= 1 ? 'on' : ''}`}>
          <b>{variant === 'disputed' ? t('escrow.frozenByDispute') : t('escrow.heldInEscrow')}</b>
          <span>{windowLabel}</span>
        </div>
        <div className={`track-stop ${stage >= 2 ? 'on' : ''}`}>
          <b>{t('escrow.sellerPaid')}</b>
          <span>{t('escrow.minusFee')}</span>
        </div>
      </div>
    </div>
  );
}

export function formatRemaining(ms: number) {
  if (ms <= 0) return t('escrow.noTime');
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h >= 48) return t('escrow.leftDays', { d: String(Math.floor(h / 24)), h: String(h % 24) });
  return t('escrow.leftHours', { h: String(h), m: String(m).padStart(2, '0') });
}
