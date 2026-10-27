import { useCallback, useEffect, useState } from 'react';
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
  const load = useCallback(() => api<{ version: string }>('/legal/terms').then((d) => (setVersion(d.version), d.version)), []);
  useEffect(() => {
    let live = true;
    api<{ version: string }>('/legal/terms')
      .then((d) => live && setVersion(d.version))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  const onStale = useCallback(async () => {
    await load().catch(() => null);
    setStale(true);
  }, [load]);
  return { version, stale, onStale, accepted: () => setStale(false) };
}
