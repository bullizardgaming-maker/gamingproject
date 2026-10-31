import { useEffect, useState } from 'react';
import { api } from '../api';
import { unitMoney } from '@/lib/prefs';
import { t } from '../i18n';

/** GET /offers/price-guide (Round 26b): buyer prices on this server, and under `seller` what the caller would get. */
interface Guide {
  sellers: number;
  lowest_micros: number | null;
  median_micros: number | null;
  recommended_micros: number | null;
  as_of: string;
  seller: { commission_bps: number; lowest_micros: number | null; median_micros: number | null; recommended_micros: number | null };
}

/**
 * The market for the chosen game + server (+ faction) beside the price field: lowest, median and recommended price
 * (what buyers pay, and what the seller gets) with a "Use" button each, and how many other sellers are active.
 * Refreshes when the server or faction changes. Prices at full precision.
 */
export function PriceGuide({ game, server, faction, onUse }: { game: string; server: string; faction?: string; onUse: (sellerMicros: number) => void }) {
  const [guide, setGuide] = useState<Guide | null | 'error'>(null);
  useEffect(() => {
    if (!server.trim()) return setGuide(null);
    let live = true;
    const timer = setTimeout(() => {
      const q = new URLSearchParams({ game, category: 'currency', server: server.trim(), ...(faction ? { faction } : {}) });
      api<Guide>(`/offers/price-guide?${q}`).then((g) => live && setGuide(g)).catch(() => live && setGuide('error'));
    }, 250);
    return () => ((live = false), clearTimeout(timer));
  }, [game, server, faction]);

  if (!server.trim()) return null;
  const rows: Array<[string, number | null, number | null]> =
    guide && guide !== 'error'
      ? [
          [t('pg26.lowest'), guide.lowest_micros, guide.seller.lowest_micros],
          [t('pg26.median'), guide.median_micros, guide.seller.median_micros],
          [t('pg26.recommended'), guide.recommended_micros, guide.seller.recommended_micros],
        ]
      : [];
  return (
    <section className="pg26" aria-labelledby="pg26-title" aria-live="polite" data-testid="price-guide">
      <h3 id="pg26-title" className="pg26-title">{t('pg26.title')}</h3>
      {guide === null ? (
        <p className="small muted" style={{ margin: 0 }}>{t('common.loading')}</p>
      ) : guide === 'error' ? (
        <p className="small muted" style={{ margin: 0 }}>{t('pg26.unavailable')}</p>
      ) : guide.sellers === 0 ? (
        <p className="small muted" style={{ margin: 0 }}>{t('pg26.none')}</p>
      ) : (
        <>
          <ul className="pg26-rows">
            {rows.map(([label, buyer, net]) => (
              <li key={label}>
                <span className="pg26-k">{label}</span>
                <span className="pg26-v num">{buyer != null ? unitMoney(buyer) : '—'}<span className="small muted">{net != null ? t('pg26.youGet', { price: unitMoney(net) }) : ''}</span></span>
                {net != null && <button type="button" className="btn ghost sm" aria-label={t('pg26.useN', { what: label })} onClick={() => onUse(net)}>{t('pg26.use')}</button>}
              </li>
            ))}
          </ul>
          <p className="small muted" style={{ margin: 0 }}>{t('pg26.sellers', { n: guide.sellers })}</p>
        </>
      )}
    </section>
  );
}
