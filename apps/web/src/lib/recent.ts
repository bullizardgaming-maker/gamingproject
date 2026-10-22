import { useSyncExternalStore } from 'react';

/**
 * This viewer's recent searches and recently browsed games (per browser, a convenience only).
 * Storage may be blocked or empty; everything still works without it.
 */
const SEARCH_KEY = 'bz.recent.searches';
const BROWSE_KEY = 'bz.recent.browsed';
type Browsed = { game: string; categories: string[]; at: number };

const listeners = new Set<() => void>();
const read = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};
const write = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage blocked: keep going */
  }
  snapshot = load();
  listeners.forEach((l) => l());
};
const load = () => ({ searches: read<string[]>(SEARCH_KEY, []), browsed: read<Browsed[]>(BROWSE_KEY, []) });
let snapshot = load();

export function recordSearch(q: string) {
  const v = q.trim();
  if (!v) return;
  write(SEARCH_KEY, [v, ...snapshot.searches.filter((s) => s.toLowerCase() !== v.toLowerCase())].slice(0, 6));
}
export const removeSearch = (q: string) => write(SEARCH_KEY, snapshot.searches.filter((s) => s !== q));
export const clearSearches = () => write(SEARCH_KEY, []);

export function recordBrowse(game: string, category?: string) {
  const prev = snapshot.browsed.find((b) => b.game === game);
  const categories = category ? [category, ...(prev?.categories ?? []).filter((c) => c !== category)].slice(0, 3) : prev?.categories ?? [];
  write(BROWSE_KEY, [{ game, categories, at: Date.now() }, ...snapshot.browsed.filter((b) => b.game !== game)].slice(0, 6));
}

export const useRecent = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => snapshot,
    () => snapshot,
  );
