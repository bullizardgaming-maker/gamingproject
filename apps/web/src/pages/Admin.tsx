import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, apiBlob, money } from '../api';
import { useSession } from '../session';
import { AmlPanel, StaffPanel, TaxPanel, TreasuryPanel } from './AdminPanels';
import { CurrencyPanel, DebtsPanel, FraudModelPanel, IncidentsPanel, PrivacyPanel } from './OpsPanels';
import { usePageMeta } from '@/lib/seo';
import { currentLocale, t } from '../i18n';
import { BusinessPanel } from './BusinessPanel';
import { SupportPanel } from './SupportPanel';
import { DisputeCase } from './DisputeCase';
import { DISPUTE_CATEGORY } from './OrderPage';
import { ModerationPanel } from './ModerationPanel';
import { WarrantyPanel } from './WarrantyPanel';

type ListTab = 'disputes' | 'risk' | 'proofs' | 'chargebacks' | 'ledger' | 'recon' | 'audit';
type PanelTab = 'business' | 'support' | 'moderation' | 'warranty' | 'aml' | 'treasury' | 'tax' | 'staff' | 'status' | 'debts' | 'currency' | 'model' | 'privacy';
type Tab = ListTab | PanelTab;

/** Each tab is shown to whoever holds its permission (see the API's domain/permissions.ts). */
const TABS: Array<{ id: Tab; label: string; perm: string }> = [
  { id: 'business', label: 'Business', perm: 'analytics.view' },
  { id: 'support', label: 'Support', perm: 'support.manage' },
  { id: 'moderation', label: 'Moderation', perm: 'moderation.manage' },
  { id: 'disputes', label: 'Disputes', perm: 'disputes.manage' },
  { id: 'warranty', label: 'Warranty claims', perm: 'disputes.manage' },
  { id: 'proofs', label: 'Owner proofs', perm: 'owner_proofs.review' },
  { id: 'risk', label: 'Fraud review', perm: 'risk.review' },
  { id: 'model', label: 'Fraud model', perm: 'risk.review' },
  { id: 'aml', label: 'Compliance', perm: 'aml.review' },
  { id: 'chargebacks', label: 'Chargebacks', perm: 'chargebacks.manage' },
  { id: 'treasury', label: 'Treasury', perm: 'treasury.request' },
  { id: 'currency', label: 'Currency', perm: 'fx.manage' },
  { id: 'debts', label: 'Seller debts', perm: 'ledger.view' },
  { id: 'tax', label: 'Tax', perm: 'tax.manage' },
  { id: 'ledger', label: 'Ledger', perm: 'ledger.view' },
  { id: 'recon', label: 'Reconciliation', perm: 'reconciliation.run' },
  { id: 'audit', label: 'Audit log', perm: 'audit.view' },
  { id: 'staff', label: 'Staff', perm: 'staff.manage' },
  { id: 'status', label: 'Status page', perm: 'status.manage' },
  { id: 'privacy', label: 'Privacy', perm: 'retention.manage' },
];
const PANELS: Record<PanelTab, () => React.ReactElement> = {
  business: BusinessPanel, support: SupportPanel, moderation: ModerationPanel, warranty: WarrantyPanel, aml: AmlPanel, treasury: TreasuryPanel, tax: TaxPanel, staff: StaffPanel,
  status: IncidentsPanel, debts: DebtsPanel, currency: CurrencyPanel, model: FraudModelPanel, privacy: PrivacyPanel,
};
const isPanel = (t: Tab): t is PanelTab => t in PANELS;

const fmt = (d: string) => new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function Admin() {
  usePageMeta({ title: 'Operations', noindex: true });
  const { user, can } = useSession();
  const visible = TABS.filter((t) => can(t.perm));
  const [picked, setTab] = useState<Tab | null>(null);
  const tab: Tab = picked && visible.some((t) => t.id === picked) ? picked : (visible[0]?.id ?? 'disputes');
  // Rows are tagged with the tab they were loaded for, so a tab switch never renders
  // one tab's rows with another tab's columns while the new data is loading.
  const [loaded, setLoaded] = useState<{ tab: Tab; rows: any[] } | null>(null);
  const rows = loaded?.tab === tab ? loaded.rows : null;
  const [error, setError] = useState('');
  const [mfaNeeded, setMfaNeeded] = useState(false);

  const path: Record<ListTab, string> = {
    disputes: '/admin/disputes',
    risk: '/admin/risk-flags',
    proofs: '/admin/owner-proofs',
    chargebacks: '/admin/chargebacks',
    ledger: '/admin/ledger/summary',
    recon: '/admin/reconciliation',
    audit: '/admin/audit?limit=200',
  };

  const load = useCallback(async () => {
    if (isPanel(tab)) return;
    setLoaded(null);
    setError('');
    try {
      setLoaded({ tab, rows: await api<any[]>(path[tab]) });
    } catch (e: any) {
      if (e.code === 'mfa_required') setMfaNeeded(true);
      else setError(e.message);
      setLoaded({ tab, rows: [] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  useEffect(() => {
    if (user && visible.length) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, load, visible.length]);

  if (!user || user.role === 'user' || !visible.length) return <div className="card"><h2>Staff only</h2><p className="muted">This area is for the marketplace team.</p></div>;
  if (mfaNeeded) {
    return (
      <div className="notice" style={{ maxWidth: 640 }}>
        Staff tools need a session signed in with two-factor login. <Link to="/account">Turn on two-factor login</Link>, then sign out and back in.
      </div>
    );
  }

  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      await load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const openPdf = async (id: string) => {
    try {
      const url = URL.createObjectURL(await apiBlob(`/admin/chargebacks/${id}/packet.pdf`));
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <div className="stack">
      <h1 style={{ fontSize: 40 }}>Operations</h1>
      {currentLocale() !== 'en' && <p className="small muted" style={{ margin: 0 }} lang={currentLocale()}>{t('common.englishOnly')}</p>}
      <div className="filters" role="tablist" aria-label="Operations sections">
        {visible.map((t) => (
          <button
            key={t.id}
            id={`tab-${t.id}`}
            role="tab"
            aria-selected={tab === t.id}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => {
              // Arrow keys move between tabs (one tab stop for the whole list).
              const i = visible.findIndex((x) => x.id === t.id);
              const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? visible.length - 1 : null;
              if (next == null) return;
              e.preventDefault();
              const target = visible[(next + visible.length) % visible.length]!;
              setTab(target.id);
              document.getElementById(`tab-${target.id}`)?.focus();
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      {error && <div className="alert" role="alert">{error}</div>}
      {isPanel(tab) ? (
        (() => {
          const Panel = PANELS[tab];
          return <Panel key={tab} />;
        })()
      ) : rows === null ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="card"><p className="muted">Nothing waiting here.</p></div>
      ) : tab === 'disputes' ? (
        <div className="stack">
          {rows.map((d) => <DisputeCard key={d.id} d={d} onResolve={(outcome, note) => act(() => api(`/admin/disputes/${d.id}/resolve`, { body: { outcome, note } }))} />)}
        </div>
      ) : tab === 'risk' ? (
        <div className="card table-wrap">
          <table className="data">
            <thead><tr><th>Account</th><th>Score</th><th>Why</th><th /></tr></thead>
            <tbody>
              {rows.map((f) => (
                <tr key={f.id}>
                  <td>{f.display_name}<div className="small muted">{f.email}{f.withdrawals_frozen ? ' · payouts frozen' : ''}</div></td>
                  <td className="mono">{Number(f.score).toFixed(2)}</td>
                  <td className="small">{(f.reasons as any[]).map((r) => r.code.replace(/_/g, ' ')).join(', ')}{f.order_id && <> · <Link to={`/orders/${f.order_id}`}>order</Link></>}</td>
                  <td>
                    <div className="row">
                      <button className="btn ghost" onClick={() => act(() => api(`/admin/risk-flags/${f.id}/review`, { body: { decision: 'clear' } }))}>Clear and unfreeze</button>
                      <button className="btn dispute" onClick={() => confirm(`Suspend ${f.display_name}?`) && act(() => api(`/admin/risk-flags/${f.id}/review`, { body: { decision: 'confirm' } }))}>Confirm fraud</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : tab === 'proofs' ? (
        <div className="card table-wrap">
          <table className="data">
            <thead><tr><th>Listing</th><th>Registration</th><th>Billing name vs verified ID</th><th /></tr></thead>
            <tbody>
              {rows.map((p) => {
                const match = !p.billing_name || !p.seller_legal_name || p.billing_name.trim().toLowerCase() === p.seller_legal_name.trim().toLowerCase();
                return (
                  <tr key={p.id}>
                    <td>
                      {p.title}
                      {p.linked_platform ? (
                        <div className="small">
                          <span className="chip released">{p.linked_platform === 'steam' ? 'Steam' : 'Riot'} sign-in</span>{' '}
                          {p.linked_profile_url ? <a href={p.linked_profile_url} target="_blank" rel="noreferrer noopener">{p.linked_name}</a> : p.linked_name}
                          <span className="muted"> · created {p.linked_account_created_at ? p.linked_account_created_at.slice(0, 10) : 'unknown'} · linked {p.linked_at?.slice(0, 10)}</span>
                        </div>
                      ) : (
                        <div className="small muted">No linked account</div>
                      )}
                    </td>
                    <td className="small">{p.registration_email}<div className="muted">{p.registration_date?.slice(0, 10)}</div></td>
                    <td className="small">{p.billing_name ?? '—'} / {p.seller_legal_name ?? '—'} {!match && <span className="chip disputed">mismatch</span>}</td>
                    <td>
                      <div className="row">
                        <button className="btn release" disabled={!match} onClick={() => act(() => api(`/admin/owner-proofs/${p.id}/review`, { body: { approve: true } }))}>Verify</button>
                        <button className="btn ghost" onClick={() => act(() => api(`/admin/owner-proofs/${p.id}/review`, { body: { approve: false, note: 'Evidence insufficient' } }))}>Reject</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : tab === 'chargebacks' ? (
        <div className="card table-wrap">
          <table className="data">
            <thead><tr><th>Order</th><th>Code</th><th>Amount</th><th>Respond by</th><th>Status</th><th /></tr></thead>
            <tbody>
              {rows.map((c) => {
                const days = Math.ceil((new Date(c.respond_by).getTime() - Date.now()) / 86_400_000);
                return (
                  <tr key={c.id}>
                    <td><Link to={`/orders/${c.order_id}`} className="mono">{c.order_id.slice(0, 8)}</Link></td>
                    <td className="mono">{c.network} {c.reason_code}<div className="small muted">{c.category.replace(/_/g, ' ')}</div></td>
                    <td className="mono">{money(c.amount_cents)}</td>
                    <td className="small">{fmt(c.respond_by)}<div className={days <= 5 ? '' : 'muted'} style={days <= 5 ? { color: 'var(--disputed)' } : undefined}>{days} days left</div></td>
                    <td><span className={`chip ${c.status === 'won' ? 'released' : c.status === 'lost' ? 'disputed' : 'held'}`}>{c.status.replace('_', ' ')}</span></td>
                    <td>{c.packet_sha256 && <button className="btn ghost" onClick={() => openPdf(c.id)}>Evidence PDF</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : tab === 'recon' ? (
        <div className="stack">
          <button className="btn ghost" style={{ alignSelf: 'flex-start' }} onClick={() => act(() => api('/admin/reconciliation/run', { body: {} }))}>Run now</button>
          {rows.map((r) => (
            <details key={r.id} className="card">
              <summary style={{ cursor: 'pointer' }}>
                <span className={`chip ${r.status === 'ok' ? 'released' : r.status === 'running' ? 'held' : 'disputed'}`}>{r.status}</span>{' '}
                {fmt(r.started_at)} · {r.report?.issues?.length ?? 0} issues · {r.report?.warnings?.length ?? 0} warnings
              </summary>
              <pre className="secret" style={{ marginTop: 12, maxHeight: 320, overflow: 'auto' }}>{JSON.stringify(r.report, null, 2)}</pre>
            </details>
          ))}
        </div>
      ) : tab === 'audit' ? (
        <div className="card table-wrap">
          <table className="data">
            <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Details</th></tr></thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <td className="small mono">{fmt(e.created_at)}</td>
                  <td className="small">{e.actor_name}<div className="muted">{e.actor_role} · {e.ip}</div></td>
                  <td className="mono small">{e.action}</td>
                  <td className="small">{e.target_type} <span className="mono muted">{e.target_id?.slice(0, 8)}</span></td>
                  <td className="small muted">{Object.keys(e.details ?? {}).length ? JSON.stringify(e.details) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="card table-wrap">
          <table className="data">
            <thead><tr><th>Platform account</th><th>Balance</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.kind + r.currency}>
                  <td>{r.kind.replace(/_/g, ' ')}</td>
                  <td className="mono">{money(r.balance_cents, r.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted" style={{ marginTop: 12 }}>Gateway clearing is negative by the amount the payment partner holds for us. Escrow is buyer money awaiting release.</p>
        </div>
      )}
    </div>
  );
}

function DisputeCard({ d, onResolve }: { d: any; onResolve: (outcome: 'buyer' | 'seller', note: string) => void }) {
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(false);
  if (open)
    return (
      <div className="stack">
        <button className="cursor-pointer self-start border-0 bg-transparent p-0 underline" onClick={() => setOpen(false)}>← All disputes</button>
        <DisputeCase id={d.id} onResolve={onResolve} />
      </div>
    );
  return (
    <div className="card stack">
      <div className="row spread">
        <div>
          <b>{money(d.amount_cents, d.currency)}</b> <span className="muted small">opened {fmt(d.created_at)}</span>
        </div>
        <span className="row" style={{ gap: 12 }}>
          <button className="btn" onClick={() => setOpen(true)}>Open case file</button>
          <Link to={`/orders/${d.order_id}`}>Read order and chat</Link>
        </span>
      </div>
      <div className="small muted">{d.offer_title ? `${d.offer_title} · ` : ''}{DISPUTE_CATEGORY[d.category] ?? d.category ?? ''}{d.statements ? ` · ${d.statements} statement${d.statements === 1 ? '' : 's'}` : ''}</div>
      <p>“{d.reason}”</p>
      <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Decision note (shared in the order record)" style={{ minHeight: 70 }} />
      <div className="row">
        <button className="btn ghost" disabled={note.trim().length < 3} onClick={() => onResolve('buyer', note)}>Refund buyer</button>
        <button className="btn release" disabled={note.trim().length < 3} onClick={() => onResolve('seller', note)}>Release to seller</button>
      </div>
    </div>
  );
}
