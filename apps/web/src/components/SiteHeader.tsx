import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChatCentered as MessageSquare, ClockCounterClockwise, Eye, MagnifyingGlass as Search, TrendUp, X } from '@phosphor-icons/react';
import { BrandLockup } from './Brand';
import { useSession } from '../session';
import { NotificationBell } from './NotificationBell';
import { AccountMenu, PrefsMenu } from './HeaderMenus';
import { categoryLabel, loadGames, popular, slugify, type GameEntry } from '@/lib/catalog';
import { clearSearches, recordSearch, removeSearch, useRecent } from '@/lib/recent';
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

  const recent = useRecent();
  const typed = q.trim();
  const matches = useMemo(() => {
    const t = typed.toLowerCase();
    if (!t) return [];
    return games.filter((g) => g.game.toLowerCase().includes(t) || g.game.toLowerCase().split(/\W+/).some((w) => w.startsWith(t))).slice(0, 6);
  }, [typed, games]);
  const trending = popular(games, 5);

  const go = (path: string, search?: string) => {
    if (search) recordSearch(search);
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
        if (active >= 0 && matches[active]) go(`/games/${slugify(matches[active]!.game)}`, matches[active]!.game);
        else if (typed) go(`/market?q=${encodeURIComponent(typed)}`, typed);
      }}
    >
      <Search className={cn('pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted-foreground', big ? 'start-4 size-5' : 'start-3 size-4')} aria-hidden />
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
        style={{ paddingInlineStart: big ? 46 : 36, height: big ? 52 : 40, fontSize: big ? 16 : 15 }}
      />
      {open && typed && matches.length > 0 && (
        <div id={listId} role="listbox" aria-label={t('search.games')} className="sx-panel">
          {matches.map((g, i) => (
            <button
              key={g.game}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={active === i}
              tabIndex={-1}
              type="button"
              onMouseEnter={() => setActive(i)}
              onClick={() => go(`/games/${slugify(g.game)}`, g.game)}
              className={cn('sx-option', active === i && 'on')}
            >
              <span className="flex-1">{g.game}</span>
              <span className="small muted">{t('offers.count', { count: g.offers })}</span>
            </button>
          ))}
          <button type="submit" className="sx-option sx-all">
            <Search className="size-4 text-muted-foreground" aria-hidden /> {t('search.all', { q: typed })}
          </button>
        </div>
      )}
      {open && !typed && (trending.length > 0 || recent.searches.length > 0 || recent.browsed.length > 0) && (
        <div className="sx-panel sx-idle" aria-label={t('search.suggestions')} role="region">
          {trending.length > 0 && (
            <section>
              <h3 className="sx-h"><TrendUp className="size-4" aria-hidden /> {t('search.trending')}</h3>
              <div className="sx-chips">
                {trending.map((g) => <Link key={g.game} to={`/games/${slugify(g.game)}`} className="sx-chip" onClick={() => setOpen(false)}>{g.game}</Link>)}
              </div>
            </section>
          )}
          {recent.searches.length > 0 && (
            <section>
              <div className="flex items-center justify-between">
                <h3 className="sx-h"><ClockCounterClockwise className="size-4" aria-hidden /> {t('search.recent')}</h3>
                <button type="button" className="sx-clear" onClick={clearSearches}>{t('search.clearAll')}</button>
              </div>
              <div className="sx-chips">
                {recent.searches.map((r) => (
                  <span key={r} className="sx-chip sx-chip-x">
                    <Link to={`/market?q=${encodeURIComponent(r)}`} onClick={() => setOpen(false)}>{r}</Link>
                    <button type="button" aria-label={t('search.remove', { q: r })} onClick={() => removeSearch(r)}><X className="size-3" aria-hidden /></button>
                  </span>
                ))}
              </div>
            </section>
          )}
          {recent.browsed.length > 0 && (
            <section>
              <h3 className="sx-h"><Eye className="size-4" aria-hidden /> {t('search.browsed')}</h3>
              <ul className="sx-browsed">
                {recent.browsed.slice(0, 3).map((b) => (
                  <li key={b.game}>
                    <Link to={`/games/${slugify(b.game)}`} className="sx-game" onClick={() => setOpen(false)}>{b.game}</Link>
                    {b.categories.length > 0 && <span className="small muted">{t('search.in')}</span>}
                    {b.categories.map((c) => <Link key={c} to={`/games/${slugify(b.game)}/${c}`} className="sx-chip" onClick={() => setOpen(false)}>{categoryLabel(c)}</Link>)}
                  </li>
                ))}
              </ul>
            </section>
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
                <MessageSquare className="size-[18px]" />
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
