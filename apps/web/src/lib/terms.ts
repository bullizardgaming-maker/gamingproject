import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';

/**
 * Round 23e (item 9): the Terms version loaded with the page. Checkout sends this one (not whatever is current at click
 * time), so an update while the buyer was reading is caught by the API (409 terms_stale) instead of silently accepted.
 * Round 23f (item 3): on terms_stale the page calls `onStale()`: the current version is fetched again (the API serves it
 * uncached) and `stale` asks the buyer to read and accept it before the order is sent again.
 */
export function useTermsVersion() {
  const [version, setVersion] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  /** The page's own load of the version (a click can come before it answers). */
  const first = useRef<Promise<string | null> | null>(null);
  const load = useCallback(() => api<{ version: string }>('/legal/terms').then((d) => (setVersion(d.version), d.version)), []);
  useEffect(() => {
    let live = true;
    first.current = api<{ version: string }>('/legal/terms')
      .then((d) => (live && setVersion(d.version), d.version))
      .catch(() => null);
    return () => {
      live = false;
    };
  }, []);
  const onStale = useCallback(async () => {
    await load().catch(() => null);
    setStale(true);
  }, [load]);
  /** The version loaded with the page, waiting for that first load if Buy is pressed before it answers. */
  const ready = useCallback(async () => version ?? (await first.current) ?? null, [version]);
  return { version, stale, onStale, ready, accepted: () => setStale(false) };
}
