import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Warning as AlertTriangle, CheckCircle as CheckCircle2, Wrench, XCircle } from '@phosphor-icons/react';
import { api } from '../api';
import { usePageMeta } from '@/lib/seo';
import { cn } from '@/lib/utils';

export type ComponentStatus = 'operational' | 'degraded' | 'partial_outage' | 'major_outage' | 'maintenance';
export interface Incident {
  id: string;
  kind: 'incident' | 'maintenance';
  title: string;
  impact: string;
  status: string;
  components: string[];
  scheduled_start: string | null;
  scheduled_end: string | null;
  created_at: string;
  resolved_at: string | null;
  updates: Array<{ status: string; body: string; at: string }>;
}
interface Summary {
  status: ComponentStatus;
  description: string;
  components: Array<{ id: string; name: string; status: ComponentStatus }>;
  incidents: Incident[];
  maintenance: Incident[];
  recent: Incident[];
  updatedAt: string;
}

export const STATUS_LABEL: Record<ComponentStatus, string> = {
  operational: 'Operational',
  degraded: 'Degraded performance',
  partial_outage: 'Partial outage',
  major_outage: 'Major outage',
  maintenance: 'Under maintenance',
};
const TONE: Record<ComponentStatus, string> = {
  operational: 'text-released',
  degraded: 'text-held',
  partial_outage: 'text-held',
  major_outage: 'text-disputed',
  maintenance: 'text-muted-foreground',
};
export const UPDATE_LABEL: Record<string, string> = {
  investigating: 'Investigating',
  identified: 'Identified',
  monitoring: 'Monitoring',
  resolved: 'Resolved',
  scheduled: 'Scheduled',
  in_progress: 'In progress',
  completed: 'Completed',
};
const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function StatusIcon({ status, className }: { status: ComponentStatus; className?: string }) {
  const Icon = status === 'operational' ? CheckCircle2 : status === 'maintenance' ? Wrench : status === 'major_outage' ? XCircle : AlertTriangle;
  return <Icon className={cn('size-5 shrink-0', TONE[status], className)} />;
}

export function IncidentCard({ i }: { i: Incident }) {
  return (
    <article className="card stack" style={{ gap: 0 }}>
      <div className="row spread">
        <h3 style={{ margin: 0 }}>{i.title}</h3>
        <span className={cn('chip', i.kind === 'maintenance' ? '' : i.impact === 'critical' ? 'disputed' : 'held', i.resolved_at && 'released')}>
          {i.resolved_at ? (i.kind === 'maintenance' ? 'Completed' : 'Resolved') : UPDATE_LABEL[i.status] ?? i.status}
        </span>
      </div>
      {i.kind === 'maintenance' && i.scheduled_start && (
        <p className="small muted" style={{ margin: '4px 0 0' }}>
          Scheduled {when(i.scheduled_start)} – {when(i.scheduled_end!)}
        </p>
      )}
      <ol className="m-0 mt-3 list-none space-y-3 border-s border-border p-0 ps-4">
        {i.updates.map((u, k) => (
          <li key={k} className="relative">
            <span className="absolute -start-[21px] top-1.5 size-2 rounded-full bg-border" aria-hidden />
            <div className="text-sm">
              <b>{UPDATE_LABEL[u.status] ?? u.status}</b> <span className="muted">· {when(u.at)}</span>
            </div>
            <p className="m-0 text-sm">{u.body}</p>
          </li>
        ))}
      </ol>
    </article>
  );
}

/** Public status page: live component health, incidents, maintenance and email updates. */
export function StatusPage() {
  usePageMeta({ title: 'System status', description: 'Live status of Bullizard: checkout, delivery, chat, payouts and notifications, with incident history.' });
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState('');
  const [params, setParams] = useSearchParams();
  const [email, setEmail] = useState('');
  const [note, setNote] = useState<{ kind: 'ok' | 'alert'; text: string } | null>(null);

  useEffect(() => {
    const load = () => api<Summary>('/status').then(setData).catch((e) => setError(e.message));
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  // Links from status emails: ?confirm=… (double opt-in) and ?unsubscribe=…
  useEffect(() => {
    const confirm = params.get('confirm');
    const unsub = params.get('unsubscribe');
    if (!confirm && !unsub) return;
    const call = confirm ? api('/status/confirm', { body: { token: confirm } }) : api('/status/unsubscribe', { body: { token: unsub } });
    call
      .then(() => setNote({ kind: 'ok', text: confirm ? 'You’ll get an email when we post an incident or planned maintenance.' : 'You’re unsubscribed from status emails.' }))
      .catch((e) => setNote({ kind: 'alert', text: e.message }))
      .finally(() => setParams({}, { replace: true }));
  }, [params, setParams]);

  const subscribe = async (e: React.FormEvent) => {
    e.preventDefault();
    setNote(null);
    try {
      await api('/status/subscribe', { body: { email } });
      setNote({ kind: 'ok', text: `Check ${email} for a link to confirm.` });
      setEmail('');
    } catch (err: any) {
      setNote({ kind: 'alert', text: err.message });
    }
  };

  if (!data) return <p className="muted">{error || 'Checking systems…'}</p>;
  const open = [...data.incidents, ...data.maintenance];
  return (
    <div className="stack" style={{ maxWidth: 820, margin: '0 auto' }}>
      <div className="eyebrow">System status</div>
      <div
        className={cn(
          'flex items-center gap-3 rounded-xl border p-5',
          data.status === 'operational' ? 'border-released/40 bg-released/10' : data.status === 'major_outage' ? 'border-disputed/40 bg-disputed/10' : 'border-held/40 bg-held/10',
        )}
      >
        <StatusIcon status={data.status} className="size-7" />
        <div>
          <h1 style={{ fontSize: 28, margin: 0 }}>{data.description}</h1>
          <span className="small muted">Updated {when(data.updatedAt)} · refreshes every minute</span>
        </div>
      </div>
      {note && <div className={note.kind}>{note.text}</div>}

      {open.length > 0 && (
        <section className="stack">
          <h2 style={{ fontSize: 22, margin: 0 }}>Now</h2>
          {open.map((i) => <IncidentCard key={i.id} i={i} />)}
        </section>
      )}

      <section className="card" style={{ padding: 0 }}>
        <ul className="m-0 list-none p-0">
          {data.components.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5 last:border-b-0">
              <span className="font-medium">{c.name}</span>
              <span className={cn('inline-flex items-center gap-2 text-sm', TONE[c.status])}>
                {STATUS_LABEL[c.status]} <StatusIcon status={c.status} className="size-4" />
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="stack">
        <h2 style={{ fontSize: 22, margin: 0 }}>Past 14 days</h2>
        {data.recent.length === 0 ? <p className="muted small">No incidents in the last 14 days.</p> : data.recent.map((i) => <IncidentCard key={i.id} i={i} />)}
      </section>

      <form className="card row" onSubmit={subscribe}>
        <div style={{ flex: '1 1 260px' }}>
          <b>Get status updates by email</b>
          <div className="small muted">One email per incident update or planned maintenance. Unsubscribe from any email.</div>
        </div>
        <input type="email" required aria-label="Email for status updates" value={email} onChange={(e) => setEmail(e.target.value)} style={{ flex: '1 1 220px' }} />
        <button className="btn">Subscribe</button>
      </form>
    </div>
  );
}
