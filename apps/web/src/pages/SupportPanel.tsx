import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, money } from '../api';
import { useSession } from '../session';
import { TICKET_CATEGORY_LABEL } from '@/lib/help';
import { cn } from '@/lib/utils';
import { TICKET_STATUS, when, type Ticket } from './Help';

const STAFF_STATUS: Record<Ticket['status'], string> = { open: 'Needs reply', pending: 'Waiting on customer', resolved: 'Resolved' };

/** Operations → Support: the help-centre queue and one ticket's thread. */
export function SupportPanel() {
  const { user } = useSession();
  const [filter, setFilter] = useState<'active' | 'open' | 'pending' | 'resolved'>('active');
  const [mine, setMine] = useState(false);
  const [list, setList] = useState<Ticket[] | null>(null);
  const [open, setOpen] = useState<Ticket | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setList(null);
    api<Ticket[]>(`/admin/support/tickets?status=${filter}${mine ? '&mine=true' : ''}`).then(setList).catch((e) => setError(e.message));
  }, [filter, mine]);
  useEffect(load, [load]);
  const show = async (id: string) => setOpen(await api<Ticket>(`/admin/support/tickets/${id}`));

  if (open) return <TicketView t={open} me={user!.id} onChange={setOpen} onBack={() => (setOpen(null), load())} />;
  return (
    <div className="stack">
      <div className="row spread">
        <div className="filters" role="group" aria-label="Status" style={{ margin: 0 }}>
          {(['active', 'open', 'pending', 'resolved'] as const).map((s) => (
            <button key={s} aria-pressed={filter === s} onClick={() => setFilter(s)}>{s === 'active' ? 'All unresolved' : STAFF_STATUS[s]}</button>
          ))}
        </div>
        <label className="small inline-flex items-center gap-2"><input type="checkbox" style={{ width: 'auto' }} checked={mine} onChange={(e) => setMine(e.target.checked)} /> Assigned to me</label>
      </div>
      {error && <div className="alert" role="alert">{error}</div>}
      {list === null ? (
        <p className="muted">Loading…</p>
      ) : list.length === 0 ? (
        <div className="card muted">Nothing here. 🎉</div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>#</th><th>Request</th><th>Customer</th><th>Status</th><th>Assignee</th><th>Updated</th></tr></thead>
            <tbody>
              {list.map((t) => (
                <tr key={t.id} onClick={() => show(t.id)} style={{ cursor: 'pointer' }}>
                  <td className="mono">{t.number}</td>
                  <td>
                    <button className="cursor-pointer border-0 bg-transparent p-0 text-start font-medium hover:underline" onClick={(e) => (e.stopPropagation(), show(t.id))}>{t.subject}</button>
                    <div className="small muted">
                      {TICKET_CATEGORY_LABEL[t.category]}{t.order_id ? ' · order linked' : ''}
                      {t.priority === 'high' && <span className="chip disputed" style={{ marginInlineStart: 6 }}>High</span>}
                    </div>
                  </td>
                  <td>{t.user_name}</td>
                  <td><span className={cn('chip', TICKET_STATUS[t.status].chip)}>{STAFF_STATUS[t.status]}</span></td>
                  <td className="small">{t.assignee_name ?? <span className="muted">—</span>}</td>
                  <td className="small muted">{when(t.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TicketView({ t, me, onChange, onBack }: { t: Ticket; me: string; onChange: (t: Ticket) => void; onBack: () => void }) {
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<Ticket>) => {
    setBusy(true);
    setError('');
    try {
      onChange(await fn());
      return true;
    } catch (e: any) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const send = async (resolve: boolean) => {
    if (await run(() => api<Ticket>(`/admin/support/tickets/${t.id}/messages`, { body: { body, internal, resolve: resolve && !internal } }))) setBody('');
  };
  const patch = (p: object) => run(() => api<Ticket>(`/admin/support/tickets/${t.id}`, { method: 'PATCH', body: p }));
  return (
    <div className="stack">
      <button className="btn ghost" style={{ alignSelf: 'start' }} onClick={onBack}>← Queue</button>
      <div className="row spread" style={{ alignItems: 'start' }}>
        <div>
          <h2 style={{ margin: 0 }}>#{t.number} · {t.subject}</h2>
          <div className="small muted">{TICKET_CATEGORY_LABEL[t.category]} · {t.user_name} ({t.user_email}) · opened {when(t.created_at)}</div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <select aria-label="Status" value={t.status} onChange={(e) => patch({ status: e.target.value })} style={{ width: 'auto', height: 38, padding: '6px 10px' }}>
            {(['open', 'pending', 'resolved'] as const).map((s) => <option key={s} value={s}>{STAFF_STATUS[s]}</option>)}
          </select>
          <select aria-label="Priority" value={t.priority} onChange={(e) => patch({ priority: e.target.value })} style={{ width: 'auto', height: 38, padding: '6px 10px' }}>
            <option value="normal">Normal</option>
            <option value="high">High priority</option>
          </select>
          {t.assigned_to === me ? (
            <button className="btn ghost" onClick={() => patch({ assignedTo: null })}>Unassign me</button>
          ) : (
            <button className="btn ghost" onClick={() => patch({ assignedTo: me })}>{t.assigned_to ? `Take from ${t.assignee_name}` : 'Assign to me'}</button>
          )}
        </div>
      </div>
      {t.order && (
        <div className="card row" style={{ padding: 14 }}>
          <span className="eyebrow" style={{ margin: 0 }}>Order</span>
          <Link to={`/orders/${t.order.id}`} style={{ flex: 1 }}>{t.order.offer_title}</Link>
          <span className="small muted">{t.order.buyer_name} → {t.order.seller_name}</span>
          <span className="mono small">{money(t.order.amount_cents, t.order.currency)} · {t.order.status}</span>
        </div>
      )}
      <ol className="m-0 grid list-none gap-3 p-0">
        {t.messages!.map((m) => (
          <li key={m.id} className={cn('rounded-xl border p-4', m.internal ? 'border-held/40 bg-held/10' : m.staff ? 'border-released/30 bg-released/5' : 'border-border bg-card')}>
            <div className="mb-1 flex items-center justify-between gap-3 text-sm">
              <b>{m.author_name}{m.internal ? ' · internal note' : m.staff ? ' · support' : ''}</b>
              <span className="text-xs text-muted-foreground">{when(m.created_at)}</span>
            </div>
            <p className="m-0" style={{ whiteSpace: 'pre-wrap' }}>{m.body}</p>
          </li>
        ))}
      </ol>
      <div className="card stack">
        <label className="field">
          {internal ? 'Internal note (staff only)' : 'Reply to customer'}
          <textarea rows={4} maxLength={5000} value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
        <label className="small inline-flex items-center gap-2"><input type="checkbox" style={{ width: 'auto' }} checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Internal note — the customer won’t see it</label>
        {error && <div className="alert" role="alert">{error}</div>}
        <div className="row">
          <button className="btn" disabled={busy || !body.trim()} onClick={() => send(false)}>{internal ? 'Add note' : 'Send reply'}</button>
          {!internal && <button className="btn ghost" disabled={busy || !body.trim()} onClick={() => send(true)}>Send and resolve</button>}
        </div>
      </div>
    </div>
  );
}
