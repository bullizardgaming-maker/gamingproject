import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { api, money } from '../api';
import { useSession } from '../session';
import { usePageMeta } from '@/lib/seo';
import { t, type MessageKey } from '../i18n';

interface Entry {
  id: string;
  at: string;
  kind: 'order' | 'refund' | 'sale' | 'withdrawal';
  ref: string;
  order_id?: string;
  title?: string;
  address?: string;
  coin?: string;
  status: 'held' | 'completed' | 'cancelled' | 'pending';
  amount_cents: number;
  currency: string;
}
interface WalletData { balances: Record<string, number>; credit_cents: number; entries: Entry[] }

const STATUS_CLS: Record<Entry['status'], string> = { held: 'held', completed: 'released', cancelled: 'disputed', pending: '' };
const FEE_BPS = 600;
const FEE_MIN = 150;

/** Balance and every money movement in one list (FunPay-style). Sellers see their sales here too. */
export function WalletPage() {
  const { user, loading } = useSession();
  const [data, setData] = useState<WalletData | null>(null);
  const [kind, setKind] = useState<'' | Entry['kind']>('');
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  usePageMeta({ title: t('wallet.title') });
  const load = () => void api<WalletData>('/me/wallet').then(setData).catch((e) => setError(e.message));
  useEffect(() => { if (user) load(); }, [user]);
  const kinds = useMemo(() => [...new Set((data?.entries ?? []).map((e) => e.kind))], [data]);

  if (!user && !loading) return <Navigate to="/login?next=/wallet" replace />;
  if (!data) return <p className="muted">{error || t('wallet.loading')}</p>;
  const balance = data.balances.USD ?? 0;
  const isSeller = kinds.includes('sale');
  const shown = data.entries.filter((e) => !kind || e.kind === kind);

  return (
    <div className="stack wl">
      <div className="wl-head">
        <h1 className="pg-h1">{t('wallet.balance')} <span className="num wl-amount">{money(balance, 'USD')}</span></h1>
        {data.credit_cents > 0 && !open && <button type="button" className="btn" onClick={() => setOpen(true)}>{t('wallet.withdraw')}</button>}
        {isSeller && <Link className="btn ghost" to="/sell/money">{t('wallet.sellerMoney')}</Link>}
      </div>
      <p className="small muted" style={{ margin: 0 }}>{t('wallet.notice')}</p>
      {open && <WithdrawBox max={data.credit_cents} onDone={() => (setOpen(false), load())} onCancel={() => setOpen(false)} />}

      <div className="wl-bar">
        <div className="pg-seg" role="group" aria-label={t('wallet.filter')}>
          <button type="button" aria-pressed={!kind} onClick={() => setKind('')}>{t('wallet.kind.all')}</button>
          {kinds.map((k) => <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>{t(`wallet.kind.${k}` as MessageKey)}</button>)}
        </div>
      </div>

      {shown.length === 0 ? (
        <div className="card muted">{t('wallet.empty')}</div>
      ) : (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="data wl-table" aria-label={t('wallet.history')}>
            <thead>
              <tr><th>{t('wallet.col.date')}</th><th>{t('wallet.col.what')}</th><th>{t('wallet.col.status')}</th><th className="num" style={{ textAlign: 'end' }}>{t('wallet.col.amount')}</th></tr>
            </thead>
            <tbody>
              {shown.map((e) => (
                <tr key={e.id}>
                  <td className="small muted num" style={{ whiteSpace: 'nowrap' }}>{new Date(e.at).toLocaleDateString([], { day: 'numeric', month: 'short' })}, {new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
                  <td>
                    <b className="block">{e.kind === 'withdrawal' ? t('wallet.withdrawal') : e.order_id ? <Link to={`/orders/${e.order_id}`}>{t(`wallet.kind1.${e.kind}` as MessageKey, { ref: e.ref })}</Link> : e.ref}</b>
                    <span className="wl-date-m num">{new Date(e.at).toLocaleDateString([], { day: 'numeric', month: 'short' })}</span>
                    <span className="small muted wl-sub" dir="auto">{e.kind === 'withdrawal' ? `${e.coin?.toUpperCase() ?? ''} ${e.address ?? ''}` : e.title}</span>
                  </td>
                  <td><span className={`chip ${STATUS_CLS[e.status]}`}>{t(`wallet.st.${e.status}` as MessageKey)}</span></td>
                  <td className={`num wl-amt${e.amount_cents > 0 ? ' plus' : ''}`}>{e.amount_cents > 0 ? '+' : '−'}{money(Math.abs(e.amount_cents), e.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function WithdrawBox({ max, onDone, onCancel }: { max: number; onDone: () => void; onCancel: () => void }) {
  const [amount, setAmount] = useState((max / 100).toFixed(2));
  const [address, setAddress] = useState('');
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const cents = Math.round(Number(amount) * 100) || 0;
  const fee = cents ? Math.min(cents, Math.max(FEE_MIN, Math.ceil((cents * FEE_BPS) / 10_000))) : 0;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/me/withdrawals', { body: { amountCents: cents, address: address.trim(), coin: 'usdttrc20' } });
      onDone();
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <form className="card wl-withdraw" onSubmit={submit} aria-label={t('wallet.withdraw')}>
      <label className="field"><span>{t('wallet.address')}</span><input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="T…" required autoComplete="off" spellCheck={false} /></label>
      <label className="field"><span>{t('wallet.amountUsd', { max: money(max, 'USD') })}</span><input className="num" type="number" step="0.01" min="0.01" max={max / 100} value={amount} onChange={(e) => setAmount(e.target.value)} required /></label>
      <div className="wl-fee small num">
        <span>{t('wallet.fee', { pct: FEE_BPS / 100, min: money(FEE_MIN, 'USD') })}</span><span>{money(fee, 'USD')}</span>
        <b>{t('wallet.youReceive')}</b><b>{money(Math.max(0, cents - fee), 'USD')}</b>
      </div>
      <label className="check-row small"><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} /> {t('wallet.checked')}</label>
      {error && <div className="alert small" role="alert">{error}</div>}
      <div className="row" style={{ gap: 8 }}>
        <button className="btn" disabled={!ok || busy || cents <= fee || cents > max}>{t('wallet.withdraw')}</button>
        <button type="button" className="btn ghost" onClick={onCancel}>{t('wallet.cancel')}</button>
      </div>
    </form>
  );
}
