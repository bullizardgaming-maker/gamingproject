import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { MessageSquare, Search } from 'lucide-react';
import { BrandLockup } from './Brand';
import { useSession } from '../session';
import { NotificationBell } from './NotificationBell';
import { GameArt } from './CatalogUi';
import { AccountMenu, PrefsMenu } from './HeaderMenus';
import { loadGames, popular, slugify, type GameEntry } from '@/lib/catalog';
import { cn } from '@/lib/utils';
import { t } from '../i18n';

/** Search box with game suggestions: Enter searches listings, picking a game opens its page. */
export function GameSearch({ big = false, autoFocus = false }: { big?: boolean; autoFocus?: boolean }) {
  const listId = useId();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [games, setGames] = useState<GameEntry[]>([]);
  const [active, setActive] = useState(-1);
  const box = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (open && !games.length) loadGames().then(setGames).catch(() => {});
  }, [open, games.length]);
  useEffect(() => {
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const matches = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return popular(games, 6);
    return games.filter((g) => g.game.toLowerCase().includes(t) || g.game.toLowerCase().split(/\W+/).some((w) => w.startsWith(t))).slice(0, 6);
  }, [q, games]);

  const go = (path: string) => {
    setOpen(false);
    setQ('');
    nav(path);
  };

  return (
    <form
      ref={box}
      role="search"
      className="relative w-full"
      onSubmit={(e) => {
        e.preventDefault();
        if (active >= 0 && matches[active]) go(`/games/${slugify(matches[active]!.game)}`);
        else if (q.trim()) go(`/market?q=${encodeURIComponent(q.trim())}`);
      }}
    >
      <Search className={cn('pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted-foreground', big ? 'start-4 size-5' : 'start-3 size-4')} />
      <input
        name="search"
        type="search"
        autoComplete="off"
        autoFocus={autoFocus}
        aria-label={t('search.label')}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open && matches.length > 0}
        aria-controls={listId}
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        placeholder={big ? t('search.big') : t('search.small')}
        value={q}
        onFocus={() => setOpen(true)}
        onChange={(e) => (setQ(e.target.value), setOpen(true), setActive(-1))}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') (e.preventDefault(), setActive((a) => Math.min(a + 1, matches.length - 1)));
          if (e.key === 'ArrowUp') (e.preventDefault(), setActive((a) => Math.max(a - 1, -1)));
          if (e.key === 'Escape') (setOpen(false), setActive(-1));
        }}
        style={{ paddingInlineStart: big ? 46 : 36, height: big ? 56 : 40, borderRadius: big ? 14 : 10, fontSize: big ? 17 : 15 }}
        className="shadow-[0_1px_0_rgba(22,32,46,.04)]"
      />
      {open && matches.length > 0 && (
        <div id={listId} role="listbox" aria-label={q.trim() ? t('search.games') : t('search.popular')} className="absolute inset-x-0 top-[calc(100%+6px)] z-50 overflow-hidden rounded-xl border border-border bg-card shadow-[0_18px_50px_-12px_rgba(22,32,46,0.28)]">
          <div aria-hidden="true" className="px-3 pb-1 pt-2.5 font-mono text-[11px] uppercase tracking-[0.1em] text-muted-foreground">{q.trim() ? t('search.games') : t('search.popular')}</div>
          {matches.map((g, i) => (
            <button
              key={g.game}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={active === i}
              tabIndex={-1}
              type="button"
              onMouseEnter={() => setActive(i)}
              onClick={() => go(`/games/${slugify(g.game)}`)}
              className={cn('flex w-full cursor-pointer items-center gap-3 border-0 bg-transparent px-3 py-2 text-start', active === i && 'bg-secondary')}
            >
              <GameArt game={g.game} size="sm" className="h-8 w-12 shrink-0 rounded-md" />
              <span className="flex-1 text-sm font-medium">{g.game}</span>
              <span className="font-mono text-xs text-muted-foreground">{t('offers.count', { count: g.offers })}</span>
            </button>
          ))}
          {q.trim() && (
            <button type="submit" className="flex w-full cursor-pointer items-center gap-2 border-0 border-t border-border bg-transparent px-3 py-2.5 text-start text-sm hover:bg-secondary">
              <Search className="size-4 text-muted-foreground" /> {t('search.all', { q: q.trim() })}
            </button>
          )}
        </div>
      )}
    </form>
  );
}

export function SiteHeader() {
  const { user } = useSession();
  return (
    <header className="topbar site-header">
      <div className="shell shell-wide header-main">
        <Link to="/" className="brand" aria-label={t('brand.home')}><BrandLockup size={19} /></Link>
        <div className="header-search"><GameSearch /></div>
        <div className="who">
          <PrefsMenu />
          {user ? (
            <>
              <Link to="/messages" aria-label={t('nav.messages')} title={t('nav.messages')} className="icon-link">
                <MessageSquare className="size-[18px]" strokeWidth={1.8} />
              </Link>
              <NotificationBell />
              <AccountMenu />
            </>
          ) : (
            <Link className="btn" to="/login">{t('nav.signIn')}</Link>
          )}
        </div>
      </div>
    </header>
  );
}
