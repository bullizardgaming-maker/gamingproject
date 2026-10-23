import { useEffect, useState } from 'react';
import { api } from '../api';
import { t } from '../i18n';

export type BuyerTag = 'clear_communication' | 'quick_confirmation' | 'patient' | 'unresponsive' | 'rude' | 'changed_requirements' | 'asked_off_platform';
const GOOD: BuyerTag[] = ['clear_communication', 'quick_confirmation', 'patient'];
const BAD: BuyerTag[] = ['unresponsive', 'rude', 'changed_requirements', 'asked_off_platform'];

export interface BuyerRep {
  level: 'new' | 'good' | 'caution';
  memberSince: string;
  completedOrders: number;
  positive: number;
  negative: number;
  disputesOpened: number;
  disputesLost: number;
  chargebacks: number;
  topTags: Array<{ tag: BuyerTag; count: number }>;
}

const tagText = (tag: BuyerTag) => t(`buyerRep.tag.${tag}`);
const levelText = (l: BuyerRep['level']) => t(`buyerRep.level.${l}`);
const memberSince = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
const positiveLine = (rep: BuyerRep) => {
  const rated = rep.positive + rep.negative;
  return rated ? t('buyerRep.positive', { pct: String(Math.round((rep.positive / rated) * 100)), count: rated }) : t('buyerRep.noRatings');
};
const levelChip = (l: BuyerRep['level']) => (l === 'caution' ? 'disputed' : l === 'good' ? 'released' : 'held');

/** Seller's view on an order: who they're dealing with, and (once complete) their rating of the buyer. */
export function BuyerCard({ orderId, name, rep, rating, canRate, onDone }: {
  orderId: string;
  name: string;
  rep: BuyerRep;
  rating: { positive: boolean; tags: BuyerTag[] } | null;
  canRate: boolean;
  onDone: () => void;
}) {
  const [positive, setPositive] = useState<boolean | null>(null);
  const [tags, setTags] = useState<BuyerTag[]>([]);
  const [error, setError] = useState('');
  const submit = async () => {
    setError('');
    try {
      await api(`/orders/${orderId}/buyer-rating`, { body: { positive, tags } });
      onDone();
    } catch (e: any) {
      setError(e.message);
    }
  };
  return (
    <section className="card stack" aria-labelledby="buyer-title" style={{ gap: 10 }}>
      <div className="row spread">
        <h3 id="buyer-title" style={{ margin: 0 }}>{t('buyerRep.about')}</h3>
        <span className={`chip ${levelChip(rep.level)}`}>{levelText(rep.level)}</span>
      </div>
      <p className="small" style={{ margin: 0 }}>
        <b>{name}</b> · {t('buyerRep.memberSince', { date: memberSince(rep.memberSince) })} · {t('buyerRep.purchases', { count: rep.completedOrders })}
      </p>
      <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 small muted">
        <li>{positiveLine(rep)}</li>
        <li>{t('buyerRep.disputesLost', { lost: rep.disputesLost, opened: rep.disputesOpened })}</li>
      </ul>
      {rep.topTags.length > 0 && (
        <div className="row" style={{ gap: 6 }}>
          {rep.topTags.map((x) => <span key={x.tag} className={`chip ${GOOD.includes(x.tag) ? 'released' : 'disputed'}`}>{t('buyerRep.tagCount', { tag: tagText(x.tag), count: x.count })}</span>)}
        </div>
      )}
      {rating ? (
        <p className="small muted" style={{ margin: 0 }}>
          {rating.tags.length
            ? t('buyerRep.youRatedTags', { verdict: rating.positive ? t('buyerRep.positiveWord') : t('buyerRep.negativeWord'), tags: rating.tags.map(tagText).join(', ') })
            : t('buyerRep.youRated', { verdict: rating.positive ? t('buyerRep.positiveWord') : t('buyerRep.negativeWord') })}
        </p>
      ) : canRate ? (
        <div className="stack" style={{ gap: 8 }}>
          <div className="row" role="radiogroup" aria-label={t('buyerRep.rateAria')}>
            <button type="button" role="radio" aria-checked={positive === true} className={`btn ghost rate-pick${positive === true ? ' on' : ''}`} onClick={() => (setPositive(true), setTags([]))}>{t('buyerRep.good')}</button>
            <button type="button" role="radio" aria-checked={positive === false} className={`btn ghost rate-pick${positive === false ? ' on' : ''}`} onClick={() => (setPositive(false), setTags([]))}>{t('buyerRep.problem')}</button>
          </div>
          {positive !== null && (
            <fieldset className="row" style={{ border: 0, padding: 0, margin: 0, gap: 12 }}>
              <legend className="small muted" style={{ marginBottom: 6 }}>{t('buyerRep.why')}</legend>
              {(positive ? GOOD : BAD).map((x) => (
                <label key={x} className="row small" style={{ gap: 6 }}>
                  <input type="checkbox" style={{ width: 'auto' }} checked={tags.includes(x)} onChange={(e) => setTags((cur) => (e.target.checked ? [...cur, x] : cur.filter((y) => y !== x)))} />
                  {tagText(x)}
                </label>
              ))}
            </fieldset>
          )}
          <button className="btn" disabled={positive === null} onClick={submit}>{t('buyerRep.rate')}</button>
          <p className="small muted" style={{ margin: 0 }}>{t('buyerRep.privacy')}</p>
        </div>
      ) : null}
      {error && <div className="alert" role="alert">{error}</div>}
    </section>
  );
}

/** The buyer's own reputation on their account page, as sellers see it. */
export function MyBuyerReputation() {
  const [rep, setRep] = useState<BuyerRep | null>(null);
  useEffect(() => void api<BuyerRep>('/me/buyer-reputation').then(setRep).catch(() => {}), []);
  if (!rep) return null;
  return (
    <section className="card stack" aria-labelledby="my-rep-title" style={{ gap: 10 }}>
      <div className="row spread">
        <h3 id="my-rep-title" style={{ margin: 0 }}>{t('buyerRep.mine')}</h3>
        <span className={`chip ${levelChip(rep.level)}`}>{levelText(rep.level)}</span>
      </div>
      <p className="small muted" style={{ margin: 0 }}>{t('buyerRep.mine.text')}</p>
      <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 small">
        <li>{t('buyerRep.memberSinceCap', { date: memberSince(rep.memberSince) })}</li>
        <li>{t('buyerRep.purchases', { count: rep.completedOrders })}</li>
        <li>{positiveLine(rep)}</li>
        <li>{t('buyerRep.disputesLost', { lost: rep.disputesLost, opened: rep.disputesOpened })}</li>
      </ul>
      {rep.topTags.length > 0 && (
        <div className="row" style={{ gap: 6 }}>
          {rep.topTags.map((x) => <span key={x.tag} className={`chip ${GOOD.includes(x.tag) ? 'released' : 'disputed'}`}>{t('buyerRep.tagCount', { tag: tagText(x.tag), count: x.count })}</span>)}
        </div>
      )}
      {rep.level === 'caution' && <p className="small" style={{ margin: 0 }}>{t('buyerRep.caution.text')}</p>}
    </section>
  );
}
