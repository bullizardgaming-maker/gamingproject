import { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * Feature switches from `GET /features`. The Merchant API (Developers page, API keys, SDK links)
 * is hidden at launch and switched on server-side later (MERCHANT_API_ENABLED); until the answer
 * arrives the app assumes "off", so nothing flashes in.
 */
export interface Features {
  merchantApi: boolean;
  sandbox: boolean;
}
let features: Features = { merchantApi: false, sandbox: false };
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
export function loadFeatures() {
  loading ??= api<Features>('/features')
    .then((f) => {
      features = { merchantApi: !!f.merchantApi, sandbox: !!f.sandbox };
      listeners.forEach((l) => l());
    })
    .catch(() => {
      loading = null;
    });
  return loading;
}
export const getFeatures = () => features;
export function useFeatures(): Features {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    loadFeatures();
    return () => void listeners.delete(l);
  }, []);
  return features;
}
