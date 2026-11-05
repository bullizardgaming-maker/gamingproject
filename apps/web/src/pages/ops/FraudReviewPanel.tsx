import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Clock, Detective, MagnifyingGlass, Snowflake, Warning, WarningOctagon } from '@phosphor-icons/react';
import { api, money } from '../../api';
import { useLoad } from '../AdminPanels';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Stat, initials } from './OpsStat';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

/**
 * Ops → Fraud review (Round 30, shadcn/ui). Same logic as before: the open risk flags (GET /admin/risk-flags), and per
 * account "Clear and unfreeze" or "Confirm fraud" (POST /admin/risk-flags/:id/review { decision }). Confirming suspends
 * the account, so it still asks first — now inside the panel instead of a browser pop-up.
 */

const HIGH = 0.8;
const ago = (d: string) => {
  const h = Math.floor((Date.now() - new Date(d).getTime()) / 3_600_000);
  return h < 1 ? 'just now' : h < 48 ? `${h} h ago` : `${Math.floor(h / 24)} days ago`;
};
/** The reasons in plain words (the API sends reasons_text; older rows only have codes). */
const reasonsOf = (f: any): string[] => (Array.isArray(f.reasons_text) && f.reasons_text.length ? f.reasons_text : (f.reasons ?? []).map((r: any) => String(r.code).replace(/_/g, ' ')));

function ScoreMeter({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const high = score >= HIGH;
  return (
    <div className="flex items-center gap-2" title={`Score ${score.toFixed(2)}`}>
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-secondary" aria-hidden>
        <div className={cn('h-full rounded-full', high ? 'bg-destructive' : 'bg-held')} style={{ width: `${pct}%` }} />
      </div>
      <span className={cn('font-semibold tabular-nums', high ? 'text-disputed-ink' : 'text-held-ink')}>{score.toFixed(2)}</span>
    </div>
  );
}

type Filter = 'all' | 'high' | 'frozen';

export function FraudReviewPanel() {
  const { data, error, reload } = useLoad(() => api<any[]>('/admin/risk-flags'));
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const rows = data ?? [];
  const by = useMemo(() => ({ high: rows.filter((f) => Number(f.score) >= HIGH), frozen: rows.filter((f) => f.withdrawals_frozen) }), [rows]);
  const oldest = rows.reduce<string | null>((o, f) => (!o || f.created_at < o ? f.created_at : o), null);
  const needle = q.trim().toLowerCase();
  const shown = rows
    .filter((f) => (filter === 'high' ? Number(f.score) >= HIGH : filter === 'frozen' ? f.withdrawals_frozen : true))
    .filter((f) => !needle || [f.display_name, f.email, f.order_ref].some((x) => String(x ?? '').toLowerCase().includes(needle)));
  const current = rows.find((f) => f.id === open) ?? null;

  const review = async (f: any, decision: 'clear' | 'confirm') => {
    setMsg('');
    try {
      await api(`/admin/risk-flags/${f.id}/review`, { body: { decision } });
      setMsg(decision === 'clear' ? `${f.display_name} cleared: payouts and escrows unfrozen.` : `${f.display_name} confirmed as fraud: the account is suspended.`);
      setOpen(null);
      reload();
    } catch (e: any) {
      setMsg(e.message);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-muted-foreground">Accounts the fraud checks flagged. Their escrows stay frozen until you clear or confirm them.</p>
      {error && <Alert variant="destructive"><Warning /><AlertDescription>{error}</AlertDescription></Alert>}
      {msg && <div role="status" className="rounded-lg border border-border bg-card px-3 py-2.5 text-sm">{msg}</div>}

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Stat icon={Detective} label="Open flags" value={String(rows.length)} sub={`${new Set(rows.map((f) => f.user_id)).size} accounts`} />
        <Stat icon={WarningOctagon} label={`High score (${HIGH.toFixed(2)}+)`} value={String(by.high.length)} sub={by.high.length ? 'Review these first' : 'None'} bad={by.high.length > 0} />
        <Stat icon={Snowflake} label="Payouts frozen" value={String(by.frozen.length)} sub="Withdrawals blocked" />
        <Stat icon={Clock} label="Oldest waiting" value={oldest ? ago(oldest).replace(' ago', '') : '—'} sub={oldest ? 'since flagged' : 'Nothing waiting'} />
      </div>

      <Card className="gap-0 overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-border p-3">
          <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)} className="max-w-full">
            <TabsList aria-label="Filter flags" className="max-w-full justify-start overflow-x-auto">
              <TabsTrigger value="all">All <span className="tabular-nums text-muted-foreground">{rows.length}</span></TabsTrigger>
              <TabsTrigger value="high">High score <span className="tabular-nums text-muted-foreground">{by.high.length}</span></TabsTrigger>
              <TabsTrigger value="frozen">Payouts frozen <span className="tabular-nums text-muted-foreground">{by.frozen.length}</span></TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="relative ms-auto w-full sm:w-64">
            <MagnifyingGlass className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by account or order" aria-label="Filter by account or order" className="ps-8" />
          </div>
        </div>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Account</TableHead>
              <TableHead>Score</TableHead>
              <TableHead>Why</TableHead>
              <TableHead>Order</TableHead>
              <TableHead><span className="sr-only">Actions</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data === null ? (
              <TableRow><TableCell colSpan={5} className="text-muted-foreground">Loading…</TableCell></TableRow>
            ) : shown.length === 0 ? (
              <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">Nothing waiting here.</TableCell></TableRow>
            ) : (
              shown.map((f) => {
                const reasons = reasonsOf(f);
                return (
                  <TableRow key={f.id} data-state={open === f.id ? 'selected' : undefined}>
                    <TableCell>
                      <div className="flex items-center gap-2.5">
                        <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full border border-border bg-secondary text-xs font-semibold">{initials(f.display_name ?? '?')}</span>
                        <div className="min-w-0">
                          <div className="whitespace-nowrap font-semibold">{f.display_name}</div>
                          <div className="text-xs text-muted-foreground">{f.email}</div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <ScoreMeter score={Number(f.score)} />
                      <div className="mt-1 whitespace-nowrap text-xs text-muted-foreground">{ago(f.created_at)}</div>
                    </TableCell>
                    <TableCell className="max-w-[560px]">
                      <div className="line-clamp-2 text-[13px]">{reasons[0]}</div>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {reasons.length > 1 && <Badge variant="outline">+{reasons.length - 1} more</Badge>}
                        {f.withdrawals_frozen && <Badge variant="info"><Snowflake aria-hidden /> Payouts frozen</Badge>}
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {f.order_id ? (
                        <>
                          <Link to={`/orders/${f.order_id}`} className="tabular-nums">{f.order_ref ?? 'Order'}</Link>
                          {f.amount_cents != null && <div className="text-xs text-muted-foreground tabular-nums">{money(Number(f.amount_cents), 'USD')}</div>}
                        </>
                      ) : (
                        <span className="text-muted-foreground">Account-wide</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end">
                        <Button size="sm" onClick={() => setOpen(f.id)}>Review</Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
        <div className="flex flex-wrap justify-between gap-2 border-t border-border px-3 py-2.5 text-[13px] text-muted-foreground">
          <span>{shown.length} flag{shown.length === 1 ? '' : 's'}</span>
          <span>A decision closes every open flag on that account.</span>
        </div>
      </Card>

      <Sheet open={!!current} onOpenChange={(o) => !o && setOpen(null)}>
        {current && <FlagSheet f={current} onReview={review} />}
      </Sheet>
    </div>
  );
}

function FlagSheet({ f, onReview }: { f: any; onReview: (f: any, decision: 'clear' | 'confirm') => void }) {
  const [confirming, setConfirming] = useState(false);
  const reasons = reasonsOf(f);
  const high = Number(f.score) >= HIGH;
  return (
    <SheetContent>
      <SheetHeader>
        <SheetTitle>Fraud review · {f.display_name}</SheetTitle>
        <SheetDescription>Flagged {ago(f.created_at)}{f.order_id ? ' on an order' : ' on the account'}</SheetDescription>
      </SheetHeader>
      <div className="flex flex-col gap-4 overflow-y-auto p-5">
        <div className={cn('flex items-center justify-between rounded-lg border p-3', high ? 'border-destructive/40 bg-destructive/8' : 'border-border')}>
          <div>
            <div className="text-xs text-muted-foreground">Risk score</div>
            <div className={cn('text-2xl font-bold tabular-nums', high ? 'text-disputed-ink' : 'text-held-ink')}>{Number(f.score).toFixed(2)}</div>
          </div>
          {high ? <Badge variant="destructive" dot>High</Badge> : <Badge variant="warning" dot>Review</Badge>}
        </div>
        <div>
          <div className="mb-2 text-sm font-semibold">Why it was flagged</div>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {reasons.map((r, i) => (
              <li key={i} className="flex gap-2 rounded-md border border-border px-3 py-2 text-sm"><Warning className="mt-0.5 size-4 shrink-0 text-held-ink" aria-hidden />{r}</li>
            ))}
          </ul>
        </div>
        <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-2.5 text-sm">
          <dt className="text-muted-foreground">Email</dt><dd className="m-0 break-all">{f.email}</dd>
          <dt className="text-muted-foreground">Payouts</dt><dd className="m-0">{f.withdrawals_frozen ? 'Frozen' : 'Not frozen'}</dd>
          <dt className="text-muted-foreground">Order</dt>
          <dd className="m-0">{f.order_id ? <Link to={`/orders/${f.order_id}`}>{f.order_ref ?? 'Open the order'}</Link> : 'Account-wide'}{f.amount_cents != null && <span className="text-muted-foreground"> · {money(Number(f.amount_cents), 'USD')}</span>}</dd>
        </dl>
        {confirming && (
          <>
            <Separator />
            <Alert variant="destructive">
              <WarningOctagon />
              <AlertTitle>Suspend {f.display_name}?</AlertTitle>
              <AlertDescription>The account is suspended and every open flag on it is closed as fraud.</AlertDescription>
            </Alert>
          </>
        )}
      </div>
      <SheetFooter>
        {confirming ? (
          <>
            <Button variant="outline" onClick={() => setConfirming(false)}>Cancel</Button>
            <Button variant="destructive" onClick={() => onReview(f, 'confirm')}>Suspend account</Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={() => onReview(f, 'clear')}>Clear and unfreeze</Button>
            <Button variant="destructive" onClick={() => setConfirming(true)}>Confirm fraud</Button>
          </>
        )}
      </SheetFooter>
    </SheetContent>
  );
}

