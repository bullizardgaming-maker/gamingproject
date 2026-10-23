import { useEffect, useState } from 'react';
import { api, money } from '../api';
import { t } from '../i18n';
import { isTopRank, rankName, rankPerk } from '@/lib/ranks';

/** The rank table (GET /ranks): staff can edit it, so the page reads it rather than hard-coding it. */
export interface Rank {
  position: number;
  name: string;
  minMonthlySalesCents: number;
  rateBps: number;
  perks: string[];
}
export interface RankTable {
  ranks: Rank[];
  settings: { promoRateBps: number; promoDays: number };
}

/** Shown until the table loads (and in tests): the launch defaults. */
export const DEFAULT_RANKS: RankTable = {
  ranks: [
    { position: 1, name: 'Hatchling', minMonthlySalesCents: 0, rateBps: 1399, perks: [] },
    { position: 2, name: 'Scale', minMonthlySalesCents: 500_00, rateBps: 1299, perks: [] },
    { position: 3, name: 'Fang', minMonthlySalesCents: 2_000_00, rateBps: 1199, perks: [] },
    { position: 4, name: 'Basilisk', minMonthlySalesCents: 5_000_00, rateBps: 1099, perks: [] },
    { position: 5, name: 'Dragon', minMonthlySalesCents: 15_000_00, rateBps: 999, perks: [] },
  ],
  settings: { promoRateBps: 500, promoDays: 60 },
};

let cached: RankTable | null = null;
export function useRanks() {
  const [table, setTable] = useState<RankTable>(cached ?? DEFAULT_RANKS);
  useEffect(() => {
    if (cached) return;
    api<RankTable>('/ranks').then((r) => ((cached = r), setTable(r))).catch(() => {});
  }, []);
  return table;
}

export const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;

/** Bar height is the commission itself, so the staircase is the data. */
export function FeeLadder({ current }: { current?: string }) {
  const { ranks, settings } = useRanks();
  const max = Math.max(...ranks.map((r) => r.rateBps)) * 1.1;
  return (
    <div>
      <div className="row spread small">
        <span className="muted">{t('ranks.caption')}</span>
        <span className="muted mono">{t('ranks.promoShort', { rate: pct(settings.promoRateBps), days: settings.promoDays })}</span>
      </div>
      <div className="ladder" role="table" aria-label={t('ranks.aria')}>
        {ranks.map((r) => (
          <div key={r.position} className={`rung ${current === r.name ? 'current' : ''} ${isTopRank(r.name) ? 'top' : ''}`} role="row" title={rankPerk(r.name) || undefined}>
            <div className="rate" role="cell">{pct(r.rateBps)}</div>
            <div className="bar" style={{ height: `${(r.rateBps / max) * 100}%` }} />
            <div className="name" role="rowheader">{rankName(r.name)}</div>
            <div className="min" role="cell">{r.minMonthlySalesCents ? `${money(r.minMonthlySalesCents).replace('.00', '')}+/mo` : t('ranks.start')}</div>
          </div>
        ))}
      </div>
      <p className="small muted" style={{ marginTop: 10 }}>{t('ranks.grossUp')}</p>
    </div>
  );
}
