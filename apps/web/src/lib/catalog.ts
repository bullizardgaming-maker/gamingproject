import { t, type MessageKey } from '../i18n';
import { useEffect, useState } from 'react';
import { api } from '../api';

/** A game in the directory, with its live listing counts per category. */
export interface GameEntry {
  game: string;
  offers: number;
  sellers: number;
  min_price_cents: number;
  instant: number;
  categories: Array<{ slug: string; count: number }>;
}

/** Display order, short labels and one-line hints for the catalogue's categories. */
const cat = (slug: string, protection: '72h' | '14d') => ({
  get label() {
    return t(`cat.${slug}` as MessageKey);
  },
  get hint() {
    return t(`cat.${slug}.hint` as MessageKey);
  },
  protection,
});
export const CATEGORY_META: Record<string, { label: string; hint: string; protection: '72h' | '14d' }> = {
  accounts: cat('accounts', '14d'),
  currency: cat('currency', '72h'),
  items: cat('items', '72h'),
  boosting: cat('boosting', '72h'),
  'top-ups': cat('top-ups', '72h'),
  keys: cat('keys', '72h'),
  'gift-cards': cat('gift-cards', '72h'),
  'video-games': cat('video-games', '72h'),
};
export const CATEGORY_ORDER = Object.keys(CATEGORY_META);

/**
 * Launch phases: the API says which categories are open (GET /categories `open`); closed ones are
 * hidden everywhere until staff move the phase forward. All are shown until the answer arrives.
 */
let openSlugs: Set<string> | null = null;
let categoriesLoading: Promise<void> | null = null;
const catListeners = new Set<() => void>();
export function loadCategories() {
  categoriesLoading ??= api<Array<{ slug: string; open?: boolean }>>('/categories')
    .then((rows) => {
      openSlugs = new Set(rows.filter((c) => c.open !== false).map((c) => c.slug));
      catListeners.forEach((l) => l());
    })
    .catch(() => {
      categoriesLoading = null;
    });
  return categoriesLoading;
}
export const isCategoryOpen = (slug: string) => !openSlugs || openSlugs.has(slug);
/** CATEGORY_ORDER without the categories closed in the current launch phase; re-renders once known. */
export function useCategoryOrder(): string[] {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    catListeners.add(l);
    loadCategories();
    return () => void catListeners.delete(l);
  }, []);
  return CATEGORY_ORDER.filter(isCategoryOpen);
}
export const categoryLabel = (slug: string) => CATEGORY_META[slug]?.label ?? slug;

export const slugify = (game: string) =>
  game
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

export const initials = (name: string) =>
  name
    .replace(/[^A-Za-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?';

/** "Instant", "~15 min", "~2 h", "~2 days": a listing's typical delivery time. */
export function deliveryLabel(mode: string, hours: number | null | undefined) {
  if (mode === 'auto') return t('delivery.instant');
  const h = Number(hours ?? 2);
  if (h < 1) return t('delivery.minutes', { n: Math.max(5, Math.round(h * 60)) });
  if (h < 48) return t('delivery.hours', { n: Math.round(h) });
  return t('delivery.days', { n: Math.round(h / 24) });
}

// The directory changes slowly: load it once per page view and share it between components.
let cache: Promise<GameEntry[]> | null = null;
export function loadGames(force = false) {
  if (!cache || force) cache = api<GameEntry[]>('/catalog/games').catch((e) => ((cache = null), Promise.reject(e)));
  return cache;
}

export function useGames() {
  const [games, setGames] = useState<GameEntry[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    loadGames()
      .then((g) => live && setGames(g))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, []);
  return { games, error };
}

/** Most-listed games first: what the home page and header call "popular". */
export const popular = (games: GameEntry[], n: number) => [...games].sort((a, b) => b.offers - a.offers || a.game.localeCompare(b.game)).slice(0, n);
