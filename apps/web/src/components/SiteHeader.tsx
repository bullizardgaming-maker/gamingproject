import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { Heart, LayoutGrid, Moon, Search, ShieldCheck, Sun } from 'lucide-react';
import { useSession } from '../session';
import { NotificationBell } from './NotificationBell';
import { CATEGORY_ICON, GameArt } from './CatalogUi';
import { CATEGORY_META, CATEGORY_ORDER, loadGames, popular, slugify, type GameEntry } from '@/lib/catalog';
import { cn } from '@/lib/utils';
import { LOCALES, setLocale, t, useLocale, type Locale } from '../i18n';
import { DISPLAY_CURRENCIES, resolvedTheme, setCurrency, setTheme, useDisplayCurrency, useTheme, type DisplayCurrency } from '@/lib/prefs';

/** Search box with game suggestions: Enter searches listings, picking a game opens its page. */
export function GameSearch({ big = false, autoFocus = false }: { big?: boolean; autoFocus?: boolean }) {
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
        placeholder={big ? t('search.big') : t('search.small')}
        value={q}
        onFocus={() => setOpen(true)}
        onChange={(e) => (setQ(e.target.value), setOpen(true), setActive(-1))}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') (e.preventDefault(), setActive((a) => Math.min(a + 1, matches.length - 1)));
          if (e.key === 'ArrowUp') (e.preventDefault(), setActive((a) => Math.max(a - 1, -1)));
          if (e.key === 'Escape') setOpen(false);
        }}
        style={{ paddingInlineStart: big ? 46 : 36, height: big ? 56 : 40, borderRadius: big ? 14 : 10, fontSize: big ? 17 : 15 }}
        className="shadow-[0_1px_0_rgba(22,32,46,.04)]"
      />
      {open && matches.length > 0 && (
        <div className="absolute inset-x-0 top-[calc(100%+6px)] z-50 overflow-hidden rounded-xl border border-border bg-card shadow-[0_18px_50px_-12px_rgba(22,32,46,0.28)]">
          <div className="px-3 pb-1 pt-2.5 font-mono text-[11px] uppercase tracking-[0.1em] text-muted-foreground">{q.trim() ? t('search.games') : t('search.popular')}</div>
          {matches.map((g, i) => (
            <button
              key={g.game}
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

/** Display currency and light/dark theme, remembered in this browser. */
function ViewPrefs() {
  useTheme();
  const cur = useDisplayCurrency();
  const lang = useLocale();
  const dark = resolvedTheme() === 'dark';
  return (
    <div className="flex items-center gap-1.5">
      <select aria-label={t('prefs.language')} title={t('prefs.language')} value={lang} onChange={(e) => setLocale(e.target.value as Locale)} className="pref-select">
        {(Object.keys(LOCALES) as Locale[]).map((l) => (
          <option key={l} value={l} lang={l}>{l === lang ? LOCALES[l].short : LOCALES[l].name}</option>
        ))}
      </select>
      <select
        aria-label={t('prefs.currency')}
        title={t('prefs.currency')}
        value={cur}
        onChange={(e) => setCurrency(e.target.value as DisplayCurrency)}
        className="pref-select"
      >
        {DISPLAY_CURRENCIES.map((c) => <option key={c}>{c}</option>)}
      </select>
      <button
        type="button"
        aria-label={dark ? t('prefs.light') : t('prefs.dark')}
        title={dark ? t('prefs.light') : t('prefs.dark')}
        onClick={() => setTheme(dark ? 'light' : 'dark')}
        className="grid size-10 cursor-pointer place-items-center rounded-lg border border-border bg-transparent text-foreground transition-colors hover:border-foreground"
      >
        {dark ? <Sun className="size-[18px]" strokeWidth={1.8} /> : <Moon className="size-[18px]" strokeWidth={1.8} />}
      </button>
    </div>
  );
}

export function SiteHeader() {
  const { user, signOut } = useSession();
  const { pathname, search } = useLocation();
  const cat = new URLSearchParams(search).get('category');
  return (
    <header className="topbar site-header">
      <div className="shell header-main">
        <Link to="/" className="brand"><span className="brand-mark" aria-hidden />Bullizard</Link>
        <div className="header-search"><GameSearch /></div>
        <nav className="nav header-links" aria-label={t('nav.main')}>
          <NavLink to="/market" end>{t('nav.market')}</NavLink>
          <NavLink to="/requests">{t('nav.requests')}</NavLink>
          {user && <NavLink to="/orders">{t('nav.orders')}</NavLink>}
          <NavLink to="/sell">{t('nav.sell')}</NavLink>
          {user && user.role !== 'user' && <NavLink to="/admin">{t('nav.operations')}</NavLink>}
        </nav>
        <div className="who">
          <ViewPrefs />
          {user ? (
            <>
              <Link to="/watchlist" aria-label={t('nav.watchlist')} title={t('nav.watchlist')} className="grid size-10 place-items-center rounded-lg border border-border text-foreground no-underline transition-colors hover:border-foreground">
                <Heart className="size-[18px]" strokeWidth={1.8} />
              </Link>
              <NotificationBell />
              <Link to="/account" className="small header-account">
                <span className="email">{user.display_name} · </span>{t('nav.level', { n: user.kyc_tier })}
              </Link>
              <button className="btn ghost" onClick={signOut}>{t('nav.signOut')}</button>
            </>
          ) : (
            <Link className="btn" to="/login">{t('nav.signIn')}</Link>
          )}
        </div>
      </div>
      <div className="header-cats">
        <div className="shell">
          <nav aria-label={t('nav.categories')} className="flex items-center gap-1 overflow-x-auto">
            <NavLink to="/games" className={({ isActive }) => cn('cat-link', isActive && 'on')}>
              <LayoutGrid className="size-4" /> {t('nav.allGames')}
            </NavLink>
            {CATEGORY_ORDER.map((slug) => {
              const Icon = CATEGORY_ICON[slug]!;
              return (
                <Link key={slug} to={`/market?category=${slug}`} className={cn('cat-link', pathname === '/market' && cat === slug && 'on')}>
                  <Icon className="size-4" /> {CATEGORY_META[slug]!.label}
                </Link>
              );
            })}
            <span className="ms-auto hidden items-center gap-1.5 whitespace-nowrap ps-4 text-xs text-muted-foreground xl:inline-flex">
              <ShieldCheck className="size-4 text-released" /> {t('nav.escrowNote')}
            </span>
          </nav>
        </div>
      </div>
    </header>
  );
}
