import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { BookmarkSimple as BookmarkPlus, Check } from '@phosphor-icons/react';
import { api } from '../api';
import { useSession } from '../session';
import { t } from '../i18n';

export interface SavedSearchParams {
  q?: string;
  game?: string;
  category?: string;
  maxPriceCents?: number;
  delivery?: 'instant' | 'manual';
  ownerVerified?: boolean;
  minRating?: number;
  attributes?: Record<string, string>;
}

/** Read the saveable filters off a market or game page URL. */
export function paramsFromUrl(p: URLSearchParams, fixed: Partial<SavedSearchParams> = {}): SavedSearchParams {
  const attributes = Object.fromEntries([...p].filter(([k, v]) => k.startsWith('attr.') && v).map(([k, v]) => [k.slice(5), v]));
  return {
    ...(p.get('q') ? { q: p.get('q')! } : {}),
    ...(p.get('game') ? { game: p.get('game')! } : {}),
    ...(p.get('category') ? { category: p.get('category')! } : {}),
    ...(p.get('maxPrice') ? { maxPriceCents: Number(p.get('maxPrice')) } : {}),
    ...(p.get('delivery') === 'instant' ? { delivery: 'instant' as const } : {}),
    ...(p.get('ownerVerified') === 'true' ? { ownerVerified: true } : {}),
    ...(p.get('minRating') ? { minRating: Number(p.get('minRating')) } : {}),
    ...(Object.keys(attributes).length ? { attributes } : {}),
    ...fixed,
  };
}

/** "Save this search": a daily digest of new listings matching the current filters. */
export function SaveSearchButton({ params, name }: { params: SavedSearchParams; name: string }) {
  const { user } = useSession();
  const nav = useNavigate();
  const loc = useLocation();
  const [state, setState] = useState<'idle' | 'busy' | 'saved' | string>('idle');
  if (!params.q && !params.game && !params.category) return null;
  if (state === 'saved')
    return (
      <span className="small inline-flex items-center gap-1 text-released" role="status">
        <Check className="size-4" /> {t('saved.done')} <Link to="/watchlist">{t('saved.manage')}</Link>
      </span>
    );
  return (
    <span className="inline-flex items-center gap-2">
      <button
        className="btn ghost"
        disabled={state === 'busy'}
        onClick={async () => {
          if (!user) return nav(`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`);
          setState('busy');
          try {
            await api('/me/saved-searches', { body: { name, params, frequency: 'daily' } });
            setState('saved');
          } catch (e: any) {
            setState(e.message);
          }
        }}
      >
        <BookmarkPlus className="size-4" /> {t('saved.save')}
      </button>
      {state !== 'idle' && state !== 'busy' && <span className="small" style={{ color: 'var(--disputed)' }}>{state}</span>}
    </span>
  );
}
