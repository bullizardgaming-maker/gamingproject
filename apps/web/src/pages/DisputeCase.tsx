import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, money } from '../api';
import { DISPUTE_CATEGORY } from './OrderPage';
import { cn } from '@/lib/utils';

const fmt = (d?: string | null) => (d ? new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const WHO_STYLE: Record<string, string> = { buyer: 'border-s-4 border-s-sky-500', seller: 'border-s-4 border-s-amber-500', system: 'opacity-80', staff: 'border-s-4 border-s-violet-500' };
const FACTS: Array<[string, string, (v: any) => 'good' | 'bad' | 'neutral']> = [
  ['deliveredLate', 'Delivered late or not at all', (v) => (v ? 'bad' : 'good')],
  ['sellerRepliedAfterDispute', 'Seller replied after the dispute', (v) => (v ? 'good' : 'bad')],
  ['listingChangedSincePurchase', 'Listing changed since purchase', (v) => (v ? 'bad' : 'good')],
  ['cardCountryMatchesIp', 'Card country matches buyer’s IP', (v) => (v == null ? 'neutral' : v ? 'good' : 'bad')],
  ['chatChainIntact', 'Chat record intact (hash chain)', (v) => (v ? 'good' : 'bad')],
  ['checklistCompleted', 'Account security checklist done', (v) => (v == null ? 'neutral' : v ? 'good' : 'bad')],
];

/** Operations → Disputes → case file: everything for one decision on one screen (reads are audited). */
export function DisputeCase({ id, onResolve }: { id: string; onResolve: (outcome: 'buyer' | 'seller', note: string) => void }) {
  const [file, setFile] = useState<any>(null);
  const [error, setError] = useState('');
  const [only, setOnly] = useState<string>('all');
  const [note, setNote] = useState('');
  useEffect(() => void api(`/admin/disputes/${id}/case`).then(setFile).catch((e) => setError(e.message)), [id]);
  if (error) return <div className="alert" role="alert">{error}</div>;
  if (!file) return <p className="muted">Loading case file…</p>;
  const { dispute, order, buyer, seller, facts, statements, snapshot, payment } = file;
  const items = file.timeline.filter((t: any) => only === 'all' || t.type === only);

  const Party = ({ p, label }: { p: any; label: string }) => (
    <div className="card stack" style={{ gap: 4 }}>
      <div className="row spread"><b>{label}: {p.display_name}</b><span className="chip">{p.trust_level}</span></div>
      <div className="small muted">Member since {fmt(p.created_at)} · ID level {p.kyc_tier}</div>
      <div className="small">
        {label === 'Buyer'
          ? `${p.orders_as_buyer} orders · ${p.disputes_opened} disputes opened · ${p.chargebacks_filed} chargebacks`
          : `${p.completed_sales} sales · ${p.disputes_against_as_seller} disputes (${p.disputes_lost_as_seller} lost)` +
            (p.rates ? ` · on time ${p.rates.onTimePct ?? '—'}% · disputes ${p.rates.disputePct ?? '—'}%` : '')}
        {p.offplatform_strikes ? ` · ${p.offplatform_strikes} off-platform strikes` : ''}
      </div>
    </div>
  );

  return (
    <div className="stack">
      <div className="card stack" style={{ gap: 6 }}>
        <div className="row spread">
          <b>{order.title} × {order.quantity} · {money(order.amount_cents, order.currency)}</b>
          <Link to={`/orders/${order.id}`}>Open order</Link>
        </div>
        <div className="small muted">
          {DISPUTE_CATEGORY[dispute.category] ?? dispute.category} · opened by the {dispute.opened_by} {fmt(dispute.created_at)} · paid {fmt(order.paid_at)} · delivered {fmt(order.delivered_at)} · protection until {fmt(order.protection_ends_at)}
        </div>
      </div>

      <div className="grid three">
        {FACTS.map(([k, label, judge]) => {
          const v = facts[k];
          const tone = judge(v);
          return (
            <div key={k} className={cn('card small', tone === 'bad' && 'text-disputed')} style={{ padding: '10px 12px' }}>
              {tone === 'good' ? '✓' : tone === 'bad' ? '!' : '·'} {label}: <b>{v == null ? 'n/a' : v ? 'yes' : 'no'}</b>
            </div>
          );
        })}
      </div>

      <div className="grid two">
        <Party p={buyer} label="Buyer" />
        <Party p={seller} label="Seller" />
      </div>

      <div className="grid two">
        {(['buyer', 'seller'] as const).map((side) => (
          <div key={side} className="card stack" style={{ gap: 8 }}>
            <b>{side === 'buyer' ? 'Buyer' : 'Seller'} statements</b>
            {statements.filter((s: any) => s.role === side).length === 0 ? (
              <span className="small muted">None yet.</span>
            ) : (
              statements.filter((s: any) => s.role === side).map((s: any) => (
                <div key={s.id} className="small"><span className="muted">{fmt(s.created_at)}</span><div style={{ whiteSpace: 'pre-wrap' }}>{s.body}</div></div>
              ))
            )}
          </div>
        ))}
      </div>

      <div className="grid two">
        <div className="card small stack" style={{ gap: 4 }}>
          <b>Listing as bought</b>
          <div>{snapshot?.offer?.title}</div>
          {snapshot?.offer?.description && <div className="muted" style={{ whiteSpace: 'pre-wrap' }}>{snapshot.offer.description}</div>}
          <div className="muted">Captured {fmt(snapshot?.captured_at)}{snapshot?.sha256 ? ` · sha256 ${snapshot.sha256.slice(0, 12)}…` : ''}</div>
        </div>
        <div className="card small stack" style={{ gap: 4 }}>
          <b>Payment checks</b>
          {payment ? (
            <div>
              {payment.card_brand} ····{payment.card_last4} · AVS {payment.avs_result ?? '—'} · CVV {payment.cvv_result ?? '—'} · card country {payment.billing_country ?? '—'} · IP country {payment.ip_country ?? '—'}
            </div>
          ) : (
            <div className="muted">No card details (crypto or credit-only order).</div>
          )}
          {file.risk.length > 0 && <div className="text-disputed">{file.risk.length} risk flag(s) on this order or a confirmed flag on a party.</div>}
        </div>
      </div>

      <div className="card stack" style={{ gap: 8 }}>
        <div className="row spread">
          <b>Timeline</b>
          <div className="filters" role="group" aria-label="Timeline filter" style={{ margin: 0 }}>
            {['all', 'message', 'status', 'statement', 'delivery', 'flag'].map((k) => (
              <button key={k} aria-pressed={only === k} onClick={() => setOnly(k)}>{k === 'all' ? 'Everything' : k[0]!.toUpperCase() + k.slice(1) + 's'}</button>
            ))}
          </div>
        </div>
        <ol className="m-0 list-none stack p-0" style={{ gap: 6 }}>
          {items.map((t: any, i: number) => (
            <li key={i} className={cn('small rounded-md border border-border px-3 py-2', WHO_STYLE[t.who])}>
              <span className="muted">{fmt(t.at)} · {t.who} · {t.type}{t.meta?.seq ? ` #${t.meta.seq}` : ''}</span>
              <div style={{ whiteSpace: 'pre-wrap' }}>{t.text}</div>
            </li>
          ))}
        </ol>
      </div>

      {dispute.status === 'open' && (
        <div className="card stack">
          <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Decision note (shared in the order record)" style={{ minHeight: 70 }} />
          <div className="row">
            <button className="btn ghost" disabled={note.trim().length < 3} onClick={() => onResolve('buyer', note)}>Refund buyer</button>
            <button className="btn release" disabled={note.trim().length < 3} onClick={() => onResolve('seller', note)}>Release to seller</button>
          </div>
        </div>
      )}
    </div>
  );
}
