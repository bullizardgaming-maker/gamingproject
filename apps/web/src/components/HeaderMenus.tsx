import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CaretDown, Globe, GlobeHemisphereEast, GlobeHemisphereWest, Heart, X, SquaresFour as LayoutGrid, SignOut as LogOut, Moon, Package, GearSix as Settings, Storefront as Store, Wallet, Sun, Wrench } from '@phosphor-icons/react';
import { AnimatePresence, motion } from 'motion/react';
import { useSession } from '../session';
import { LOCALES, setLocale, t, useLocale, type Locale } from '../i18n';
import { DISPLAY_CURRENCIES, resolvedTheme, setCurrency, setTheme, useDisplayCurrency, useTheme, type DisplayCurrency } from '@/lib/prefs';
import { REGIONS, getRegion, isRegion, regionLabel, setRegion, useRegion, type Region } from '@/lib/regions';
import { api } from '../api';

/** Open/close state for a header popover: closes on outside click and Escape (focus goes back to the button). */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) {
        setOpen(false);
        if (e instanceof KeyboardEvent) button.current?.focus();
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  const focusPanel = useCallback((el: HTMLDivElement | null) => el?.focus({ preventScroll: true }), []);
  return { open, setOpen, ref, button, focusPanel };
}

const panelMotion = {
  initial: { opacity: 0, y: -6, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: -6, scale: 0.98 },
  transition: { duration: 0.16, ease: 'easeOut' as const },
};

const REGION_ICON: Record<Region, typeof Globe> = { asia: GlobeHemisphereEast, middle_east: GlobeHemisphereEast, europe: GlobeHemisphereEast, america: GlobeHemisphereWest, global: Globe };

/**
 * The top bar's place control (CEO, 8 Nov): the visitor's region (never a country, Round 29), and inside it the
 * language, the currency prices are shown in and the theme. Changing the region needs nothing else: no phone number.
 * A signed-in account's region is saved on the account (PUT /me/region).
 */
export function PrefsMenu() {
  useTheme();
  const { user, refresh } = useSession();
  const cur = useDisplayCurrency();
  const lang = useLocale();
  const region = useRegion();
  const dark = resolvedTheme() === 'dark';
  const p = usePopover();
  const [draft, setDraft] = useState({ region, lang, cur });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // The account's saved region wins over this browser's guess.
  useEffect(() => {
    if (isRegion(user?.region) && user.region !== getRegion()) setRegion(user.region);
  }, [user?.region]);
  useEffect(() => {
    if (p.open) (setDraft({ region, lang, cur }), setError(''));
  }, [p.open]);
  const Icon = REGION_ICON[region];
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      if (user && draft.region !== (user.region ?? 'global')) {
        await api('/me/region', { method: 'PUT', body: { region: draft.region } });
        await refresh();
      }
      setRegion(draft.region);
      setCurrency(draft.cur);
      if (draft.lang !== lang) setLocale(draft.lang);
      p.setOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="relative" ref={p.ref}>
      <button ref={p.button} type="button" className="prefs-pill" aria-haspopup="dialog" aria-expanded={p.open} aria-label={t('loc.button', { region: regionLabel(region), lang: LOCALES[lang].name, cur })} title={t('loc.title')} onClick={() => p.setOpen((o) => !o)}>
        <Icon className="size-[18px]" aria-hidden />
        <span className="prefs-region" data-testid="prefs-region">{regionLabel(region)}</span>
        <span className="prefs-sep" aria-hidden />
        <span className="prefs-cur" data-testid="prefs-currency">{cur}</span>
        <CaretDown className="size-3.5 prefs-caret" aria-hidden />
      </button>
      <AnimatePresence>
        {p.open && (
          <motion.div role="dialog" aria-labelledby="loc-title" tabIndex={-1} ref={p.focusPanel} {...panelMotion} className="hdr-panel loc-panel">
            <div className="loc-head">
              <h2 id="loc-title">{t('loc.title')}</h2>
              <button type="button" className="loc-x" aria-label={t('loc.close')} onClick={() => p.setOpen(false)}><X className="size-4" aria-hidden /></button>
            </div>
            <div className="loc-row">
              <label htmlFor="loc-region">{t('region.label')}</label>
              <div>
                <select id="loc-region" value={draft.region} onChange={(e) => setDraft((d) => ({ ...d, region: e.target.value as Region }))}>
                  {REGIONS.map((r) => <option key={r} value={r}>{regionLabel(r)}</option>)}
                </select>
                <p className="loc-hint">{t('loc.regionHint')}</p>
              </div>
            </div>
            <div className="loc-row">
              <label htmlFor="loc-lang">{t('prefs.language')}</label>
              <select id="loc-lang" value={draft.lang} onChange={(e) => setDraft((d) => ({ ...d, lang: e.target.value as Locale }))}>
                {(Object.keys(LOCALES) as Locale[]).map((l) => <option key={l} value={l} lang={l}>{LOCALES[l].name}</option>)}
              </select>
            </div>
            <div className="loc-row">
              <label htmlFor="loc-cur">{t('loc.currency')}</label>
              <select id="loc-cur" value={draft.cur} onChange={(e) => setDraft((d) => ({ ...d, cur: e.target.value as DisplayCurrency }))}>
                {DISPLAY_CURRENCIES.map((c) => <option key={c} value={c}>{t(`loc.cur.${c}`)}</option>)}
              </select>
            </div>
            <div className="loc-row">
              <span id="loc-theme">{t('prefs.theme')}</span>
              <div className="seg-row" role="group" aria-labelledby="loc-theme">
                <button type="button" aria-pressed={dark} aria-label={t('prefs.dark')} onClick={() => setTheme('dark')}><Moon className="size-4" aria-hidden /> {t('prefs.themeDark')}</button>
                <button type="button" aria-pressed={!dark} aria-label={t('prefs.light')} onClick={() => setTheme('light')}><Sun className="size-4" aria-hidden /> {t('prefs.themeLight')}</button>
              </div>
            </div>
            {error && <div className="alert" role="alert">{error}</div>}
            <div className="loc-actions">
              <button type="button" className="btn ghost" onClick={() => p.setOpen(false)}>{t('loc.cancel')}</button>
              <button type="button" className="btn" disabled={busy} onClick={() => void save()}>{t('loc.save')}</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const initials = (n = '?') => n.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

/** The avatar menu: everything that used to crowd the top bar (orders, shop, watchlist…). */
export function AccountMenu() {
  const { user, signOut } = useSession();
  const p = usePopover();
  if (!user) return null;
  const close = () => p.setOpen(false);
  return (
    <div className="relative" ref={p.ref}>
      <button ref={p.button} type="button" className="avatar-btn" aria-haspopup="menu" aria-expanded={p.open} aria-label={t('menu.account')} onClick={() => p.setOpen((o) => !o)}>
        {initials(user.display_name)}
      </button>
      <AnimatePresence>
        {p.open && (
          <motion.div role="menu" aria-label={t('menu.account')} tabIndex={-1} ref={p.focusPanel} {...panelMotion} className="hdr-panel menu-panel">
            <div className="menu-who">
              <b className="truncate">{user.display_name}</b>
              <span className="small muted">{t('nav.level', { n: user.kyc_tier })}</span>
            </div>
            <Link role="menuitem" to="/orders" onClick={close}><Package className="size-4" aria-hidden /> {t('nav.orders')}</Link>
            <Link role="menuitem" to="/sell" onClick={close}><Store className="size-4" aria-hidden /> {t('menu.shop')}</Link>
            <Link role="menuitem" to="/wallet" onClick={close}><Wallet className="size-4" aria-hidden /> {t('wallet.title')}</Link>
            <Link role="menuitem" to="/watchlist" onClick={close}><Heart className="size-4" aria-hidden /> {t('nav.watchlist')}</Link>
            <Link role="menuitem" to="/market" onClick={close}><LayoutGrid className="size-4" aria-hidden /> {t('menu.browse')}</Link>
            {user.role !== 'user' && <Link role="menuitem" to="/admin" onClick={close}><Wrench className="size-4" aria-hidden /> {t('nav.operations')}</Link>}
            <Link role="menuitem" to="/account" onClick={close}><Settings className="size-4" aria-hidden /> {t('menu.settings')}</Link>
            <button role="menuitem" type="button" className="menu-out" onClick={() => (close(), signOut())}><LogOut className="size-4" aria-hidden /> {t('nav.signOut')}</button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
