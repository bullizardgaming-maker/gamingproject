import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { BellPlus, BellRing } from 'lucide-react';
import { money } from '../api';
import { useSession } from '../session';
import { addWatch, findWatch, removeWatch, setTarget, useWatches } from '@/lib/watches';
import { useDisplayCurrency } from '@/lib/prefs';
import { cn } from '@/lib/utils';

type Target = { offerId: string } | { game: string; category?: string; attributes?: Record<string, string> };

/**
 * "Price alert" button for a listing or a slice of a game's market. Opens a small panel to set
 * an optional target price in the viewer's display currency.
 */
export function WatchButton({ target, label = 'Price alert', className }: { target: Target; label?: string; className?: string }) {
  const { user } = useSession();
  const nav = useNavigate();
  const loc = useLocation();
  const list = useWatches(user?.id);
  const currency = useDisplayCurrency();
  const watch = findWatch(list, target);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  useEffect(() => setValue(watch?.targetCents != null ? (watch.targetCents / 100).toFixed(2) : ''), [watch?.id, watch?.targetCents]);

  const click = () => {
    if (!user) return nav(`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`);
    setError('');
    setOpen((o) => !o);
  };
  const cents = value.trim() ? Math.round(Number(value) * 100) : null;
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (cents != null && !(cents > 0)) return setError('Enter a price above zero, or leave it empty');
    setBusy(true);
    setError('');
    try {
      if (watch) await setTarget(watch.id, cents, currency);
      else await addWatch({ ...target, targetCents: cents, currency });
      setOpen(false);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    if (!watch) return;
    setBusy(true);
    try {
      await removeWatch(watch.id);
      setOpen(false);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const isOffer = 'offerId' in target;
  return (
    <div ref={box} className={cn('relative', className)}>
      <button
        type="button"
        className={cn('btn ghost inline-flex items-center gap-1.5', watch && 'border-released text-released')}
        aria-expanded={open}
        onClick={click}
        style={{ fontSize: 14 }}
      >
        {watch ? <BellRing className="size-4" /> : <BellPlus className="size-4" />}
        {watch ? (watch.targetCents != null ? `Alert at ${money(watch.targetCents, watch.currency)}` : 'Watching') : label}
      </button>
      {open && (
        <form
          onSubmit={save}
          className="absolute right-0 top-[calc(100%+6px)] z-40 grid w-[min(300px,calc(100vw-32px))] gap-2.5 rounded-xl border border-border bg-card p-3.5 text-left shadow-[0_18px_50px_-12px_rgba(22,32,46,0.28)]"
        >
          <b className="text-sm">{watch ? 'Edit price alert' : isOffer ? 'Watch this listing' : 'Watch this market'}</b>
          <label className="grid gap-1 text-xs text-muted-foreground">
            Alert me at or below ({currency})
            <input type="number" min="0.01" step="0.01" inputMode="decimal" placeholder="Any price drop" value={value} onChange={(e) => setValue(e.target.value)} style={{ height: 38 }} autoFocus />
          </label>
          <p className="m-0 text-xs text-muted-foreground">
            {isOffer
              ? 'Leave it empty to hear about any drop below today’s price. We also tell you when it’s back in stock.'
              : 'Leave it empty to hear whenever a cheaper offer is listed.'}{' '}
            Alerts arrive in your notifications and by email.
          </p>
          {error && <div className="alert" style={{ padding: '8px 10px', fontSize: 13 }}>{error}</div>}
          <div className="flex gap-2">
            <button className="btn" disabled={busy} style={{ flex: 1 }}>{watch ? 'Save' : 'Start watching'}</button>
            {watch && <button type="button" className="btn ghost" disabled={busy} onClick={stop}>Stop</button>}
          </div>
        </form>
      )}
    </div>
  );
}
