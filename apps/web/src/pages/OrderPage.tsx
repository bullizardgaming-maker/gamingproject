import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, money, realtime } from '../api';
import { Chat } from '../components/Chat';
import { AlsoBought } from '../components/AlsoBought';
import { BoostProgress, type ProgressUpdate } from '../components/BoostProgress';
import { BuyerCard, type BuyerRep, type BuyerTag } from '../components/BuyerReputation';
import { EscrowTrack, formatRemaining, type TrackVariant } from '../components/EscrowTrack';
import { CryptoCheckout, REFUND_COINS, RefundAddressForm } from '../components/CryptoCheckout';
import { useSession } from '../session';
import { usePageMeta } from '@/lib/seo';

interface OrderDetail {
  id: string;
  buyer_id: string;
  seller_id: string;
  buyer_name: string;
  seller_name: string;
  offer_id: string;
  offer_title: string;
  game: string;
  category_kind: string;
  delivery_mode: string;
  quantity: number;
  amount_cents: number;
  currency: string;
  commission_bps: number;
  seller_net_cents: number;
  seller_tier: string;
  rail: 'fiat' | 'crypto';
  payment_provider?: string | null;
  status: string;
  protection: 'inspection_72h' | 'insurance_14d' | 'until_confirmed';
  protection_ends_at: string | null;
  delivered_at: string | null;
  escrow_frozen: boolean;
  seller_protected: boolean;
  room_id: string;
  crypto_refund?: { id: string; amount_cents: number; currency: string; status: string; refund_address: string | null; refund_currency: string | null; tx_hash: string | null } | null;
  checklist: {
    items: Array<{ key: string; label: string; done: boolean; auto?: boolean }>;
    completed_at: string | null;
    /** Handover check: set when the listing showed a linked Steam/Riot account; `handover_at` once the buyer signed in to it. */
    handover_platform: 'steam' | 'riot' | null;
    handover_at: string | null;
  } | null;
  dispute: { reason: string; status: string; category?: string; statements?: Array<{ id: string; role: 'buyer' | 'seller'; body: string; author_name: string; created_at: string }> } | null;
  review: { rating: number; comment: string; seller_reply: string | null } | null;
  events: Array<{ from_status: string | null; to_status: string; reason: string; created_at: string }>;
  warranty_days?: number;
  warranty_ends_at?: string | null;
  warranty_claims?: WarrantyClaim[];
  progress?: ProgressUpdate[];
  /** Seller and staff only. */
  buyer_reputation?: BuyerRep | null;
  buyer_rating?: { positive: boolean; tags: BuyerTag[] } | null;
}

interface WarrantyClaim {
  id: string;
  reason: 'recovered' | 'banned' | 'locked' | 'other';
  details: string;
  status: 'open' | 'seller_fixed' | 'escalated' | 'resolved' | 'refunded' | 'rejected' | 'withdrawn';
  seller_message: string | null;
  respond_by: string;
  confirm_by: string | null;
  decision_note: string | null;
  created_at: string;
}

const CLAIM_REASON: Record<WarrantyClaim['reason'], string> = {
  recovered: 'Taken back by its original owner',
  banned: 'Banned',
  locked: 'Locked or can’t sign in',
  other: 'Something else',
};
const CLAIM_STATUS: Record<WarrantyClaim['status'], string> = {
  open: 'Waiting for the seller',
  seller_fixed: 'Seller says it’s fixed',
  escalated: 'With an arbiter',
  resolved: 'Resolved',
  refunded: 'Refunded',
  rejected: 'Rejected by an arbiter',
  withdrawn: 'Withdrawn',
};

/** Account warranty: its end date, the buyer's claim form, and each open claim's next step for whoever owes it. */
function WarrantyCard({ order, isBuyer, isSeller, onDone }: { order: OrderDetail; isBuyer: boolean; isSeller: boolean; onDone: () => void }) {
  const [reason, setReason] = useState<WarrantyClaim['reason']>('recovered');
  const [details, setDetails] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const claims = order.warranty_claims ?? [];
  const open = claims.find((c) => ['open', 'seller_fixed', 'escalated'].includes(c.status));
  const running = !!order.warranty_ends_at && new Date(order.warranty_ends_at) > new Date();
  if (!order.warranty_days || (!order.warranty_ends_at && !claims.length)) return null;
  const run = async (path: string, body: object) => {
    setError('');
    try {
      await api(path, { body });
      setDetails('');
      setMessage('');
      onDone();
    } catch (e: any) {
      setError(e.message);
    }
  };
  const when = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <section className="card stack" aria-labelledby="warranty-title">
      <div className="row spread">
        <h3 id="warranty-title" style={{ margin: 0 }}>{order.warranty_days}-day account warranty</h3>
        {order.warranty_ends_at && <span className={`chip ${running ? 'released' : ''}`}>{running ? `Until ${when(order.warranty_ends_at)}` : 'Ended'}</span>}
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        If the account is taken back by its original owner, banned or locked, claim here. The seller has 48 hours to fix it or refund; otherwise an arbiter decides.
        {isSeller && ' This order’s payout stays on hold until the warranty ends or a claim is settled.'}
      </p>
      {claims.map((c) => (
        <div key={c.id} className="stack small" style={{ gap: 6, padding: '10px 12px', border: '1px solid var(--rule)', borderRadius: 8 }}>
          <div className="row spread">
            <b>{CLAIM_REASON[c.reason]}</b>
            <span className={`chip ${['refunded', 'resolved'].includes(c.status) ? 'released' : c.status === 'escalated' ? 'disputed' : 'held'}`}>{CLAIM_STATUS[c.status]}</span>
          </div>
          <div style={{ whiteSpace: 'pre-wrap' }}>{c.details}</div>
          {c.seller_message && <div className="muted">Seller: {c.seller_message}</div>}
          {c.decision_note && <div className="muted">Arbiter: {c.decision_note}</div>}
          {c.status === 'open' && <div className="muted">Seller answers by {when(c.respond_by)}.</div>}
          {c.status === 'seller_fixed' && c.confirm_by && <div className="muted">Buyer confirms by {when(c.confirm_by)}; after that the fix stands.</div>}
          {isSeller && c.status === 'open' && (
            <div className="stack" style={{ gap: 8 }}>
              <label className="field">Message to the buyer (optional)<input value={message} onChange={(e) => setMessage(e.target.value)} maxLength={1000} /></label>
              <div className="row">
                <button className="btn" onClick={() => run(`/warranty-claims/${c.id}/seller`, { action: 'fixed', message: message || undefined })}>It’s fixed</button>
                <button className="btn ghost" onClick={() => run(`/warranty-claims/${c.id}/seller`, { action: 'refund', message: message || undefined })}>Refund the buyer</button>
                <button className="btn ghost" onClick={() => run(`/warranty-claims/${c.id}/seller`, { action: 'contest', message: message || undefined })}>Contest it</button>
              </div>
            </div>
          )}
          {isBuyer && c.status === 'seller_fixed' && (
            <div className="row">
              <button className="btn" onClick={() => run(`/warranty-claims/${c.id}/buyer`, { action: 'confirm' })}>Yes, it works</button>
              <button className="btn ghost" onClick={() => run(`/warranty-claims/${c.id}/buyer`, { action: 'escalate' })}>Still broken: ask an arbiter</button>
            </div>
          )}
          {isBuyer && ['open', 'seller_fixed', 'escalated'].includes(c.status) && (
            <button className="btn ghost" style={{ alignSelf: 'start' }} onClick={() => run(`/warranty-claims/${c.id}/buyer`, { action: 'withdraw' })}>Withdraw claim</button>
          )}
        </div>
      ))}
      {isBuyer && running && !open && order.status === 'completed' && (
        <details>
          <summary className="cursor-pointer">Make a warranty claim</summary>
          <div className="stack" style={{ marginTop: 10, gap: 8 }}>
            <label className="field">
              What happened?
              <select value={reason} onChange={(e) => setReason(e.target.value as WarrantyClaim['reason'])}>
                {Object.entries(CLAIM_REASON).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <label className="field">
              Details for the seller
              <textarea value={details} onChange={(e) => setDetails(e.target.value)} placeholder="When did it happen, and what do you see when you sign in? Put screenshots in the chat." />
            </label>
            <button className="btn" disabled={details.trim().length < 10} onClick={() => run(`/orders/${order.id}/warranty-claims`, { reason, details })}>Send claim</button>
          </div>
        </details>
      )}
      {error && <div className="alert" role="alert">{error}</div>}
    </section>
  );
}

const STATUS_TEXT: Record<string, string> = {
  awaiting_payment: 'Waiting for payment',
  paid: 'Paid, awaiting delivery',
  delivered: 'Delivered, in protection window',
  completed: 'Completed',
  disputed: 'Dispute open',
  refunded: 'Refunded',
  cancelled: 'Cancelled',
  charged_back: 'Charged back',
};

export const DISPUTE_CATEGORY: Record<string, string> = {
  not_delivered: 'Not delivered',
  not_as_described: 'Not as described',
  not_working: 'Doesn’t work (code invalid, item missing)',
  account_recovered: 'Account taken back by a previous owner',
  other: 'Something else',
};

export function OrderPage() {
  usePageMeta({ title: 'Order', noindex: true });
  const { id } = useParams();
  const { user } = useSession();
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [items, setItems] = useState<Array<{ id: string; content: string }>>([]);
  const [error, setError] = useState('');
  const [payload, setPayload] = useState('');
  const [reason, setReason] = useState('');
  const [category, setCategory] = useState('not_delivered');
  const [statement, setStatement] = useState('');
  const [now, setNow] = useState(Date.now());
  const [handoverConsent, setHandoverConsent] = useState(false);
  const [followUp, setFollowUp] = useState('');
  const [params, setParams] = useSearchParams();
  const handoverResult = params.get('handover');

  const load = useCallback(async () => {
    try {
      const o = await api<OrderDetail>(`/orders/${id}`);
      setOrder(o);
      if (user && o.buyer_id === user.id && ['delivered', 'completed', 'disputed'].includes(o.status)) {
        setItems(await api(`/orders/${id}/items`));
      }
    } catch (e: any) {
      setError(e.message);
    }
  }, [id, user]);

  useEffect(() => {
    load();
    const off = realtime.listen((f) => f.type === 'notification' && f.data?.orderId === id && load());
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      off();
      clearInterval(tick);
    };
  }, [id, load]);

  if (!order || !user) return <p className="muted">{error || 'Loading order…'}</p>;
  const isBuyer = user.id === order.buyer_id;
  const isSeller = user.id === order.seller_id;

  const act = async (path: string, body?: unknown) => {
    setError('');
    try {
      await api(`/orders/${order.id}/${path}`, { method: body === undefined ? 'POST' : path === 'checklist' ? 'PATCH' : 'POST', body: body ?? {} });
      await load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const windowMs = order.protection === 'insurance_14d' ? 14 * 86_400_000 : 72 * 3_600_000;
  const ends = order.protection_ends_at ? new Date(order.protection_ends_at).getTime() : 0;
  // No deadline: the coin sits in escrow until the buyer confirms (or staff release), so nothing drifts.
  const elapsed = order.status === 'delivered' && ends ? 1 - (ends - now) / windowMs : 0;
  const untilConfirmed = order.protection === 'until_confirmed';
  const deliveredAgoMs = order.delivered_at ? now - new Date(order.delivered_at).getTime() : 0;
  const canFollowUp = isSeller && order.status === 'delivered' && untilConfirmed && deliveredAgoMs >= 24 * 3_600_000;
  const askRelease = async () => {
    setError('');
    try {
      await api(`/orders/${order.id}/follow-up`, { body: {} });
      setFollowUp('Support has your request and will review the delivery proof in the chat.');
    } catch (e: any) {
      setError(e.message);
    }
  };
  const stage: 0 | 1 | 2 = ['completed'].includes(order.status) ? 2 : ['awaiting_payment', 'cancelled'].includes(order.status) ? 0 : 1;
  const variant: TrackVariant =
    order.status === 'completed' ? 'released' : ['refunded', 'charged_back', 'cancelled'].includes(order.status) ? 'refunded' : order.status === 'disputed' || order.escrow_frozen ? 'disputed' : 'held';
  const clock = order.status === 'delivered' ? (ends ? formatRemaining(ends - now) : isBuyer ? 'Until you confirm' : 'Until the buyer confirms') : STATUS_TEXT[order.status];
  const checklistDone = !order.checklist || !!order.checklist.completed_at;
  const handoverVerified = !!order.checklist?.handover_at;
  const platformName = order.checklist?.handover_platform === 'steam' ? 'Steam' : 'Riot';
  const canConfirm = !order.escrow_frozen && (checklistDone || (handoverVerified && handoverConsent));
  const startHandover = async () => {
    setError('');
    try {
      const { url } = await api<{ url: string }>(`/orders/${order.id}/handover/start`, { method: 'POST', body: {} });
      window.location.assign(url);
    } catch (e: any) {
      setError(e.message);
    }
  };
  const HANDOVER_MESSAGES: Record<string, string> = {
    ok: 'Handover confirmed: you signed in to the account you bought.',
    wrong_account: 'That is not the account this order delivered. Sign in with the account you bought.',
    link_expired: 'The sign-in link expired. Start the handover check again.',
    link_failed: `${platformName} did not confirm the sign-in. Try again.`,
  };
  const names = { [order.buyer_id]: order.buyer_name, [order.seller_id]: order.seller_name };

  return (
    <div className="stack">
      <div className="row spread">
        <div>
          <div className="eyebrow">Order {order.id.slice(0, 8)} · {order.game}</div>
          <h1 style={{ fontSize: 36 }}>{order.offer_title}{order.quantity > 1 ? ` ×${order.quantity}` : ''}</h1>
        </div>
        <span className={`chip ${variant}`}>{STATUS_TEXT[order.status]}</span>
      </div>

      <div className="card">
        <EscrowTrack
          amountCents={order.amount_cents}
          stage={stage}
          variant={variant}
          elapsed={elapsed}
          windowLabel={order.protection === 'insurance_14d' ? '14-day asset insurance' : untilConfirmed ? 'Escrow until confirmed' : '72-hour inspection'}
          clock={clock}
        />
        <p className="small muted" style={{ marginTop: 12 }}>
          {isSeller
            ? `You receive ${money(order.seller_net_cents, order.currency)} after the ${(order.commission_bps / 100).toFixed(2)}% ${order.seller_tier} tier fee.`
            : order.status === 'awaiting_payment'
              ? `${money(order.amount_cents, order.currency)} is held in escrow once your payment is confirmed.`
              : `Paid ${money(order.amount_cents, order.currency)} via ${order.rail === 'crypto' ? 'on-chain escrow' : order.payment_provider === 'nowpayments' ? 'crypto' : 'card'}.`}
          {order.escrow_frozen && order.status !== 'disputed' && ' This order is in a routine security review; funds stay in escrow until it finishes.'}{' '}
          <Link to={`/support/new?category=order&order=${order.id}`}>Get help with this order</Link>
        </p>
      </div>

      {error && <div className="alert" role="alert">{error}</div>}
      {handoverResult && (
        <div className={handoverResult === 'ok' ? 'notice' : 'alert'} role="status">
          {HANDOVER_MESSAGES[handoverResult] ?? HANDOVER_MESSAGES.link_failed}{' '}
          <button className="btn ghost small" onClick={() => setParams({}, { replace: true })}>Dismiss</button>
        </div>
      )}

      <div className="order-layout">
        <div className="stack">
          {order.status === 'awaiting_payment' && isBuyer && order.rail === 'crypto' && <CryptoDeposit orderId={order.id} />}
          {order.status === 'awaiting_payment' && isBuyer && order.payment_provider === 'nowpayments' && (
            <CryptoCheckout base={`/orders/${order.id}`} amountCents={order.amount_cents} currency={order.currency} onPaid={load} />
          )}
          {isBuyer && order.crypto_refund && <RefundAddressForm orderId={order.id} refund={order.crypto_refund} coins={REFUND_COINS} onDone={load} />}
          {isSeller && order.status === 'delivered' && untilConfirmed && (
            <div className="card stack">
              <h3>Waiting for the buyer</h3>
              <p className="small muted" style={{ margin: 0 }}>
                The payment is released when the buyer confirms. If they go quiet, support can release it for you from 24 hours after delivery; keep your delivery proof in the chat.
              </p>
              {followUp ? <p className="small" role="status">{followUp}</p> : canFollowUp && <button className="btn ghost" type="button" onClick={askRelease}>Ask support to release the payment</button>}
            </div>
          )}

          {items.length > 0 && (
            <div className="card stack">
              <h3>Your delivery</h3>
              {items.map((i) => (
                <div key={i.id} className="secret">{i.content}</div>
              ))}
              <p className="small muted">Only you can see this. Save it somewhere safe.</p>
            </div>
          )}

          {isBuyer && order.checklist && order.status === 'delivered' && (
            <div className="card stack checklist">
              <h3>Security changeover</h3>
              <p className="small muted">Secure the account before confirming. Each step takes the account further out of the previous owner's reach.</p>
              <div>
                {order.checklist.items.map((i) => (
                  <label key={i.key}>
                    <input type="checkbox" checked={i.done} disabled={!!i.auto} aria-label={i.auto ? `${i.label} (confirmed by sign-in)` : undefined} onChange={(e) => act('checklist', { key: i.key, done: e.target.checked })} />
                    <span>{i.label}</span>
                  </label>
                ))}
              </div>
              {order.checklist.handover_platform && (
                <div className="stack" style={{ gap: 6 }}>
                  {handoverVerified ? (
                    <p className="small muted">Handover confirmed by {platformName} sign-in. You can release the payment early below, or finish the checklist first.</p>
                  ) : (
                    <>
                      <p className="small muted">This listing showed a {platformName} sign-in badge. Sign in with the account you received to prove it is yours now; that ticks the step above and lets you release the payment early if you choose.</p>
                      <button type="button" className="btn" onClick={startHandover}>Sign in with {platformName} to confirm the handover</button>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {order.buyer_reputation && (
            <BuyerCard orderId={order.id} name={order.buyer_name} rep={order.buyer_reputation} rating={order.buyer_rating ?? null} canRate={isSeller && order.status === 'completed'} onDone={load} />
          )}
          <BoostProgress order={order} isSeller={isSeller} onDone={load} />

          {isSeller && order.status === 'paid' && order.delivery_mode === 'manual' && (
            <div className="card stack">
              <h3>Deliver this order</h3>
              <label className="field">
                Delivery details (stored encrypted, visible only to the buyer)
                <textarea value={payload} onChange={(e) => setPayload(e.target.value)} placeholder="Login, password, recovery details or completion notes" />
              </label>
              <button className="btn release" disabled={order.escrow_frozen} onClick={() => act('deliver', { payload: payload || undefined })}>Mark as delivered</button>
            </div>
          )}

          {isBuyer && order.status === 'delivered' && order.rail === 'fiat' && (
            <div className="card stack">
              <h3>Everything working?</h3>
              <p className="small muted">Confirming releases the payment to the seller now. You can't open a dispute after that.</p>
              {!checklistDone && handoverVerified && (
                <label className="small">
                  <input type="checkbox" checked={handoverConsent} onChange={(e) => setHandoverConsent(e.target.checked)} />{' '}
                  Release now, before the checklist is finished. I have confirmed I control the account and I understand the 14-day insurance ends today.
                </label>
              )}
              <button className="btn release" disabled={!canConfirm} onClick={() => act('confirm', handoverConsent ? { handoverConsent: true } : undefined)}>Confirm and release payment</button>
              {!checklistDone && !handoverVerified && <p className="small muted">Finish the security changeover first.</p>}
            </div>
          )}

          {(isBuyer || isSeller) && ['paid', 'delivered'].includes(order.status) && order.rail === 'fiat' && (
            <details className="card">
              <summary style={{ cursor: 'pointer' }}><b>Open a dispute</b></summary>
              <div className="stack" style={{ marginTop: 12 }}>
                <p className="small muted">Escrow freezes and an arbiter reviews this order's chat. Describe what happened and add any proof in the chat.</p>
                <label className="field">
                  What's the problem?
                  <select value={category} onChange={(e) => setCategory(e.target.value)}>
                    {Object.entries(DISPUTE_CATEGORY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </label>
                <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What happened? Be specific: what you expected, what you got, and when." />
                <button className="btn dispute" disabled={reason.trim().length < 10} onClick={() => act('dispute', { reason, category })}>Open dispute</button>
              </div>
            </details>
          )}

          {isBuyer && order.status === 'completed' && !order.review && <ReviewForm orderId={order.id} onDone={load} />}
          <WarrantyCard order={order} isBuyer={isBuyer} isSeller={isSeller} onDone={load} />
          {order.review && (
            <div className="card stack">
              <h3>Review</h3>
              <p><span className="mono">{'★'.repeat(order.review.rating)}{'☆'.repeat(5 - order.review.rating)}</span> {order.review.comment}</p>
              {order.review.seller_reply && <p className="small muted">Seller replied: {order.review.seller_reply}</p>}
            </div>
          )}

          {order.dispute && (
            <div className="card stack">
              <div className="row spread">
                <h3 style={{ margin: 0 }}>Dispute</h3>
                <span className={`chip ${order.dispute.status === 'open' ? 'disputed' : 'released'}`}>{order.dispute.status.replace('_', ' ')}</span>
              </div>
              {order.dispute.category && <div className="small muted">{DISPUTE_CATEGORY[order.dispute.category] ?? order.dispute.category}</div>}
              {(order.dispute.statements ?? []).map((s) => (
                <div key={s.id} className="small" style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--rule)', background: s.role === 'buyer' ? 'var(--paper)' : 'var(--held-soft)' }}>
                  <b>{s.role === 'buyer' ? 'Buyer' : 'Seller'} statement</b> <span className="muted">· {s.author_name} · {new Date(s.created_at).toLocaleString()}</span>
                  <div style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{s.body}</div>
                </div>
              ))}
              {order.dispute.status === 'open' && (isBuyer || isSeller) && (
                <div className="stack" style={{ gap: 8 }}>
                  <textarea value={statement} onChange={(e) => setStatement(e.target.value)} placeholder="Add your statement for the arbiter (up to 5). Put screenshots in the chat." />
                  <button className="btn ghost" disabled={statement.trim().length < 10} onClick={async () => (await act('dispute/statements', { body: statement }), setStatement(''))}>Add statement</button>
                </div>
              )}
            </div>
          )}

          <div className="card">
            <h3>History</h3>
            <div className="table-wrap">
              <table className="data">
                <tbody>
                  {order.events.map((e, i) => (
                    <tr key={i}>
                      <td className="mono small">{new Date(e.created_at).toLocaleString()}</td>
                      <td>{STATUS_TEXT[e.to_status] ?? e.to_status}</td>
                      <td className="small muted">{e.reason.replace(/_/g, ' ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <Link to="/orders" className="small">All orders</Link>
        </div>
        <Chat roomId={order.room_id} meId={user.id} names={names} />
      </div>
      {isBuyer && !['awaiting_payment', 'cancelled'].includes(order.status) && <AlsoBought offerId={order.offer_id} game={order.game} fillers />}
    </div>
  );
}

function CryptoDeposit({ orderId }: { orderId: string }) {
  const [wallet, setWallet] = useState('');
  const [terms, setTerms] = useState<unknown>(null);
  const [error, setError] = useState('');
  const fetchTerms = async () => {
    setError('');
    try {
      setTerms(await api(`/orders/${orderId}/crypto-terms?token=USDC&wallet=${wallet}`));
    } catch (e: any) {
      setError(e.message);
    }
  };
  return (
    <div className="card stack">
      <h3>Deposit USDC into escrow</h3>
      <p className="muted small">
        Get the escrow terms signed for your wallet, then call <span className="mono">createEscrow(terms, signature)</span> on the escrow
        contract. This order updates by itself once the deposit has 3 confirmations.
      </p>
      <div className="row">
        <input className="mono" placeholder="0x… (the wallet you will pay from)" value={wallet} onChange={(e) => setWallet(e.target.value.trim())} style={{ flex: 1 }} />
        <button className="btn ghost" disabled={!/^0x[0-9a-fA-F]{40}$/.test(wallet)} onClick={fetchTerms}>Get signed terms</button>
      </div>
      {error && <div className="alert" role="alert">{error}</div>}
      {terms !== null && <pre className="secret" style={{ whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto' }}>{JSON.stringify(terms, null, 2)}</pre>}
    </div>
  );
}

function ReviewForm({ orderId, onDone }: { orderId: string; onDone: () => void }) {
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');
  const submit = async () => {
    setError('');
    try {
      await api(`/orders/${orderId}/review`, { body: { rating, comment } });
      onDone();
    } catch (e: any) {
      setError(e.message);
    }
  };
  return (
    <div className="card stack">
      <h3>Rate this seller</h3>
      <div className="row" role="radiogroup" aria-label="Rating">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" className={`btn ${n <= rating ? '' : 'ghost'}`} aria-checked={n === rating} role="radio" onClick={() => setRating(n)}>
            {n}★
          </button>
        ))}
      </div>
      <textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder="What went well or badly? (optional)" maxLength={1000} style={{ minHeight: 70 }} />
      {error && <div className="alert" role="alert">{error}</div>}
      <button className="btn" onClick={submit}>Post review</button>
    </div>
  );
}
