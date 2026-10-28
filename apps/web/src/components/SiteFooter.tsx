import { useState } from 'react';
import { Link } from 'react-router-dom';
import { DownloadSimple as Download, Moon, ShareNetwork as Share, Sun } from '@phosphor-icons/react';
import { useInstall } from '@/lib/pwa';
import { LOCALES, setLocale, t, useLocale, type Locale } from '../i18n';
import { DISPLAY_CURRENCIES, resolvedTheme, setCurrency, setTheme, useDisplayCurrency, useTheme, type DisplayCurrency } from '@/lib/prefs';
import { BrandLockup } from './Brand';
import { HELP_CENTER } from '@/lib/features';

const links = (): Array<[string, string]> => [
  ...(HELP_CENTER ? ([[t('footer.helpCentre'), '/help'], [t('footer.escrow'), '/help/how-escrow-works'], [t('footer.fees'), '/help/selling-fees']] as Array<[string, string]>) : []),
  [t('footer.openShop'), '/sell'],
  [t('footer.games'), '/games'],
  [t('footer.contact'), '/support/new'],
  [t('footer.status'), '/status'],
];
/** Legal pages (Legal pack, Oct 24): all five, always in the footer. */
const legalLinks = (): Array<[string, string]> => [
  [t('footer.terms'), '/terms'],
  [t('footer.privacy'), '/privacy'],
  [t('footer.sellerAgreement'), '/seller-agreement'],
  [t('footer.refunds'), '/refunds'],
  [t('footer.restricted'), '/restricted-countries'],
];

/** "Install the app": the browser's own prompt, or the iOS Add to Home Screen steps. */
function InstallApp() {
  const { state, install } = useInstall();
  const [iosHelp, setIosHelp] = useState(false);
  if (state === 'installed' || state === 'none') return null;
  return (
    <div>
      <button type="button" className="ftr-link inline-flex items-center gap-2" onClick={() => (state === 'prompt' ? install() : setIosHelp((v) => !v))}>
        <Download className="size-4" /> {t('footer.install')}
      </button>
      {iosHelp && (
        <p className="small muted" style={{ margin: '8px 0 0' }}>
          {t('footer.iosInstall', { share: '\u0000' }).split('\u0000')[0]}
          <Share className="inline size-4 align-text-bottom" aria-label="Share" />
          {t('footer.iosInstall', { share: '\u0000' }).split('\u0000')[1]}
        </p>
      )}
    </div>
  );
}

/** Language, currency and light/dark, here as well as in the header, which hides them on phones. */
function FooterPrefs() {
  const lang = useLocale();
  const cur = useDisplayCurrency();
  const theme = useTheme();
  const dark = theme === 'system' ? resolvedTheme() === 'dark' : theme === 'dark';
  return (
    <div className="ftr-prefs">
      <select aria-label={t('prefs.language')} value={lang} onChange={(e) => setLocale(e.target.value as Locale)}>
        {(Object.keys(LOCALES) as Locale[]).map((l) => <option key={l} value={l} lang={l}>{LOCALES[l].name}</option>)}
      </select>
      <select aria-label={t('prefs.currency')} value={cur} onChange={(e) => setCurrency(e.target.value as DisplayCurrency)}>
        {DISPLAY_CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      <button type="button" className="ftr-theme" aria-pressed={dark} onClick={() => setTheme(dark ? 'light' : 'dark')}>
        {dark ? <Moon className="size-4" aria-hidden /> : <Sun className="size-4" aria-hidden />} {t('footer.nightMode')}
      </button>
    </div>
  );
}

/** A small G2G-style bar: what we are, the few links people need, preferences. Always at the bottom. */
export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="shell ftr">
        <div className="ftr-top">
          <Link to="/" className="brand" aria-label={t('brand.home')}><BrandLockup size={16} /></Link>
          <p className="ftr-about">{t('footer.about')}</p>
          <FooterPrefs />
        </div>
        <div className="ftr-bottom">
          <span className="num">© {new Date().getFullYear()} Bullizard</span>
          <nav className="ftr-links" aria-label={t('footer.nav')}>
            {links().map(([label, to]) => <Link key={to} to={to} className="ftr-link">{label}</Link>)}
          </nav>
          <InstallApp />
        </div>
        <div className="ftr-bottom ftr-legal">
          <nav className="ftr-links" aria-label={t('legal.nav')}>
            {legalLinks().map(([label, to]) => <Link key={to} to={to} className="ftr-link">{label}</Link>)}
          </nav>
          <span className="small muted">{t('footer.legal')}</span>
        </div>
      </div>
    </footer>
  );
}
