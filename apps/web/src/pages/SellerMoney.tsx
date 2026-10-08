import { useCallback, useEffect, useState } from 'react';
import { Download, FileText, Lock, ReceiptText } from 'lucide-react';
import { api, download, money } from '../api';
import { useSession } from '../session';
import { cn } from '@/lib/utils';

interface Hold {
  level: string;
  holdDays: number;
  currency: string;
  availableCents: number;
  heldCents: number;
  withdrawableCents: number;
  upcoming: Array<{ unlocksAt: string; cents: number }>;
}
interface TaxProfile {
  country: string | null;
  isBusiness: boolean;
  taxId: string | null;
  taxIdVerified: boolean;
  billingAddress: string | null;
  commissionTax: { country: string; treatment: 'standard' | 'reverse_charge' | 'outside_scope'; rateBps: number; note?: string };
}

const CURRENCIES = ['USD', 'EUR', 'GBP'];
const HOLD_LABEL: Record<string, string> = {
  new: 'New seller',
  established: 'Established seller',
  trusted: 'Trusted seller',
  watch: 'Under review after chargebacks',
  custom: 'Set by our team',
};
const COUNTRIES: Array<[string, string]> = [
  ['AT', 'Austria'], ['BE', 'Belgium'], ['BG', 'Bulgaria'], ['HR', 'Croatia'], ['CY', 'Cyprus'], ['CZ', 'Czechia'], ['DK', 'Denmark'],
  ['EE', 'Estonia'], ['FI', 'Finland'], ['FR', 'France'], ['DE', 'Germany'], ['GR', 'Greece'], ['HU', 'Hungary'], ['IE', 'Ireland'],
  ['IT', 'Italy'], ['LV', 'Latvia'], ['LT', 'Lithuania'], ['LU', 'Luxembourg'], ['MT', 'Malta'], ['NL', 'Netherlands'], ['PL', 'Poland'],
  ['PT', 'Portugal'], ['RO', 'Romania'], ['SK', 'Slovakia'], ['SI', 'Slovenia'], ['ES', 'Spain'], ['SE', 'Sweden'],
  ['GB', 'United Kingdom'], ['NO', 'Norway'], ['CH', 'Switzerland'], ['US', 'United States'], ['CA', 'Canada'], ['AU', 'Australia'],
  ['NZ', 'New Zealand'], ['BR', 'Brazil'], ['MX', 'Mexico'], ['TR', 'Türkiye'], ['AE', 'United Arab Emirates'], ['SA', 'Saudi Arabia'],
  ['EG', 'Egypt'], ['IN', 'India'], ['JP', 'Japan'], ['KR', 'South Korea'], ['SG', 'Singapore'], ['PH', 'Philippines'], ['ZA', 'South Africa'],
];
const TREATMENT_TEXT = {
  standard: (rate: number, c: string) => `Our commission includes ${(rate / 100).toFixed(2)}% VAT for ${c}. Your payouts don't change.`,
  reverse_charge: () => 'Reverse charge: we don’t add VAT to our commission; you account for it in your own VAT return.',
  outside_scope: () => 'Outside the scope of our VAT: no tax is added to our commission.',
};

const first = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
};
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const fmtDate = (d: string) => new Date(d).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });

export function SellerMoney() {
  const { user } = useSession();
  const [dash, setDash] = useState<any>(null);
  const [hold, setHold] = useState<Hold | null>(null);
  const [tax, setTax] = useState<TaxProfile | null>(null);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [credits, setCredits] = useState<any[]>([]);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'alert'; text: string } | null>(null);

  const load = useCallback(async () => {
    const [d, h, t, inv, cn] = await Promise.all([
      api('/seller/dashboard'),
      api<Hold>('/seller/payout-hold'),
      api<TaxProfile>('/seller/tax-profile'),
      api<any[]>('/seller/invoices'),
      api<any[]>('/seller/credit-notes'),
    ]);
    setDash(d);
    setHold(h);
    setTax(t);
    setInvoices(inv);
    setCredits(cn);
  }, []);
  useEffect(() => {
    load().catch((e) => setMsg({ kind: 'alert', text: e.message }));
  }, [load]);

  if (!dash || !hold || !tax) return <p className="muted">{msg?.text ?? 'Loading your money…'}</p>;
  const currency: string = dash.payoutCurrency ?? 'USD';
  const others = (dash.allBalances ?? []).filter((b: any) => b.currency !== currency);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg({ kind: 'ok', text: ok });
      await load();
    } catch (e: any) {
      setMsg({ kind: 'alert', text: e.message });
    }
  };

  return (
    <div className="stack">
      {msg && <div className={msg.kind}>{msg.text}</div>}
      {(dash.debts ?? []).map((d: any) => (
        <DebtCard key={d.id} debt={d} onError={(text) => setMsg({ kind: 'alert', text })} />
      ))}

      <div className="grid gap-4 md:grid-cols-[1.3fr_1fr]">
        {/* Balance & payouts */}
        <div className="card stack">
          <div className="row spread">
            <div className="eyebrow" style={{ marginBottom: 0 }}>Balance</div>
            <label className="row small" style={{ gap: 8 }}>
              Paid out in
              <select
                aria-label="Payout currency"
                value={currency}
                style={{ width: 90 }}
                onChange={(e) => run(() => api('/seller/payout-currency', { method: 'PUT', body: { currency: e.target.value } }), `New sales will be credited and paid out in ${e.target.value}.`)}
              >
                {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
              </select>
            </label>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Withdraw now" value={money(hold.withdrawableCents, currency)} tone="released" />
            <Stat label="On hold" value={money(hold.heldCents, currency)} tone="held" icon={<Lock className="size-3.5" />} />
            <Stat label="In escrow" value={money(dash.balances.pendingEscrowCents, 'USD')} />
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            {hold.holdDays > 0
              ? `${HOLD_LABEL[hold.level] ?? hold.level}: money from a completed sale can be withdrawn ${hold.holdDays} day${hold.holdDays === 1 ? '' : 's'} after release. The hold gets shorter as you build a track record.`
              : 'No payout hold: completed sales can be withdrawn straight away.'}
          </p>
          {hold.upcoming.length > 0 && (
            <div className="small">
              {hold.upcoming.slice(0, 4).map((u) => (
                <div key={u.unlocksAt} className="row spread" style={{ borderTop: '1px solid var(--rule)', padding: '6px 0' }}>
                  <span className="muted">Unlocks {fmtDate(u.unlocksAt)}</span>
                  <span className="mono">{money(u.cents, currency)}</span>
                </div>
              ))}
            </div>
          )}
          <Withdraw
            currency={currency}
            max={hold.withdrawableCents}
            disabled={!user?.payouts_enabled || dash.withdrawalsFrozen}
            onWithdraw={(cents) => run(() => api('/seller/withdrawals', { body: { amountCents: cents, currency } }), `${money(cents, currency)} is on its way to your bank.`)}
          />
          {!user?.payouts_enabled && <p className="small muted" style={{ margin: 0 }}>Set up payouts on the Shop tab first.</p>}
          {dash.withdrawalsFrozen && <p className="small muted" style={{ margin: 0 }}>Withdrawals are paused while a routine review runs.</p>}
          {others.map((b: any) => (
            <div key={b.currency} className="notice row spread">
              <span>You also hold <b className="mono">{money(b.cents, b.currency)}</b> from earlier sales.</span>
              {b.cents > 0 && (
                <button className="btn ghost" disabled={!user?.payouts_enabled} onClick={() => run(() => api('/seller/withdrawals', { body: { amountCents: b.cents, currency: b.currency } }), `${money(b.cents, b.currency)} is on its way.`)}>
                  Withdraw
                </button>
              )}
            </div>
          ))}
        </div>

        {/* Tax profile */}
        <TaxForm tax={tax} onSaved={(t) => (setTax(t), setMsg({ kind: 'ok', text: 'Tax details saved.' }))} onError={(text) => setMsg({ kind: 'alert', text })} />
      </div>

      {/* Invoices & credit notes */}
      <div className="card stack">
        <div className="row spread">
          <h3 style={{ margin: 0 }} className="inline-flex items-center gap-2"><ReceiptText className="size-5" strokeWidth={1.8} /> Commission invoices</h3>
          <span className="small muted">Issued on the 1st of each month for the previous month</span>
        </div>
        {invoices.length === 0 ? (
          <p className="muted small" style={{ margin: 0 }}>No invoices yet. Your first one arrives after a month with completed sales.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Number</th><th>Period</th><th>Commission</th><th>of which tax</th><th /></tr></thead>
              <tbody>
                {invoices.map((i) => (
                  <tr key={i.id}>
                    <td className="mono">{i.number}</td>
                    <td className="small">{fmtDate(i.period_start)}</td>
                    <td className="mono">{money(Number(i.gross_cents), i.currency)}</td>
                    <td className="mono muted">{money(Number(i.tax_cents), i.currency)}</td>
                    <td><button className="btn ghost" onClick={() => download(`/seller/invoices/${i.id}/pdf`, `${i.number}.pdf`)}><FileText className="size-4" /> PDF</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {credits.length > 0 && (
          <>
            <h4 style={{ margin: '8px 0 0' }}>Credit notes</h4>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Number</th><th>Issued</th><th>Commission returned</th><th>Reason</th></tr></thead>
                <tbody>
                  {credits.map((c) => (
                    <tr key={c.id}>
                      <td className="mono">{c.number}</td>
                      <td className="small">{fmtDate(c.issued_at)}</td>
                      <td className="mono">{money(Number(c.gross_cents), c.currency)}</td>
                      <td className="small muted">{c.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <Exports />
    </div>
  );
}

/** A negative balance after a refund or chargeback: what's owed, when the shop pauses, and pay now. */
function DebtCard({ debt, onError }: { debt: { id: string; currency: string; owedCents: number; pausesAt: string | null; shopPausedAt: string | null }; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const pay = async () => {
    setBusy(true);
    try {
      const r = await api<{ checkoutUrl: string }>(`/seller/debts/${debt.id}/pay`, { body: {} });
      window.location.assign(r.checkoutUrl);
    } catch (e: any) {
      onError(e.message);
      setBusy(false);
    }
  };
  return (
    <div className="card stack" style={{ borderColor: 'var(--disputed)' }}>
      <div className="row spread">
        <div>
          <div className="eyebrow" style={{ marginBottom: 4, color: 'var(--disputed)' }}>Balance below zero</div>
          <div className="font-mono text-2xl font-semibold">−{money(debt.owedCents, debt.currency)}</div>
        </div>
        <button className="btn" disabled={busy} onClick={pay}>{busy ? 'Opening checkout…' : `Pay ${money(debt.owedCents, debt.currency)} now`}</button>
      </div>
      <p className="small" style={{ margin: 0 }}>
        A refund or chargeback took more than your balance held. New sales pay it down automatically; withdrawals are paused until it’s settled.{' '}
        {debt.shopPausedAt
          ? 'Your shop is paused and reopens as soon as this is paid.'
          : debt.pausesAt
            ? `If it’s still unpaid on ${fmtDate(debt.pausesAt)}, your shop will be paused.`
            : ''}
      </p>
    </div>
  );
}

function Stat({ label, value, tone, icon }: { label: string; value: string; tone?: 'released' | 'held'; icon?: React.ReactNode }) {
  return (
    <div className={cn('rounded-lg border border-border p-3', tone === 'released' && 'border-released/40 bg-released/5', tone === 'held' && 'border-held/40 bg-held/5')}>
      <div className="inline-flex items-center gap-1 text-xs uppercase tracking-wide text-muted-foreground">{icon}{label}</div>
      <div className="mt-1 font-mono text-lg font-semibold">{value}</div>
    </div>
  );
}

function Withdraw({ currency, max, disabled, onWithdraw }: { currency: string; max: number; disabled: boolean; onWithdraw: (cents: number) => void }) {
  const [amount, setAmount] = useState('');
  const cents = amount ? Math.round(Number(amount) * 100) : max;
  return (
    <div className="row">
      <input
        type="number"
        min={0}
        step="0.01"
        aria-label={`Amount in ${currency}`}
        placeholder={`${(max / 100).toFixed(2)} (all)`}
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        style={{ maxWidth: 170 }}
      />
      <button className="btn" disabled={disabled || cents <= 0 || cents > max} onClick={() => (onWithdraw(cents), setAmount(''))}>
        Withdraw {money(cents, currency)}
      </button>
    </div>
  );
}

function TaxForm({ tax, onSaved, onError }: { tax: TaxProfile; onSaved: (t: TaxProfile) => void; onError: (m: string) => void }) {
  const [business, setBusiness] = useState(tax.isBusiness);
  const [saving, setSaving] = useState(false);
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setSaving(true);
    try {
      onSaved(await api<TaxProfile>('/seller/tax-profile', { method: 'PUT', body: { country: f.country, isBusiness: business, taxId: business ? f.taxId || null : null, billingAddress: f.billingAddress || null } }));
    } catch (err: any) {
      onError(err.message);
    } finally {
      setSaving(false);
    }
  };
  const t = tax.commissionTax;
  return (
    <form className="card stack" onSubmit={submit}>
      <div className="eyebrow" style={{ marginBottom: 0 }}>Tax details</div>
      <p className="small muted" style={{ margin: 0 }}>Used for VAT/GST on our commission and printed on your invoices.</p>
      <label className="field">
        Country
        <select name="country" defaultValue={tax.country ?? ''} required>
          <option value="" disabled>Choose…</option>
          {COUNTRIES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
        </select>
      </label>
      <label className="row small">
        <input type="checkbox" style={{ width: 'auto' }} checked={business} onChange={(e) => setBusiness(e.target.checked)} />
        I sell as a registered business
      </label>
      {business && (
        <label className="field">
          VAT / GST number
          <input name="taxId" className="mono" defaultValue={tax.taxId ?? ''} placeholder="e.g. DE123456789" />
          {tax.taxId && <span className={cn('small', tax.taxIdVerified ? 'text-released' : 'text-muted-foreground')}>{tax.taxIdVerified ? 'Verified with VIES' : 'Not verified yet'}</span>}
        </label>
      )}
      <label className="field">Billing address<textarea name="billingAddress" defaultValue={tax.billingAddress ?? ''} style={{ minHeight: 60 }} /></label>
      <div className="notice small">{TREATMENT_TEXT[t.treatment](t.rateBps, t.country)}</div>
      <button className="btn" disabled={saving} style={{ alignSelf: 'flex-start' }}>{saving ? 'Saving…' : 'Save tax details'}</button>
    </form>
  );
}

const EXPORTS: Array<[string, string, string]> = [
  ['sales', 'Sales', 'Every order with commission, tax and what you were credited'],
  ['statement', 'Balance statement', 'Opening, every movement, closing balance'],
  ['payouts', 'Payouts', 'Withdrawals to your bank'],
  ['invoices', 'Invoices', 'Commission invoices issued'],
  ['credit_notes', 'Credit notes', 'Commission returned on refunds'],
];

function Exports() {
  const [from, setFrom] = useState(first());
  const [to, setTo] = useState(tomorrow());
  const [error, setError] = useState('');
  return (
    <div className="card stack">
      <div className="row spread">
        <h3 style={{ margin: 0 }} className="inline-flex items-center gap-2"><Download className="size-5" strokeWidth={1.8} /> Accounting exports</h3>
        <div className="row small">
          <label className="row" style={{ gap: 6 }}>From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 150 }} /></label>
          <label className="row" style={{ gap: 6 }}>To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 150 }} /></label>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {EXPORTS.map(([kind, label, hint]) => (
          <button
            key={kind}
            type="button"
            className="card demo-account cursor-pointer text-left"
            onClick={async () => {
              setError('');
              try {
                await download(`/seller/exports/${kind}?from=${from}&to=${to}`, `bullizard-${kind}-${from}-to-${to}.csv`);
              } catch (e: any) {
                setError(e.message);
              }
            }}
          >
            <b className="inline-flex items-center gap-1.5"><Download className="size-4" /> {label}</b>
            <span className="small muted">{hint}</span>
          </button>
        ))}
      </div>
      <p className="small muted" style={{ margin: 0 }}>CSV files open in Excel, Google Sheets and most bookkeeping tools. Amounts are in cents.</p>
      {error && <div className="alert">{error}</div>}
    </div>
  );
}
