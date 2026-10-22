import { useEffect, useState } from 'react';
import { api } from '../api';
import { OfferTable } from './CatalogUi';
import type { Offer } from '../pages/Market';
import { t } from '../i18n';

/**
 * "Buyers also bought" (co-purchases by 2+ buyers). With `fillers`, popular listings in the same game
 * top it up (the order page); the offer page already compares the same game below, so it leaves them out.
 */
export function AlsoBought({ offerId, game, fillers = false }: { offerId: string; game: string; fillers?: boolean }) {
  const [items, setItems] = useState<Array<Offer & { reason: 'also_bought' | 'same_game' }> | null>(null);
  useEffect(() => {
    setItems(null);
    api<{ items: Array<Offer & { reason: 'also_bought' | 'same_game' }> }>(`/offers/${offerId}/also-bought`).then((r) => setItems(r.items)).catch(() => setItems([]));
  }, [offerId]);
  const shown = (items ?? []).filter((i) => fillers || i.reason === 'also_bought');
  if (!shown.length) return null;
  const co = shown.some((i) => i.reason === 'also_bought');
  return (
    <section className="stack" style={{ marginTop: 32 }} aria-labelledby="also-bought-title">
      <h3 id="also-bought-title" style={{ margin: 0 }}>{co ? t('also.title') : t('also.more', { game })}</h3>
      <OfferTable offers={shown} showGame />
    </section>
  );
}
