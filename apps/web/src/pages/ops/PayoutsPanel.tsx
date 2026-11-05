import { useMemo, useState } from 'react';
import { ArrowsClockwise, CheckCircle, Check, Clock, Copy, Lightning, MagnifyingGlass, HandCoins, Warning, WarningOctagon } from '@phosphor-icons/react';
import { api, money } from '../../api';
import { useLoad } from '../AdminPanels';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Stat, initials } from './OpsStat';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

/**
 * Ops → Payouts (Round 30, shadcn/ui). Same logic as before: approve / reject a withdrawal, re-check one the provider
 * didn't answer, see the provider's own error, and record a payout sent by hand (wallet / InstaPay always, USDT on
 * staging only; two people, Finance + Lead). The layout is new: numbers on top, a filtered table, details in a side panel.
 */

const fmt = (d: string) => new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const MANUAL = new Set(['wallet', 'instapay']);
const METHOD_LABEL: Record<string, string> = { usdt: 'USDT', wallet: 'Mobile wallet', instapay: 'InstaPay' };
const isManual = (w: any) => MANUAL.has(w.method);
const methodOf = (w: any) => (isManual(w) ? METHOD_LABEL[w.method] : `USDT · ${String(w.destination_currency ?? '').toLowerCase() === 'usdtbsc' ? 'BEP-20' : 'TRC-20'}`);
const short = (a: string | null | undefined) => (!a ? '—' : a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

/** The payout provider's own error, as "NOWPayments: 403 … — message". The API keeps the staff text in failure_reason. */
export function providerText(e: any): string | null {
  if (!e) return null;
  if (typeof e === 'string') return /nowpayments/i.test(e) ? e : `NOWPayments: ${e}`;
  if (typeof e.reason === 'string' && e.reason) return providerText(e.reason);
  const status = e.provider_status ?? e.status ?? e.providerStatus;
  const code = e.code ?? e.providerCode;
  const message = e.provider_message ?? e.message ?? e.providerMessage;
  if (!status && !code && !message) return null;
  return `NOWPayments: ${[status, code].filter(Boolean).join(' ')}${message ? ` — ${message}` : ''}`;
}
const errorOf = (w: any) => providerText(w.failure_reason ?? w.provider_error ?? w.last_error);

type Filter = 'all' | 'awaiting' | 'errors' | 'sending' | 'manual';
const inFilter = (w: any, f: Filter) =>
  f === 'all' ? true
  : f === 'awaiting' ? w.status === 'pending_approval'
  : f === 'errors' ? w.status === 'unknown'
  : f === 'sending' ? w.status === 'processing' && !isManual(w)
  : w.status === 'processing' && isManual(w);

function StatusBadge({ w }: { w: any }) {
  if (w.status === 'unknown') return <Badge variant="destructive" dot>Provider error</Badge>;
  if (w.status === 'processing') return isManual(w) ? <Badge variant="warning" dot>Send by hand</Badge> : <Badge variant="info" dot>Sending</Badge>;
  return <Badge variant="warning" dot>Awaiting approval</Badge>;
}


export function PayoutsPanel() {
  const { data, error, reload } = useLoad(() => api<any[]>('/admin/withdrawals'));
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const rows = data ?? [];
  const sum = (list: any[], k: 'amount_cents' | 'net_cents') => money(list.reduce((s, w) => s + Number(w[k]), 0), 'USD');
  const by = useMemo(() => ({
    awaiting: rows.filter((w) => inFilter(w, 'awaiting')),
    errors: rows.filter((w) => inFilter(w, 'errors')),
    sending: rows.filter((w) => inFilter(w, 'sending')),
    manual: rows.filter((w) => inFilter(w, 'manual')),
  }), [rows]);
  const needle = q.trim().toLowerCase();
  const shown = rows.filter((w) => inFilter(w, filter) && (!needle || [w.display_name, w.email, w.destination_address, w.destination_hint].some((x) => String(x ?? '').toLowerCase().includes(needle))));
  const current = rows.find((w) => w.id === open) ?? null;

  const decide = async (id: string, approve: boolean, note?: string) => {
    setMsg('');
    try {
      const w = await api<any>(`/admin/withdrawals/${id}/decide`, { body: { approve, note: note || undefined } });
      setMsg(!approve ? 'Rejected; the amount is back in the seller’s balance.' : w.manual ? `Approved: send ${money(Number(w.net_cents), w.currency)} by hand, then mark it as sent.` : `Approved: ${money(Number(w.net_cents), w.currency)} is being sent.`);
      setOpen(null);
      reload();
    } catch (e: any) {
      // Round 29: the provider's own answer (status + message), never a bare "didn't respond".
      setMsg(providerText(e.details) ?? e.serverMessage ?? e.message);
      reload();
    }
  };
  const recheck = async (id: string) => {
    setMsg('');
    try {
      const w = await api<any>(`/admin/withdrawals/${id}/recheck`, { body: {} });
      setMsg(
        w.status === 'processing' ? 'The provider has this payout; waiting for it to finish.'
        : w.status === 'paid' ? 'The provider sent this payout; it is marked paid.'
        : w.status === 'failed' ? 'The provider never created it (checked twice, hours apart); the amount is back in the seller’s balance.'
        : 'Still unknown: the provider has no record yet. It is reversed only after two checks and several hours.',
      );
      reload();
    } catch (e: any) {
      setMsg(e.message);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-muted-foreground">Seller withdrawals waiting for approval, being sent, or stuck at the provider.</p>
      {error && <Alert variant="destructive"><Warning /><AlertDescription>{error}</AlertDescription></Alert>}
      {msg && <div role="status" className="rounded-lg border border-border bg-card px-3 py-2.5 text-sm">{msg}</div>}

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Stat icon={Clock} label="Awaiting approval" value={String(by.awaiting.length)} sub={`${sum(by.awaiting, 'amount_cents')} requested`} />
        <Stat icon={Lightning} label="Sending" value={String(by.sending.length)} sub={`${sum(by.sending, 'net_cents')} at NOWPayments`} />
        <Stat icon={HandCoins} label="Send by hand" value={String(by.manual.length)} sub={`${sum(by.manual, 'net_cents')} wallet / InstaPay`} />
        <Stat icon={WarningOctagon} label="Provider errors" value={String(by.errors.length)} sub={by.errors.length ? 'Re-check or send by hand' : 'None'} bad={by.errors.length > 0} />
      </div>

      <Card className="gap-0 overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-border p-3">
          <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)} className="max-w-full">
            <TabsList aria-label="Filter withdrawals" className="max-w-full justify-start overflow-x-auto">
              <TabsTrigger value="all">All <span className="tabular-nums text-muted-foreground">{rows.length}</span></TabsTrigger>
              <TabsTrigger value="awaiting">Awaiting <span className="tabular-nums text-muted-foreground">{by.awaiting.length}</span></TabsTrigger>
              <TabsTrigger value="errors">Errors <span className="tabular-nums text-muted-foreground">{by.errors.length}</span></TabsTrigger>
              <TabsTrigger value="sending">Sending <span className="tabular-nums text-muted-foreground">{by.sending.length}</span></TabsTrigger>
              <TabsTrigger value="manual">By hand <span className="tabular-nums text-muted-foreground">{by.manual.length}</span></TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="relative ms-auto w-full sm:w-64">
            <MagnifyingGlass className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by seller or address" aria-label="Filter by seller or address" className="ps-8" />
          </div>
        </div>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Seller</TableHead>
              <TableHead>Method · to</TableHead>
              <TableHead className="text-end">Sends</TableHead>
              <TableHead>Status</TableHead>
              <TableHead><span className="sr-only">Actions</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data === null ? (
              <TableRow><TableCell colSpan={6} className="text-muted-foreground">Loading…</TableCell></TableRow>
            ) : shown.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="py-8 text-center text-muted-foreground">Nothing waiting.</TableCell></TableRow>
            ) : (
              shown.flatMap((w) => {
                const err = w.status === 'unknown' ? errorOf(w) : null;
                return [
                  <TableRow key={w.id} data-state={open === w.id ? 'selected' : undefined} className={cn(err && 'border-b-0')}>
                    <TableCell>
                      <div className="flex items-center gap-2.5">
                        <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full border border-border bg-secondary text-xs font-semibold">{initials(w.display_name ?? '?')}</span>
                        <div className="min-w-0">
                          <div className="whitespace-nowrap font-semibold">{w.display_name}</div>
                          <div className="text-xs text-muted-foreground">KYC {w.kyc_tier} · {w.trust_level}</div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <div>{methodOf(w)}</div>
                      <div className="text-xs text-muted-foreground tabular-nums">{isManual(w) ? w.destination_hint ?? short(w.destination_address) : short(w.destination_address)}</div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-end tabular-nums">
                      <div className="font-semibold">{money(Number(w.net_cents), w.currency)}</div>
                      <div className="text-xs text-muted-foreground">{money(Number(w.amount_cents), w.currency)} − {money(Number(w.fee_cents), w.currency)} fee</div>
                    </TableCell>
                    <TableCell><StatusBadge w={w} /><div className="mt-1 whitespace-nowrap text-xs text-muted-foreground">{fmt(w.created_at)}</div></TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1.5">
                        {w.status === 'pending_approval' ? (
                          <>
                            <Button variant="outline" size="sm" onClick={() => decide(w.id, false)}>Reject</Button>
                            <Button size="sm" onClick={() => decide(w.id, true)}><Check aria-hidden /> Approve</Button>
                          </>
                        ) : (
                          <>
                            {w.status === 'unknown' && <Button variant="outline" size="sm" onClick={() => recheck(w.id)}><ArrowsClockwise aria-hidden /> Recheck</Button>}
                            <Button size="sm" variant={w.status === 'unknown' || isManual(w) ? 'default' : 'outline'} onClick={() => setOpen(w.id)}>{w.status === 'unknown' || isManual(w) ? 'Resolve' : 'Details'}</Button>
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>,
                  err ? (
                    <TableRow key={`${w.id}-err`} className="hover:bg-transparent">
                      <TableCell colSpan={6} className="pt-0">
                        <Alert variant="destructive" role="note">
                          <Warning />
                          <AlertTitle>Provider error</AlertTitle>
                          <AlertDescription data-testid="payout-provider-error">{err}</AlertDescription>
                        </Alert>
                      </TableCell>
                    </TableRow>
                  ) : null,
                ];
              })
            )}
          </TableBody>
        </Table>
        <div className="flex flex-wrap justify-between gap-2 border-t border-border px-3 py-2.5 text-[13px] text-muted-foreground">
          <span>{shown.length} withdrawal{shown.length === 1 ? '' : 's'}</span>
          <span>The fee is booked as revenue on approval; rejecting returns the whole amount.</span>
        </div>
      </Card>

      <Sheet open={!!current} onOpenChange={(o) => !o && setOpen(null)}>
        {current && <PayoutSheet w={current} onDecide={decide} onRecheck={recheck} onDone={(m) => (setMsg(m), setOpen(null), reload())} onError={setMsg} />}
      </Sheet>
    </div>
  );
}

function PayoutSheet({ w, onDecide, onRecheck, onDone, onError }: { w: any; onDecide: (id: string, approve: boolean, note?: string) => void; onRecheck: (id: string) => void; onDone: (m: string) => void; onError: (m: string) => void }) {
  const [note, setNote] = useState('');
  const [hash, setHash] = useState('');
  const [sentNote, setSentNote] = useState('');
  const [dest, setDest] = useState<string | null>(null);
  const err = w.status === 'unknown' ? errorOf(w) : null;
  const sendable = w.status === 'unknown' || w.status === 'processing';

  const showDestination = async () => {
    try {
      const d = await api<any>(`/admin/withdrawals/${w.id}/destination`);
      setDest(d.destination);
    } catch (e: any) {
      onError(e.serverMessage ?? e.message);
    }
  };
  const markSent = async () => {
    try {
      const r = await api<any>(`/admin/withdrawals/${w.id}/mark-sent`, { body: { hash: hash.trim() || undefined, note: sentNote.trim() } });
      onDone(r.status === 'paid' ? `Marked as sent: ${money(Number(r.net_cents), r.currency)}${r.tx_hash ? ` (transaction ${r.tx_hash})` : ''}.` : 'Recorded. A second person (Finance + Lead) must confirm it was sent.');
    } catch (e: any) {
      onError(e.serverMessage ?? e.message);
    }
  };

  return (
    <SheetContent>
      <SheetHeader>
        <SheetTitle>Withdrawal · {w.display_name}</SheetTitle>
        <SheetDescription>{w.status === 'pending_approval' ? 'Waiting for approval' : w.status === 'unknown' ? 'The provider did not confirm the send' : isManual(w) ? 'Approved — send it by hand' : 'Being sent by NOWPayments'}</SheetDescription>
      </SheetHeader>
      <div className="flex flex-col gap-4 overflow-y-auto p-5">
        {err && (
          <Alert variant="destructive">
            <Warning />
            <AlertTitle>Provider error</AlertTitle>
            <AlertDescription>{err}. Nothing is reversed until the provider says whether the payout exists.</AlertDescription>
          </Alert>
        )}
        <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-2.5 text-sm">
          <dt className="text-muted-foreground">Requested</dt><dd className="m-0 tabular-nums">{money(Number(w.amount_cents), w.currency)}</dd>
          <dt className="text-muted-foreground">Fee</dt><dd className="m-0 tabular-nums">{money(Number(w.fee_cents), w.currency)}</dd>
          <dt className="text-muted-foreground">Sends</dt><dd className="m-0 font-semibold tabular-nums">{money(Number(w.net_cents), w.currency)}</dd>
          <dt className="text-muted-foreground">Method</dt><dd className="m-0">{methodOf(w)}</dd>
          <dt className="text-muted-foreground">To</dt>
          <dd className="m-0 flex items-start gap-1.5 tabular-nums">
            <span data-testid="payout-destination" className="min-w-0 break-all">{isManual(w) ? dest ?? w.destination_hint ?? w.destination_address ?? '—' : w.destination_address}</span>
            {isManual(w) && !dest && <Button variant="outline" size="sm" onClick={showDestination}>Show number</Button>}
            {!isManual(w) && w.destination_address && (
              <Button variant="ghost" size="icon-sm" aria-label="Copy address" onClick={() => navigator.clipboard?.writeText(w.destination_address).catch(() => {})}><Copy /></Button>
            )}
          </dd>
          <dt className="text-muted-foreground">Seller</dt><dd className="m-0">{w.email} · KYC {w.kyc_tier} · {w.trust_level}</dd>
          <dt className="text-muted-foreground">Asked</dt><dd className="m-0">{fmt(w.created_at)}</dd>
        </dl>
        {w.status === 'unknown' && (
          <Button variant="outline" className="self-start" onClick={() => onRecheck(w.id)}><ArrowsClockwise aria-hidden /> Check with provider now</Button>
        )}

        {w.status === 'pending_approval' && (
          <div className="flex flex-col gap-2">
            <Label htmlFor="wd-note">Note</Label>
            <Textarea id="wd-note" value={note} onChange={(e) => setNote(e.target.value)} aria-label={`Note for withdrawal ${w.id.slice(0, 8)}`} />
          </div>
        )}

        {sendable && (
          <>
            <Separator />
            <div className="flex items-center gap-2 font-semibold" data-testid="mark-sent">
              Mark as sent manually
              {!isManual(w) && <Badge variant="warning">Staging only</Badge>}
            </div>
            {w.manual_send_requested_by && <p className="m-0 text-sm">Asked by {w.manual_send_requested_by_name ?? 'a staff member'}; the other role (Finance + Lead) confirms.</p>}
            <div className="flex flex-col gap-2">
              <Label htmlFor="wd-hash">Transaction ID or reference</Label>
              <Input id="wd-hash" value={hash} onChange={(e) => setHash(e.target.value)} className="tabular-nums" aria-label={`Transaction ID for withdrawal ${w.id.slice(0, 8)}`} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="wd-sent-note">Note</Label>
              <Textarea id="wd-sent-note" value={sentNote} onChange={(e) => setSentNote(e.target.value)} aria-label={`Note on the manual send for withdrawal ${w.id.slice(0, 8)}`} />
            </div>
          </>
        )}
      </div>
      <SheetFooter>
        {w.status === 'pending_approval' ? (
          <>
            <Button variant="outline" onClick={() => onDecide(w.id, false, note)}>Reject</Button>
            <Button onClick={() => onDecide(w.id, true, note)}><Check aria-hidden /> Approve</Button>
          </>
        ) : sendable ? (
          <Button disabled={sentNote.trim().length < 3} onClick={markSent}><CheckCircle aria-hidden /> {w.manual_send_requested_by ? 'Confirm sent' : 'Mark as sent manually'}</Button>
        ) : null}
      </SheetFooter>
    </SheetContent>
  );
}
