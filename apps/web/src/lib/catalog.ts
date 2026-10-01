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
export const CATEGORY_META: Record<string, { label: string; hint: string; protection: '72h' | '14d' }> = {
  accounts: { label: 'Accounts', hint: 'Owner-verified, with 14 days of insurance', protection: '14d' },
  currency: { label: 'Currency', hint: 'Gold, coins and points, delivered in-game', protection: '72h' },
  items: { label: 'Items', hint: 'Skins, gear and rare drops', protection: '72h' },
  boosting: { label: 'Boosting', hint: 'Rank, raids and progression by pros', protection: '72h' },
  'top-ups': { label: 'Top-ups', hint: 'Direct UID recharges for mobile games', protection: '72h' },
  keys: { label: 'Keys', hint: 'Steam, GOG and console activation keys', protection: '72h' },
  'gift-cards': { label: 'Gift cards', hint: 'Store credit for every platform', protection: '72h' },
  'video-games': { label: 'Video games', hint: 'Digital console games', protection: '72h' },
};
export const CATEGORY_ORDER = Object.keys(CATEGORY_META);
export const categoryLabel = (slug: string) => CATEGORY_META[slug]?.label ?? slug;

export const slugify = (game: string) =>
  game
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** A stable hue per name, so each game and seller keeps its colour everywhere. */
export function hueOf(name: string) {
  let h = 2166136261;
  for (const c of name) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0) % 360;
}

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
  if (mode === 'auto') return 'Instant';
  const h = Number(hours ?? 2);
  if (h < 1) return `~${Math.max(5, Math.round(h * 60))} min`;
  if (h < 48) return `~${Math.round(h)} h`;
  return `~${Math.round(h / 24)} days`;
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
