import { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * Feature switches from `GET /features`. Until the answer arrives the app assumes "off", so nothing flashes in.
 */
export interface Features {
  sandbox: boolean;
  /** Legal (Oct 24): the Terms version in force and, during the 14-day notice, the change that is coming. */
  legal: { tosVersion: string | null; notice: { version: string; effective_at?: string; effectiveAt?: string } | null };
  /** Kill switches (Ops → Controls) and beta limits. */
  paused: { withdrawals: boolean; orders: boolean; chat: boolean; signups: boolean; message: string | null };
  limits: { maxOrderCents: number; maxWithdrawalDayCents: number; newAccountDays: number; newAccountMaxOrderCents: number } | null;
}
const NO_PAUSE = { withdrawals: false, orders: false, chat: false, signups: false, message: null };
let features: Features = { sandbox: false, legal: { tosVersion: null, notice: null }, paused: NO_PAUSE, limits: null };
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
export function loadFeatures() {
  loading ??= api<Features>('/features')
    .then((f) => {
      features = { sandbox: !!f.sandbox, legal: f.legal ?? { tosVersion: null, notice: null }, paused: f.paused ?? NO_PAUSE, limits: f.limits ?? null };
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

/** The help centre is drafted, not published yet (CEO, Round 24b): no links to it, and /help sends people to support. */
export const HELP_CENTER = false;
