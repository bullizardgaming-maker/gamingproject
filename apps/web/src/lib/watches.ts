import { useEffect, useSyncExternalStore } from 'react';
import { api } from '../api';

/** The signed-in buyer's watchlist, shared by every watch button on the page. */
export interface Watch {
  id: string;
  kind: 'offer' | 'game';
  currency: string;
  targetCents: number | null;
  createdAt: string;
  currentCents: number | null;
  startCents: number | null;
  available: boolean;
  reached: boolean;
  offer?: { id: string; title: string; game: string; category_slug: string; seller_name: string; attributes?: Record<string, string> } | null;
  game?: string;
  category?: string | null;
  attributes?: Record<string, string>;
  cheapest?: { id: string; title: string; seller_name: string } | null;
}

let watches: Watch[] | null = null;
let owner: string | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l));

export function reloadWatches() {
  loading = api<Watch[]>('/me/watches')
    .then((w) => {
      watches = w;
      emit();
    })
    .catch(() => {
      watches = [];
      emit();
    })
    .finally(() => (loading = null));
  return loading;
}

/** Loads the list once per signed-in user; null while loading or signed out. */
export function useWatches(userId: string | null | undefined) {
  useEffect(() => {
    if (!userId) return;
    if (owner !== userId) {
      owner = userId;
      watches = null;
      emit();
    }
    if (watches === null && !loading) reloadWatches();
  }, [userId]);
  const list = useSyncExternalStore(subscribe, () => watches);
  return userId ? list : null;
}

export async function addWatch(body: { offerId?: string; game?: string; category?: string; attributes?: Record<string, string>; targetCents?: number | null; currency?: string }) {
  const w = await api<Watch>('/me/watches', { body });
  watches = [w, ...(watches ?? [])];
  emit();
  return w;
}

export async function setTarget(id: string, targetCents: number | null, currency?: string) {
  const w = await api<Watch>(`/me/watches/${id}`, { method: 'PATCH', body: { targetCents, currency } });
  watches = (watches ?? []).map((x) => (x.id === id ? w : x));
  emit();
  return w;
}

export async function removeWatch(id: string) {
  await api(`/me/watches/${id}`, { method: 'DELETE' });
  watches = (watches ?? []).filter((x) => x.id !== id);
  emit();
}

const same = (a: Record<string, string> = {}, b: Record<string, string> = {}) => {
  const ka = Object.keys(a).filter((k) => a[k]);
  const kb = Object.keys(b).filter((k) => b[k]);
  return ka.length === kb.length && ka.every((k) => String(b[k]).toLowerCase() === String(a[k]).toLowerCase());
};

/** The watch matching a listing, or a game slice (game + category + fields), if any. */
export function findWatch(list: Watch[] | null, q: { offerId?: string; game?: string; category?: string | null; attributes?: Record<string, string> }) {
  if (!list) return undefined;
  if (q.offerId) return list.find((w) => w.kind === 'offer' && w.offer?.id === q.offerId);
  return list.find(
    (w) => w.kind === 'game' && w.game?.toLowerCase() === q.game?.toLowerCase() && (w.category ?? null) === (q.category || null) && same(w.attributes, q.attributes),
  );
}
