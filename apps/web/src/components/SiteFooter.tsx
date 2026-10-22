import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, Share } from 'lucide-react';
import { useInstall } from '@/lib/pwa';
import { LOCALES, setLocale, t, useLocale, type Locale } from '../i18n';
import { DISPLAY_CURRENCIES, setCurrency, useDisplayCurrency, type DisplayCurrency } from '@/lib/prefs';
import { CATEGORY_META, useCategoryOrder } from '@/lib/catalog';
import { BrandLockup } from './Brand';

const columns = (categoryOrder: string[]): Array<[string, Array<[string, string]>]> => [
  [t('footer.buy'), categoryOrder.slice(0, 6).map((slug) => [CATEGORY_META[slug]!.label, `/market?category=${slug}`])],
  [t('footer.sell'), [[t('footer.openShop'), '/sell'], [t('footer.buyerRequests'), '/requests'], [t('footer.money'), '/sell/money'], [t('footer.fees'), '/help/selling-fees'], [t('footer.api'), '/developers']]],
  [t('footer.protection'), [[t('footer.escrow'), '/help/how-escrow-works'], [t('footer.dispute'), '/help/open-a-dispute'], [t('footer.insurance'), '/help/account-insurance'], [t('footer.orders'), '/orders']]],
  [t('footer.account'), [[t('nav.signIn'), '/login'], [t('footer.settings'), '/account'], [t('footer.notifications'), '/account#notifications'], [t('footer.watchlist'), '/watchlist'], [t('footer.games'), '/games']]],
  [t('footer.help'), [[t('footer.helpCentre'), '/help'], [t('footer.contact'), '/support/new'], [t('footer.requests'), '/support'], [t('footer.status'), '/status']]],
];

/** "Install the app": the browser's own prompt, or the iOS Add to Home Screen steps. */
function InstallApp() {
  const { state, install } = useInstall();
  const [iosHelp, setIosHelp] = useState(false);
  if (state === 'installed' || state === 'none') return null;
  return (
    <div className="mt-4">
      <button type="button" className="btn ghost inline-flex items-center gap-2" style={{ fontSize: 14 }} onClick={() => (state === 'prompt' ? install() : setIosHelp((v) => !v))}>
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

/** Language and currency, here as well as in the header, which hides them on phones. */
function FooterPrefs() {
  const lang = useLocale();
  const cur = useDisplayCurrency();
  return (
    <div className="mt-4 flex flex-wrap gap-2">
      <select aria-label={t('prefs.language')} value={lang} onChange={(e) => setLocale(e.target.value as Locale)} style={{ width: 'auto', height: 38, padding: '6px 10px', fontSize: 14 }}>
        {(Object.keys(LOCALES) as Locale[]).map((l) => <option key={l} value={l} lang={l}>{LOCALES[l].name}</option>)}
      </select>
      <select aria-label={t('prefs.currency')} value={cur} onChange={(e) => setCurrency(e.target.value as DisplayCurrency)} style={{ width: 'auto', height: 38, padding: '6px 10px', fontSize: 14 }}>
        {DISPLAY_CURRENCIES.map((c) => <option key={c}>{c}</option>)}
      </select>
    </div>
  );
}

export function SiteFooter() {
  const categoryOrder = useCategoryOrder();
  return (
    <footer className="site-footer">
      <div className="shell">
        <div className="grid gap-8 py-10 sm:grid-cols-2 lg:grid-cols-[1.4fr_repeat(5,1fr)]">
          <div className="stack" style={{ maxWidth: 320 }}>
            <Link to="/" className="brand" aria-label={t('brand.home')}><BrandLockup size={18} /></Link>
            <p className="small muted" style={{ margin: '12px 0 0' }}>
              {t('footer.tagline')}
            </p>
            <FooterPrefs />
            <InstallApp />
          </div>
          {columns(categoryOrder).map(([title, links]) => (
            <div key={title}>
              <div className="eyebrow">{title}</div>
              <ul className="m-0 list-none space-y-2 p-0">
                {links.map(([label, to]) => (
                  <li key={label}><Link to={to} className="text-sm text-muted-foreground no-underline hover:text-foreground">{label}</Link></li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="row spread border-t border-border py-5 text-[13px]">
          <span>{t('footer.escrowLine')}</span>
          <span className="mono">{t('footer.cardLine')}</span>
        </div>
      </div>
    </footer>
  );
}
