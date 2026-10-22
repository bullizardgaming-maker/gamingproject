import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, money } from '../api';
import { categoryLabel } from '@/lib/catalog';

const fmt = (d: string) => new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
/** "term:aimbot" → "aimbot", "contact:discord" → "contact: discord" */
const reasonLabel = (r: string) => (r.startsWith('term:') ? r.slice(5) : r.startsWith('contact:') ? `contact: ${r.slice(8).replace('_', ' ')}` : r.replace('_', ' '));

type Sub = 'listings' | 'chats' | 'terms';

/** Operations → Moderation: listings held for review, chats flagged for off-platform contact, and the term list. */
export function ModerationPanel() {
  const [sub, setSub] = useState<Sub>('listings');
  const [counts, setCounts] = useState<{ listings: number; chats: number } | null>(null);
  const refreshCounts = useCallback(() => void api<{ listings: number; chats: number }>('/admin/moderation/summary').then(setCounts).catch(() => {}), []);
  useEffect(refreshCounts, [refreshCounts]);
  return (
    <div className="stack">
      <div className="filters" role="group" aria-label="Moderation" style={{ margin: 0 }}>
        <button aria-pressed={sub === 'listings'} onClick={() => setSub('listings')}>Listings to review{counts ? ` (${counts.listings})` : ''}</button>
        <button aria-pressed={sub === 'chats'} onClick={() => setSub('chats')}>Flagged chats{counts ? ` (${counts.chats})` : ''}</button>
        <button aria-pressed={sub === 'terms'} onClick={() => setSub('terms')}>Terms</button>
      </div>
      {sub === 'listings' ? <ListingQueue onChange={refreshCounts} /> : sub === 'chats' ? <ChatQueue onChange={refreshCounts} /> : <Terms />}
    </div>
  );
}

function ListingQueue({ onChange }: { onChange: () => void }) {
  const [list, setList] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => void api<any[]>('/admin/moderation/listings').then(setList).catch((e) => setError(e.message)), []);
  useEffect(load, [load]);
  const decide = async (id: string, approve: boolean) => {
    const note = approve ? undefined : prompt('Reason for the seller (required)')?.trim();
    if (!approve && !note) return;
    try {
      await api(`/admin/moderation/listings/${id}`, { body: { approve, note } });
      load();
      onChange();
    } catch (e: any) {
      setError(e.message);
    }
  };
  if (list === null) return <p className="muted">{error || 'Loading…'}</p>;
  return (
    <div className="stack">
      <p className="small muted" style={{ margin: 0 }}>Listings matching a review term or containing contact details are hidden until approved. Block terms are refused at posting time.</p>
      {error && <div className="alert" role="alert">{error}</div>}
      {list.length === 0 ? (
        <div className="card muted">No listings waiting. 🎉</div>
      ) : (
        list.map((o) => (
          <div key={o.id} className="card stack" style={{ gap: 8 }}>
            <div className="row spread" style={{ alignItems: 'start' }}>
              <div style={{ minWidth: 0, flex: '1 1 300px' }}>
                <Link to={`/offers/${o.id}`} className="font-medium">{o.title}</Link>
                <div className="small muted">{o.game} · {categoryLabel(o.category_slug)} · {money(o.price_cents, o.currency)} · {o.seller_name} ({o.seller_completed_orders} sales) · {fmt(o.updated_at)}</div>
              </div>
              <div className="row" style={{ gap: 6 }}>{o.review_reasons.map((r: string) => <span key={r} className="chip disputed">{reasonLabel(r)}</span>)}</div>
            </div>
            {o.description && <p className="small" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{o.description}</p>}
            <div className="row">
              <button className="btn" onClick={() => decide(o.id, true)}>Approve</button>
              <button className="btn ghost" onClick={() => decide(o.id, false)}>Reject…</button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function ChatQueue({ onChange }: { onChange: () => void }) {
  const [status, setStatus] = useState<'open' | 'confirmed' | 'dismissed'>('open');
  const [list, setList] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    setList(null);
    api<any[]>(`/admin/moderation/chats?status=${status}`).then(setList).catch((e) => setError(e.message));
  }, [status]);
  useEffect(load, [load]);
  const decide = async (id: string, confirm: boolean) => {
    try {
      await api(`/admin/moderation/chats/${id}`, { body: { confirm } });
      load();
      onChange();
    } catch (e: any) {
      setError(e.message);
    }
  };
  return (
    <div className="stack">
      <OffplatformPolicy />
      <div className="row spread">
        <p className="small muted" style={{ margin: 0, flex: '1 1 320px' }}>
          The message was not delivered; the sender saw "Not sent". Confirm a real attempt to take the deal elsewhere, or dismiss a false alarm (that takes back the strike). Opening this queue is recorded in the audit log.
        </p>
        <div className="filters" role="group" aria-label="Flag status" style={{ margin: 0 }}>
          {(['open', 'confirmed', 'dismissed'] as const).map((s) => <button key={s} aria-pressed={status === s} onClick={() => setStatus(s)}>{s[0]!.toUpperCase() + s.slice(1)}</button>)}
        </div>
      </div>
      {error && <div className="alert" role="alert">{error}</div>}
      {list === null ? (
        <p className="muted">Loading…</p>
      ) : list.length === 0 ? (
        <div className="card muted">Nothing here. 🎉</div>
      ) : (
        list.map((f) => (
          <div key={f.id} className="card stack" style={{ gap: 8 }}>
            <div className="row spread">
              <div>
                <b>{f.user_name}</b> <span className="small muted">({f.role}) · {f.user_email} · strikes {f.offplatform_strikes}{f.confirmed_before ? ` · ${f.confirmed_before} confirmed before` : ''}{f.user_status !== 'active' ? ` · ${f.user_status}` : ''}</span>
                <div className="small muted">{f.order_id ? <Link to={`/orders/${f.order_id}`}>Order {f.order_id.slice(0, 8)}</Link> : 'Pre-sale question'} · {fmt(f.created_at)}</div>
              </div>
              <div className="row" style={{ gap: 6 }}>{f.reasons.map((r: string) => <span key={r} className="chip disputed">{reasonLabel(r)}</span>)}</div>
            </div>
            <div className="stack" style={{ gap: 4 }}>
              {f.context.map((m: any) => (
                <div key={m.seq} className="small" style={{ padding: '6px 10px', borderRadius: 8, background: m.seq === f.seq ? 'var(--disputed-soft)' : 'var(--paper)', border: '1px solid var(--rule)' }}>
                  <span className="muted">{m.kind !== 'text' ? 'System' : m.sender_id === f.user_id ? f.user_name : 'Other party'}: </span>
                  {m.erased ? <i className="muted">erased</i> : m.body}
                </div>
              ))}
            </div>
            {f.status === 'open' ? (
              <div className="row">
                <button className="btn" onClick={() => decide(f.id, true)}>Confirm</button>
                <button className="btn ghost" onClick={() => decide(f.id, false)}>Dismiss</button>
              </div>
            ) : (
              f.note && <div className="small muted">Note: {f.note}</div>
            )}
          </div>
        ))
      )}
    </div>
  );
}

function Terms() {
  const [list, setList] = useState<Array<{ id: string; term: string; action: 'block' | 'review' }> | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => void api<any[]>('/admin/moderation/terms').then(setList).catch((e) => setError(e.message)), []);
  useEffect(load, [load]);
  const add = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    try {
      await api('/admin/moderation/terms', { body: { term: f.term, action: f.action } });
      form.reset();
      setError('');
      load();
    } catch (err: any) {
      setError(err.message);
    }
  };
  const remove = async (id: string) => {
    await api(`/admin/moderation/terms/${id}`, { method: 'DELETE' }).catch((e) => setError(e.message));
    load();
  };
  return (
    <div className="stack">
      <form className="row" onSubmit={add}>
        <input name="term" required minLength={2} maxLength={60} placeholder="Word or phrase" aria-label="Term" style={{ flex: '1 1 220px' }} />
        <select name="action" defaultValue="review" aria-label="Action" style={{ width: 200 }}>
          <option value="review">Hold for review</option>
          <option value="block">Block outright</option>
        </select>
        <button className="btn">Add term</button>
      </form>
      <p className="small muted" style={{ margin: 0 }}>Matching ignores case and simple tricks like digits for letters (h4ck) or dots between letters. Changes apply to new and edited listings within 30 seconds.</p>
      {error && <div className="alert" role="alert">{error}</div>}
      {list === null ? (
        <p className="muted">Loading…</p>
      ) : (
        (['block', 'review'] as const).map((a) => (
          <div key={a} className="stack" style={{ gap: 6 }}>
            <b className="small">{a === 'block' ? 'Blocked' : 'Held for review'}</b>
            <div className="row" style={{ gap: 6 }}>
              {list.filter((t) => t.action === a).map((t) => (
                <span key={t.id} className={`chip ${a === 'block' ? 'disputed' : 'held'}`}>
                  {t.term}
                  <button className="cursor-pointer border-0 bg-transparent p-0" aria-label={`Remove ${t.term}`} onClick={() => remove(t.id)}>×</button>
                </span>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}


/** What happens on each outside-contact offence (staff-set): warn, suspend or ban. */
function OffplatformPolicy() {
  const [actions, setActions] = useState<string[] | null>(null);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ actions: string[] }>('/admin/moderation/offplatform-policy').then((r) => setActions(r.actions)).catch((e) => setError(e.message));
  }, []);
  if (!actions) return null;
  const save = async (next: string[]) => {
    setError('');
    setMsg('');
    try {
      const r = await api<{ actions: string[] }>('/admin/moderation/offplatform-policy', { method: 'PUT', body: { actions: next } });
      setActions(r.actions);
      setMsg('Saved.');
    } catch (e: any) {
      setError(e.message);
    }
  };
  return (
    <div className="card stack" data-testid="offplatform-policy">
      <b>Outside-contact offences</b>
      <p className="small muted" style={{ margin: 0 }}>A blocked message is never delivered. Pick what each offence does; the last one repeats for every offence after it.</p>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
        {actions.map((a, i) => (
          <label key={i} className="field" style={{ margin: 0 }}>
            {i + 1}{['st', 'nd', 'rd'][i] ?? 'th'} offence
            <select aria-label={`Offence ${i + 1} action`} value={a} onChange={(e) => save(actions.map((x, k) => (k === i ? e.target.value : x)))} style={{ width: 'auto' }}>
              <option value="warn">Warn (block only)</option>
              <option value="suspend">Suspend</option>
              <option value="ban">Ban</option>
            </select>
          </label>
        ))}
        {actions.length < 5 && <button className="btn ghost small" onClick={() => save([...actions, 'ban'])}>Add step</button>}
        {actions.length > 1 && <button className="btn ghost small" onClick={() => save(actions.slice(0, -1))}>Remove last</button>}
      </div>
      {msg && <span className="small text-released" role="status">{msg}</span>}
      {error && <div className="alert" role="alert">{error}</div>}
    </div>
  );
}
