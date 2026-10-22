import { useEffect, useState } from 'react';
import { api } from '../api';

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

// The order and account pages are English-only.
const TAG_EN: Record<BuyerTag, string> = {
  clear_communication: 'Clear communication',
  quick_confirmation: 'Confirmed quickly',
  patient: 'Patient',
  unresponsive: 'Unresponsive',
  rude: 'Rude',
  changed_requirements: 'Changed the requirements',
  asked_off_platform: 'Asked to trade off-platform',
};
const LEVEL_EN = { new: 'New buyer', good: 'Good buyer', caution: 'Take care' } as const;
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
  const rated = rep.positive + rep.negative;
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
        <h3 id="buyer-title" style={{ margin: 0 }}>About the buyer</h3>
        <span className={`chip ${levelChip(rep.level)}`}>{LEVEL_EN[rep.level]}</span>
      </div>
      <p className="small" style={{ margin: 0 }}>
        <b>{name}</b> · member since {new Date(rep.memberSince).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })} · {rep.completedOrders} completed {rep.completedOrders === 1 ? 'purchase' : 'purchases'}
      </p>
      <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 small muted">
        <li>{rated ? `${Math.round((rep.positive / rated) * 100)}% positive from ${rated} ${rated === 1 ? 'seller rating' : 'seller ratings'}` : 'No seller ratings yet'}</li>
        <li>Disputes lost: {rep.disputesLost} of {rep.disputesOpened}</li>
        <li>Chargebacks: {rep.chargebacks}</li>
      </ul>
      {rep.topTags.length > 0 && (
        <div className="row" style={{ gap: 6 }}>
          {rep.topTags.map((x) => <span key={x.tag} className={`chip ${GOOD.includes(x.tag) ? 'released' : 'disputed'}`}>{TAG_EN[x.tag]} ×{x.count}</span>)}
        </div>
      )}
      {rating ? (
        <p className="small muted" style={{ margin: 0 }}>
          You rated this buyer {rating.positive ? 'positive' : 'negative'}{rating.tags.length ? `: ${rating.tags.map((x) => TAG_EN[x]).join(', ')}` : ''}.
        </p>
      ) : canRate ? (
        <div className="stack" style={{ gap: 8 }}>
          <div className="row" role="radiogroup" aria-label="Rate this buyer">
            <button type="button" role="radio" aria-checked={positive === true} className={`btn ${positive === true ? '' : 'ghost'}`} onClick={() => (setPositive(true), setTags([]))}>👍 Good buyer</button>
            <button type="button" role="radio" aria-checked={positive === false} className={`btn ${positive === false ? '' : 'ghost'}`} onClick={() => (setPositive(false), setTags([]))}>👎 Problem buyer</button>
          </div>
          {positive !== null && (
            <fieldset className="row" style={{ border: 0, padding: 0, margin: 0, gap: 12 }}>
              <legend className="small muted" style={{ marginBottom: 6 }}>Why? (optional)</legend>
              {(positive ? GOOD : BAD).map((x) => (
                <label key={x} className="row small" style={{ gap: 6 }}>
                  <input type="checkbox" style={{ width: 'auto' }} checked={tags.includes(x)} onChange={(e) => setTags((cur) => (e.target.checked ? [...cur, x] : cur.filter((y) => y !== x)))} />
                  {TAG_EN[x]}
                </label>
              ))}
            </fieldset>
          )}
          <button className="btn" disabled={positive === null} onClick={submit}>Rate buyer</button>
          <p className="small muted" style={{ margin: 0 }}>Other sellers see the totals, never who rated. Disputes and chargebacks are counted from the order records.</p>
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
  const rated = rep.positive + rep.negative;
  return (
    <section className="card stack" aria-labelledby="my-rep-title" style={{ gap: 10 }}>
      <div className="row spread">
        <h3 id="my-rep-title" style={{ margin: 0 }}>Your buyer reputation</h3>
        <span className={`chip ${levelChip(rep.level)}`}>{LEVEL_EN[rep.level]}</span>
      </div>
      <p className="small muted" style={{ margin: 0 }}>What sellers see when you order from them. Sellers rate buyers after an order completes; disputes and chargebacks come from the order records.</p>
      <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 small">
        <li>Member since {new Date(rep.memberSince).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}</li>
        <li>{rep.completedOrders} completed {rep.completedOrders === 1 ? 'purchase' : 'purchases'}</li>
        <li>{rated ? `${Math.round((rep.positive / rated) * 100)}% positive from ${rated} ${rated === 1 ? 'seller rating' : 'seller ratings'}` : 'No seller ratings yet'}</li>
        <li>Disputes lost: {rep.disputesLost} of {rep.disputesOpened}</li>
        <li>Chargebacks: {rep.chargebacks}</li>
      </ul>
      {rep.topTags.length > 0 && (
        <div className="row" style={{ gap: 6 }}>
          {rep.topTags.map((x) => <span key={x.tag} className={`chip ${GOOD.includes(x.tag) ? 'released' : 'disputed'}`}>{TAG_EN[x.tag]} ×{x.count}</span>)}
        </div>
      )}
      {rep.level === 'caution' && <p className="small" style={{ margin: 0 }}>Sellers may ask for more detail before they deliver. Keep trades in the order chat and open disputes only when something is really wrong.</p>}
    </section>
  );
}
