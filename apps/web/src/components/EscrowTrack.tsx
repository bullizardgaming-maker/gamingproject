import { money } from '../api';

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
    variant === 'disputed' ? 'Frozen' : variant === 'refunded' ? 'Refunded' : stage === 2 ? 'Released' : stage === 1 ? 'Held' : 'Pending';

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
          <b>Buyer pays</b>
          <span>{variant === 'refunded' ? 'Refunded to card' : 'Card or USDC'}</span>
        </div>
        <div className={`track-stop ${stage >= 1 ? 'on' : ''}`}>
          <b>{variant === 'disputed' ? 'Frozen by dispute' : 'Held in escrow'}</b>
          <span>{windowLabel}</span>
        </div>
        <div className={`track-stop ${stage >= 2 ? 'on' : ''}`}>
          <b>Seller is paid</b>
          <span>minus tier fee</span>
        </div>
      </div>
    </div>
  );
}

export function formatRemaining(ms: number) {
  if (ms <= 0) return '0h 00m';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h left`;
  return `${h}h ${String(m).padStart(2, '0')}m left`;
}
