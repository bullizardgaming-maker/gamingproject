import { ShieldCheck } from '@phosphor-icons/react';
import { BuyerProtection } from '../components/Brand';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, apiUpload, money, realtime } from '../api';
import { Chat } from '../components/Chat';
import { BoostProgress, type ProgressUpdate } from '../components/BoostProgress';
import { BuyerCard, type BuyerRep, type BuyerTag } from '../components/BuyerReputation';
import { formatRemaining, type TrackVariant } from '../components/EscrowTrack';
import { CheckoutSteps, CryptoCheckout, REFUND_COINS, RefundAddressForm } from '../components/CryptoCheckout';
import { DeliveryProof, type ProofAttachment } from '../components/DeliveryProof';
import { useSession } from '../session';
import { currentLocale, intlLocale, t } from '../i18n';
import { usePageMeta } from '@/lib/seo';
import { attributePairs } from '@/lib/attributes';

interface OrderDetail {
  tos_version?: string | null;
  tos_accepted_at?: string | null;
  created_at: string;
  id: string;
  buyer_id: string;
  seller_id: string;
  buyer_name: string;
  seller_name: string;
  offer_id: string;
  offer_title: string;
  game: string;
  category_kind: string;
  category_slug?: string;
  /** The listing's game fields (server, league…), when the API sends them. */
  attributes?: Record<string, string>;
  delivery_mode: string;
  quantity: number;
  amount_cents: number;
  credit_cents?: number;
  charged_cents?: number;
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
  /** Human order ID, e.g. order#7F3AK2Q. */
  ref?: string;
  /** The buyer's in-game character name / UID (games that deliver in-game). */
  character_name?: string | null;
  handover_field?: { key: string; label: string; hint: string } | null;
  /** Set when the seller must attach a photo/video before marking delivered. */
  proof_required?: boolean;
  delivery_proof?: ProofAttachment | null;
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

const CLAIM_REASONS: WarrantyClaim['reason'][] = ['recovered', 'banned', 'locked', 'other'];
const claimReason = (r: WarrantyClaim['reason']) => t(`order.claimReason.${r}`);
const claimStatus = (s: WarrantyClaim['status']) => t(`order.claimStatus.${s}`);

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
        <h3 id="warranty-title" style={{ margin: 0 }}>{t('order.warranty.title', { days: String(order.warranty_days) })}</h3>
        {order.warranty_ends_at && <span className={`chip ${running ? 'released' : ''}`}>{running ? t('order.warranty.until', { when: when(order.warranty_ends_at) }) : t('order.warranty.ended')}</span>}
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        {t('order.warranty.lede')}
        {isSeller && ` ${t('order.warranty.sellerHold')}`}
      </p>
      {claims.map((c) => (
        <div key={c.id} className="stack small" style={{ gap: 6, padding: '10px 12px', border: '1px solid var(--rule)', borderRadius: 8 }}>
          <div className="row spread">
            <b>{claimReason(c.reason)}</b>
            <span className={`chip ${['refunded', 'resolved'].includes(c.status) ? 'released' : c.status === 'escalated' ? 'disputed' : 'held'}`}>{claimStatus(c.status)}</span>
          </div>
          <div style={{ whiteSpace: 'pre-wrap' }}>{c.details}</div>
          {c.seller_message && <div className="muted">{t('order.claim.seller', { message: c.seller_message })}</div>}
          {c.decision_note && <div className="muted">{t('order.claim.arbiter', { note: c.decision_note })}</div>}
          {c.status === 'open' && <div className="muted">{t('order.claim.respondBy', { when: when(c.respond_by) })}</div>}
          {c.status === 'seller_fixed' && c.confirm_by && <div className="muted">{t('order.claim.confirmBy', { when: when(c.confirm_by) })}</div>}
          {isSeller && c.status === 'open' && (
            <div className="stack" style={{ gap: 8 }}>
              <label className="field">{t('order.claim.message')}<input value={message} onChange={(e) => setMessage(e.target.value)} maxLength={1000} /></label>
              <div className="row">
                <button className="btn" onClick={() => run(`/warranty-claims/${c.id}/seller`, { action: 'fixed', message: message || undefined })}>{t('order.claim.fixed')}</button>
                <button className="btn ghost" onClick={() => run(`/warranty-claims/${c.id}/seller`, { action: 'refund', message: message || undefined })}>{t('order.claim.refund')}</button>
                <button className="btn ghost" onClick={() => run(`/warranty-claims/${c.id}/seller`, { action: 'contest', message: message || undefined })}>{t('order.claim.contest')}</button>
              </div>
            </div>
          )}
          {isBuyer && c.status === 'seller_fixed' && (
            <div className="row">
              <button className="btn" onClick={() => run(`/warranty-claims/${c.id}/buyer`, { action: 'confirm' })}>{t('order.claim.works')}</button>
              <button className="btn ghost" onClick={() => run(`/warranty-claims/${c.id}/buyer`, { action: 'escalate' })}>{t('order.claim.escalate')}</button>
            </div>
          )}
          {isBuyer && ['open', 'seller_fixed', 'escalated'].includes(c.status) && (
            <button className="btn ghost" style={{ alignSelf: 'start' }} onClick={() => run(`/warranty-claims/${c.id}/buyer`, { action: 'withdraw' })}>{t('order.claim.withdraw')}</button>
          )}
        </div>
      ))}
      {isBuyer && running && !open && order.status === 'completed' && (
        <details>
          <summary className="cursor-pointer">{t('order.claim.make')}</summary>
          <div className="stack" style={{ marginTop: 10, gap: 8 }}>
            <label className="field">
              {t('order.claim.what')}
              <select value={reason} onChange={(e) => setReason(e.target.value as WarrantyClaim['reason'])}>
                {CLAIM_REASONS.map((k) => <option key={k} value={k}>{claimReason(k)}</option>)}
              </select>
            </label>
            <label className="field">
              {t('order.claim.details')}
              <textarea value={details} onChange={(e) => setDetails(e.target.value)} placeholder={t('order.claim.detailsHint')} />
            </label>
            <button className="btn" disabled={details.trim().length < 10} onClick={() => run(`/orders/${order.id}/warranty-claims`, { reason, details })}>{t('order.claim.send')}</button>
          </div>
        </details>
      )}
      {error && <div className="alert" role="alert">{error}</div>}
    </section>
  );
}

const ORDER_STATUSES = ['awaiting_payment', 'paid', 'delivered', 'completed', 'disputed', 'refunded', 'cancelled', 'charged_back'] as const;
/** Status chip text in the active language; unknown statuses fall back to the raw value. */
function statusText(status: string): string {
  return (ORDER_STATUSES as readonly string[]).includes(status) ? t(`order.status.${status as (typeof ORDER_STATUSES)[number]}`) : status;
}

const DISPUTE_CATEGORIES = ['not_delivered', 'not_as_described', 'not_working', 'account_recovered', 'other'] as const;
/** Dispute category in the active language (the order page); staff screens use the English map below. */
const disputeCategory = (c: string) => ((DISPUTE_CATEGORIES as readonly string[]).includes(c) ? t(`order.dispute.cat.${c as (typeof DISPUTE_CATEGORIES)[number]}`) : c);

export const DISPUTE_CATEGORY: Record<string, string> = {
  not_delivered: 'Not delivered',
  not_as_described: 'Not as described',
  not_working: 'Doesn’t work (code invalid, item missing)',
  account_recovered: 'Account taken back by a previous owner',
  other: 'Something else',
};

export function OrderPage() {
  usePageMeta({ title: t('order.meta'), noindex: true });
  const { id } = useParams();
  const { user } = useSession();
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [items, setItems] = useState<Array<{ id: string; content: string }>>([]);
  const [error, setError] = useState('');
  const [payload, setPayload] = useState('');
  const [proofFile, setProofFile] = useState<File | null>(null);
  const [delivering, setDelivering] = useState(false);
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

  if (!order || !user) return <p className="muted">{error || t('order.loading')}</p>;
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
      setFollowUp(t('order.followUpSent'));
    } catch (e: any) {
      setError(e.message);
    }
  };
  const stage: 0 | 1 | 2 = ['completed'].includes(order.status) ? 2 : ['awaiting_payment', 'cancelled'].includes(order.status) ? 0 : 1;
  const variant: TrackVariant =
    order.status === 'completed' ? 'released' : ['refunded', 'charged_back', 'cancelled'].includes(order.status) ? 'refunded' : order.status === 'disputed' || order.escrow_frozen ? 'disputed' : 'held';
  const clock = order.status === 'delivered' ? (ends ? formatRemaining(ends - now) : isBuyer ? t('order.untilYouConfirm') : t('order.untilBuyerConfirms')) : statusText(order.status);
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
    ok: t('order.handover.ok'),
    wrong_account: t('order.handover.wrong_account'),
    link_expired: t('order.handover.link_expired'),
    link_failed: t('order.handover.link_failed', { platform: platformName }),
  };
  const names = { [order.buyer_id]: order.buyer_name, [order.seller_id]: order.seller_name };

  const at = (status: string) => order.events.find((e) => e.to_status === status)?.created_at;
  const hm = (iso?: string | null) => (iso ? new Date(iso).toLocaleString(intlLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
  const paid = !['awaiting_payment', 'cancelled'].includes(order.status);
  const delivered = !!order.delivered_at || ['delivered', 'completed'].includes(order.status);
  const done = order.status === 'completed';
  const stopped = ['disputed', 'refunded', 'charged_back', 'cancelled'].includes(order.status) || order.escrow_frozen;
  const steps: Array<{ label: string; sub?: string; state: 'done' | 'now' | 'stop' | '' }> = [
    { label: t('order.step.paid'), sub: paid ? [money(order.amount_cents, order.currency), hm(at('paid'))].filter(Boolean).join(' · ') : undefined, state: paid ? 'done' : 'now' },
    { label: order.proof_required || order.delivery_proof ? t('order.step.deliveredProof') : t('order.step.delivered'), sub: hm(order.delivered_at) || undefined, state: delivered ? 'done' : paid ? (stopped ? 'stop' : 'now') : '' },
    { label: isBuyer ? t('order.step.youConfirm') : t('order.step.buyerConfirms'), sub: order.status === 'delivered' ? clock : undefined, state: done ? 'done' : delivered ? (stopped ? 'stop' : 'now') : '' },
    { label: isSeller ? t('order.step.youPaid') : t('order.step.sellerPaid'), sub: done ? hm(at('completed')) || undefined : undefined, state: done ? 'done' : '' },
  ];
  const openDispute = () => {
    const d = document.getElementById('order-dispute') as HTMLDetailsElement | null;
    if (d) { d.open = true; d.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  };
  const checkoutMode = order.status === 'awaiting_payment' && isBuyer && order.payment_provider === 'nowpayments';

  if (checkoutMode) {
    return (
      <div className="stack pg-checkout">
        <CheckoutSteps step={2} />
        <div className="pg-split">
          <CryptoCheckout base={`/orders/${order.id}`} amountCents={order.charged_cents ?? order.amount_cents} currency={order.currency} onPaid={load} />
          <aside className="card pg-summary">
            <p className="pg-label">{t('checkout.yourOrder')}</p>
            <div className="flex items-center gap-3">
              <div className="min-w-0">
                <b className="block">{order.offer_title}{order.quantity > 1 ? ` ×${order.quantity}` : ''}{order.character_name ? <> → <span className="num" data-testid="order-character">{order.character_name}</span></> : null}</b>
                <span className="small muted">{order.game} · {order.seller_name}</span>
              </div>
            </div>
            <div className="pg-rows">
              <div><span className="muted">{t('checkout.price')}</span><span className="num">{money(order.amount_cents, order.currency)}</span></div>
              {(order.credit_cents ?? 0) > 0 && <div><span className="muted">{t('checkout.fromBalance')}</span><span className="num" data-testid="from-balance">−{money(order.credit_cents!, order.currency)}</span></div>}
              <div className="pg-total"><span>{t('checkout.toPay')}</span><span className="pg-price">{money(order.charged_cents ?? order.amount_cents, order.currency)}</span></div>
            </div>
            <span className="small muted num" data-testid="order-ref">{order.ref ?? t('order.ref', { id: order.id.slice(0, 8) })}</span>
            {order.tos_version && (
              <p className="small muted" style={{ margin: 0 }} data-testid="order-terms">
                <Link to={`/terms/versions/${encodeURIComponent(order.tos_version)}`} target="_blank" rel="noopener">
                  {t('legal.acceptedOn', { version: order.tos_version, date: new Date(order.tos_accepted_at ?? order.created_at).toLocaleDateString() })}
                </Link>
              </p>
            )}
            <div className="bp-box"><BuyerProtection /></div>
          </aside>
        </div>
      </div>
    );
  }

  const closedAt = order.status === 'completed' ? at('completed') : ['refunded', 'cancelled', 'charged_back'].includes(order.status) ? order.events.at(-1)?.created_at : null;
  const pairs = attributePairs(order.game, order.category_slug ?? '', order.attributes ?? {});
  return (
    <div className="stack pg-order">
      {error && <div className="alert" role="alert">{error}</div>}
      {handoverResult && (
        <div className={handoverResult === 'ok' ? 'notice' : 'alert'} role="status">
          {HANDOVER_MESSAGES[handoverResult] ?? HANDOVER_MESSAGES.link_failed}{' '}
          <button className="btn ghost small" onClick={() => setParams({}, { replace: true })}>{t('order.dismiss')}</button>
        </div>
      )}

      <div className="order-layout pg-order-layout" style={{ marginTop: 0 }}>
        <div className="stack">
          {order.status === 'awaiting_payment' && isBuyer && order.rail === 'crypto' && <CryptoDeposit orderId={order.id} />}
          <section className="card od" aria-labelledby="od-title">
            <div className="od-head">
              <h1 id="od-title" className="od-ref num" data-testid="order-ref">{order.ref ?? t('order.ref', { id: order.id.slice(0, 8) })}</h1>
              <span className={`od-status ${variant}`}>{statusText(order.status)}</span>
              {order.status === 'delivered' && <span className="small muted">{clock}</span>}
            </div>
            <ol className="od-line" aria-label={t('order.progress')}>
              {steps.map((st) => (
                <li key={st.label} className={st.state} aria-current={st.state === 'now' ? 'step' : undefined}>
                  <i aria-hidden /><span>{st.label}</span>
                </li>
              ))}
            </ol>
            <dl className="od-grid">
              <div><dt>{t('od.game')}</dt><dd>{order.game}</dd></div>
              <div><dt>{t('od.item')}</dt><dd dir="auto"><Link to={`/offers/${order.offer_id}`}>{order.offer_title}</Link></dd></div>
              {pairs.map(([label, v]) => <div key={label}><dt>{label}</dt><dd>{v}</dd></div>)}
              <div><dt>{t('od.quantity')}</dt><dd className="num">{order.quantity}</dd></div>
              {order.character_name && (
                <div><dt>{currentLocale() === 'en' ? order.handover_field?.label ?? t('order.character') : t('order.character')}</dt><dd data-testid="order-character"><b className="num">{order.character_name}</b></dd></div>
              )}
              <div><dt>{isSeller ? t('od.buyer') : t('od.seller')}</dt><dd>{isSeller ? order.buyer_name : <Link to={`/sellers/${order.seller_id}`}>{order.seller_name}</Link>}</dd></div>
              <div><dt>{t('od.opened')}</dt><dd>{hm(at('awaiting_payment') ?? order.events[0]?.created_at)}</dd></div>
              <div><dt>{closedAt ? t('od.closed') : t('od.delivered')}</dt><dd>{hm(closedAt ?? order.delivered_at) || '—'}</dd></div>
            </dl>
            <div className="od-total">
              <span className="pg-label">{isSeller ? t('od.youEarn') : t('od.total')}</span>
              <span className="od-amount num">{money(isSeller ? order.seller_net_cents : order.amount_cents, order.currency)}</span>
              {isBuyer && order.status !== 'awaiting_payment' && (
                <span className="small muted">{t('order.paidVia', { amount: money(order.amount_cents, order.currency), method: order.rail === 'crypto' ? t('order.rail.onchain') : order.payment_provider === 'nowpayments' ? t('order.rail.crypto') : t('order.rail.card') })}</span>
              )}
              {order.escrow_frozen && order.status !== 'disputed' && <span className="small muted">{t('order.frozenNote')}</span>}
            </div>
            {(isBuyer && order.status === 'delivered' && order.rail === 'fiat') || ((isBuyer || isSeller) && ['paid', 'delivered'].includes(order.status) && order.rail === 'fiat') ? (
              <div className="od-actions">
                <span className="pg-label">{t('od.actions')}</span>
                {isBuyer && order.status === 'delivered' && order.rail === 'fiat' && (
                  <>
                    {!checklistDone && handoverVerified && (
                      <label className="small check-row">
                        <input type="checkbox" checked={handoverConsent} onChange={(e) => setHandoverConsent(e.target.checked)} />
                        {t('order.releaseEarly')}
                      </label>
                    )}
                    <button className="btn release" disabled={!canConfirm} onClick={() => act('confirm', handoverConsent ? { handoverConsent: true } : undefined)}>{t('order.confirmRelease')}</button>
                    {!checklistDone && !handoverVerified && <p className="small muted" style={{ margin: 0 }}>{t('order.finishFirst')}</p>}
                    <p className="small muted" style={{ margin: 0 }}>{t('order.working.text')}</p>
                  </>
                )}
                {isBuyer && order.status === 'paid' && order.rail === 'fiat' && !order.escrow_frozen && <EarlyConfirm onYes={() => act('confirm')} />}
                <div className="od-links">
                  <button type="button" className="pg-wrong" onClick={openDispute}>{t('order.somethingWrong')}</button>
                  <Link className="small muted" to={`/support/new?category=order&order=${order.id}`}>{t('order.getHelp')}</Link>
                </div>
              </div>
            ) : (
              <div className="od-links"><Link className="small muted" to={`/support/new?category=order&order=${order.id}`}>{t('order.getHelp')}</Link></div>
            )}
          </section>
          {order.delivery_proof && (
            <div className="card">
              <DeliveryProof proof={order.delivery_proof} />
            </div>
          )}
          {isBuyer && order.crypto_refund && <RefundAddressForm orderId={order.id} refund={order.crypto_refund} coins={REFUND_COINS} onDone={load} />}
          {isSeller && order.status === 'delivered' && untilConfirmed && (
            <div className="card stack">
              <h3>{t('order.waitingBuyer')}</h3>
              <p className="small muted" style={{ margin: 0 }}>
                {t('order.waitingBuyer.text')}
              </p>
              {followUp ? <p className="small" role="status">{followUp}</p> : canFollowUp && <button className="btn ghost" type="button" onClick={askRelease}>{t('order.askRelease')}</button>}
            </div>
          )}

          {items.length > 0 && (
            <div className="card stack">
              <h3>{t('order.yourDelivery')}</h3>
              {items.map((i) => (
                <div key={i.id} className="secret">{i.content}</div>
              ))}
              <p className="small muted">{t('order.onlyYou')}</p>
            </div>
          )}

          {isBuyer && order.checklist && order.status === 'delivered' && (
            <div className="card stack checklist">
              <h3>{t('order.changeover')}</h3>
              <p className="small muted">{t('order.changeover.text')}</p>
              <div>
                {order.checklist.items.map((i) => (
                  <label key={i.key}>
                    <input type="checkbox" checked={i.done} disabled={!!i.auto} aria-label={i.auto ? t('order.checkAuto', { label: i.label }) : undefined} onChange={(e) => act('checklist', { key: i.key, done: e.target.checked })} />
                    <span>{i.label}</span>
                  </label>
                ))}
              </div>
              {order.checklist.handover_platform && (
                <div className="stack" style={{ gap: 6 }}>
                  {handoverVerified ? (
                    <p className="small muted">{t('order.handover.confirmed', { platform: platformName })}</p>
                  ) : (
                    <>
                      <p className="small muted">{t('order.handover.explain', { platform: platformName })}</p>
                      <button type="button" className="btn" onClick={startHandover}>{t('order.handover.signIn', { platform: platformName })}</button>
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
              <h3>{t('order.deliver')}</h3>
              {order.character_name && (
                <p className="small" style={{ margin: 0 }}>
                  {t('order.deliverTo', { name: '\u0000', label: order.handover_field?.label ?? t('order.characterLower') }).split('\u0000')[0]}
                  <b className="mono">{order.character_name}</b>
                  {t('order.deliverTo', { name: '\u0000', label: order.handover_field?.label ?? t('order.characterLower') }).split('\u0000')[1]}
                </p>
              )}
              <label className="field">
                {t('order.deliveryDetails')}
                <textarea value={payload} onChange={(e) => setPayload(e.target.value)} placeholder={order.proof_required ? t('order.tradeNotes') : t('order.payloadHint')} />
              </label>
              {order.proof_required && (
                <label className="field">
                  {t('order.proofLabel')}
                  <input type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/webm" required onChange={(e) => setProofFile(e.target.files?.[0] ?? null)} aria-describedby="proof-hint" />
                  <span id="proof-hint" className="small muted">{t('order.proofHint')}</span>
                </label>
              )}
              <button
                className="btn release"
                disabled={order.escrow_frozen || delivering || (order.proof_required && !proofFile)}
                onClick={async () => {
                  setDelivering(true);
                  setError('');
                  try {
                    const proof = proofFile ? await apiUpload<{ id: string }>(`/chat/rooms/${order.room_id}/attachments`, proofFile) : null;
                    await api(`/orders/${order.id}/deliver`, { body: { payload: payload || undefined, ...(proof ? { proofAttachmentId: proof.id } : {}) } });
                    setProofFile(null);
                    await load();
                  } catch (e: any) {
                    setError(e.message);
                  } finally {
                    setDelivering(false);
                  }
                }}
              >
                {delivering ? t('order.delivering') : t('order.markDelivered')}
              </button>
            </div>
          )}
          {(isBuyer || isSeller) && ['paid', 'delivered'].includes(order.status) && order.rail === 'fiat' && (
            <details className="card" id="order-dispute">
              <summary style={{ cursor: 'pointer' }}><b>{t('order.openDispute')}</b></summary>
              <div className="stack" style={{ marginTop: 12 }}>
                <p className="small muted">{t('order.dispute.text')}</p>
                <label className="field">
                  {t('order.dispute.problem')}
                  <select value={category} onChange={(e) => setCategory(e.target.value)}>
                    {DISPUTE_CATEGORIES.map((k) => <option key={k} value={k}>{disputeCategory(k)}</option>)}
                  </select>
                </label>
                <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('order.dispute.placeholder')} />
                <button className="btn dispute" disabled={reason.trim().length < 10} onClick={() => act('dispute', { reason, category })}>{t('order.dispute.open')}</button>
              </div>
            </details>
          )}

          {isBuyer && order.status === 'completed' && !order.review && <ReviewForm orderId={order.id} onDone={load} />}
          <WarrantyCard order={order} isBuyer={isBuyer} isSeller={isSeller} onDone={load} />
          {order.review && (
            <div className="card stack">
              <h3>{t('order.review')}</h3>
              <p><span className="mono">{'★'.repeat(order.review.rating)}{'☆'.repeat(5 - order.review.rating)}</span> {order.review.comment}</p>
              {order.review.seller_reply && <p className="small muted">{t('order.sellerReplied', { reply: order.review.seller_reply })}</p>}
            </div>
          )}

          {order.dispute && (
            <div className="card stack">
              <div className="row spread">
                <h3 style={{ margin: 0 }}>{t('order.dispute')}</h3>
                <span className={`chip ${order.dispute.status === 'open' ? 'disputed' : 'released'}`}>{order.dispute.status.replace('_', ' ')}</span>
              </div>
              {order.dispute.category && <div className="small muted">{disputeCategory(order.dispute.category)}</div>}
              {(order.dispute.statements ?? []).map((s) => (
                <div key={s.id} className="small" style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--rule)', background: s.role === 'buyer' ? 'var(--paper)' : 'var(--held-soft)' }}>
                  <b>{s.role === 'buyer' ? t('order.statement.buyer') : t('order.statement.seller')}</b> <span className="muted">· {s.author_name} · {new Date(s.created_at).toLocaleString()}</span>
                  <div style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{s.body}</div>
                </div>
              ))}
              {order.dispute.status === 'open' && (isBuyer || isSeller) && (
                <div className="stack" style={{ gap: 8 }}>
                  <textarea value={statement} onChange={(e) => setStatement(e.target.value)} placeholder={t('order.statement.placeholder')} />
                  <button className="btn ghost" disabled={statement.trim().length < 10} onClick={async () => (await act('dispute/statements', { body: statement }), setStatement(''))}>{t('order.statement.add')}</button>
                </div>
              )}
            </div>
          )}

          <Link to="/orders" className="small">{t('order.allOrders')}</Link>
        </div>
        <Chat roomId={order.room_id} meId={user.id} names={names} accountOrder={order.category_kind === 'account'} />
      </div>
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
      <h3>{t('order.crypto.title')}</h3>
      <p className="muted small">
        {t('order.crypto.text', { call: '\u0000' }).split('\u0000')[0]}
        <span className="mono">createEscrow(terms, signature)</span>
        {t('order.crypto.text', { call: '\u0000' }).split('\u0000')[1]}
      </p>
      <div className="row">
        <input className="mono" placeholder={t('order.crypto.wallet')} value={wallet} onChange={(e) => setWallet(e.target.value.trim())} style={{ flex: 1 }} />
        <button className="btn ghost" disabled={!/^0x[0-9a-fA-F]{40}$/.test(wallet)} onClick={fetchTerms}>{t('order.crypto.terms')}</button>
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
      <h3>{t('order.rate')}</h3>
      <div className="row" role="radiogroup" aria-label={t('order.rating')}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" className={`btn ghost rate-star${n <= rating ? ' on' : ''}`} aria-checked={n === rating} aria-label={`${n}★`} role="radio" onClick={() => setRating(n)}>
            {n}★
          </button>
        ))}
      </div>
      <textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t('order.reviewHint')} maxLength={1000} style={{ minHeight: 70 }} />
      {error && <div className="alert" role="alert">{error}</div>}
      <button className="btn" onClick={submit}>{t('order.postReview')}</button>
    </div>
  );
}

/** The buyer can confirm before the seller marks it delivered; a short pop-up makes sure they mean it. */
function EarlyConfirm({ onYes }: { onYes: () => Promise<void> }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const yes = async () => {
    setBusy(true);
    await onYes();
    setBusy(false);
    ref.current?.close();
  };
  return (
    <>
      <button type="button" className="btn release" onClick={() => ref.current?.showModal()}>{t('order.gotIt')}</button>
      <dialog ref={ref} className="bz-dialog" aria-labelledby="ec-title">
        <h2 id="ec-title">{t('order.gotIt.title')}</h2>
        <p>{t('order.gotIt.text')}</p>
        <div className="bz-dialog-actions">
          <button type="button" className="btn ghost" onClick={() => ref.current?.close()}>{t('order.gotIt.no')}</button>
          <button type="button" className="btn release" disabled={busy} onClick={yes}>{t('order.gotIt.yes')}</button>
        </div>
      </dialog>
    </>
  );
}
