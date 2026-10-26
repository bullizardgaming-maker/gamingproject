import { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * Round 23e (item 9): the Terms version loaded with the page. Checkout sends this one (not whatever is current at click
 * time), so an update while the buyer was reading is caught by the API (409 terms_stale) instead of silently accepted.
 */
export function useTermsVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api<{ version: string }>('/legal/terms')
      .then((d) => live && setVersion(d.version))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return version;
}
