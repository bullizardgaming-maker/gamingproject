import { money } from '../api';

export const TIERS = [
  { name: 'Normal', min: 0, account: 12.99, other: 9.99 },
  { name: 'Common', min: 300_00, account: 11.99, other: 8.99 },
  { name: 'Uncommon', min: 1_000_00, account: 10.99, other: 7.99 },
  { name: 'Rare', min: 5_000_00, account: 9.99, other: 6.99 },
  { name: 'Epic', min: 10_000_00, account: 8.99, other: 5.99 },
  { name: 'Legendary', min: 20_000_00, account: 7.99, other: 4.99 },
];

/** Bar height is the fee itself, so the staircase is the data. */
export function FeeLadder({ current }: { current?: string }) {
  const max = 13;
  return (
    <div>
      <div className="row spread small">
        <span className="muted">Fee on keys, currency, items and boosting</span>
        <span className="muted mono">accounts in brackets</span>
      </div>
      <div className="ladder" role="table" aria-label="Seller fee by monthly sales">
        {TIERS.map((t) => (
          <div key={t.name} className={`rung ${current === t.name ? 'current' : ''}`} role="row">
            <div className="rate" role="cell">
              {t.other}%<br />
              <span className="muted">({t.account}%)</span>
            </div>
            <div className="bar" style={{ height: `${(t.other / max) * 100}%` }} />
            <div className="name" role="rowheader">{t.name}</div>
            <div className="min" role="cell">{t.min ? `${money(t.min).replace('.00', '')}+/mo` : 'Start'}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
