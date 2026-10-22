import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Globe, Heart, LayoutGrid, LogOut, Moon, Package, Settings, ShoppingCart, Store, Sun, Wrench } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { cartCount, useCart } from '@/lib/cart';
import { useSession } from '../session';
import { LOCALES, setLocale, t, useLocale, type Locale } from '../i18n';
import { DISPLAY_CURRENCIES, resolvedTheme, setCurrency, setTheme, useDisplayCurrency, useTheme } from '@/lib/prefs';

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

/** Language, display currency and theme in one control. */
export function PrefsMenu() {
  useTheme();
  const cur = useDisplayCurrency();
  const lang = useLocale();
  const dark = resolvedTheme() === 'dark';
  const p = usePopover();
  return (
    <div className="relative" ref={p.ref}>
      <button ref={p.button} type="button" className="prefs-pill" aria-haspopup="dialog" aria-expanded={p.open} aria-label={t('prefs.title')} title={t('prefs.title')} onClick={() => p.setOpen((o) => !o)}>
        <Globe className="size-4" strokeWidth={1.8} aria-hidden />
        <span>{LOCALES[lang].short}</span>
        <span className="prefs-sep" aria-hidden />
        <span>{cur}</span>
        <span className="prefs-sep" aria-hidden />
        {dark ? <Moon className="size-4" strokeWidth={1.8} aria-hidden /> : <Sun className="size-4" strokeWidth={1.8} aria-hidden />}
      </button>
      <AnimatePresence>
        {p.open && (
          <motion.div role="dialog" aria-label={t('prefs.title')} tabIndex={-1} ref={p.focusPanel} {...panelMotion} className="hdr-panel prefs-panel">
            <fieldset>
              <legend>{t('prefs.language')}</legend>
              <div className="prefs-langs">
                {(Object.keys(LOCALES) as Locale[]).map((l) => (
                  <button key={l} type="button" lang={l} aria-pressed={l === lang} onClick={() => setLocale(l)}>
                    {LOCALES[l].name}
                    {l === lang && <Check className="size-4" aria-hidden />}
                  </button>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend>{t('prefs.currency')}</legend>
              <div className="seg-row">
                {DISPLAY_CURRENCIES.map((c) => (
                  <button key={c} type="button" aria-pressed={c === cur} onClick={() => setCurrency(c)}>{c}</button>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend>{t('prefs.theme')}</legend>
              <div className="seg-row">
                <button type="button" aria-pressed={dark} aria-label={t('prefs.dark')} onClick={() => setTheme('dark')}><Moon className="size-4" aria-hidden /> {t('prefs.themeDark')}</button>
                <button type="button" aria-pressed={!dark} aria-label={t('prefs.light')} onClick={() => setTheme('light')}><Sun className="size-4" aria-hidden /> {t('prefs.themeLight')}</button>
              </div>
            </fieldset>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const initials = (n = '?') => n.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

/** The avatar menu: everything that used to crowd the top bar (orders, shop, cart, watchlist…). */
export function AccountMenu() {
  const { user, signOut } = useSession();
  const n = cartCount(useCart());
  const p = usePopover();
  if (!user) return null;
  const close = () => p.setOpen(false);
  return (
    <div className="relative" ref={p.ref}>
      <button ref={p.button} type="button" className="avatar-btn" aria-haspopup="menu" aria-expanded={p.open} aria-label={t('menu.account')} onClick={() => p.setOpen((o) => !o)}>
        {initials(user.display_name)}
        {n > 0 && <span className="avatar-badge" aria-hidden>{n > 9 ? '9+' : n}</span>}
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
            <Link role="menuitem" to="/cart" onClick={close} aria-label={t('cart.linkLabel', { count: n })}>
              <ShoppingCart className="size-4" aria-hidden /> {t('cart.title')}
              {n > 0 && <span className="menu-count">{n}</span>}
            </Link>
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
