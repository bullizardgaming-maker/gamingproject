import { Link } from 'react-router-dom';
import { InstagramLogo, TiktokLogo, XLogo, YoutubeLogo } from '@phosphor-icons/react';
import { SupportLink } from './SupportLink';
import { BrandLockup } from './Brand';
import { t } from '../i18n';

/** Official accounts (domain-email setup H3 / community setup): X, Instagram, TikTok @bullizardhq · YouTube @bullizard.
 *  Discord joins once bullizard.com/discord redirects (community setup, Step 10). */
const SOCIALS = [
  { name: 'X', href: 'https://x.com/bullizardhq', Icon: XLogo },
  { name: 'Instagram', href: 'https://www.instagram.com/bullizardhq', Icon: InstagramLogo },
  { name: 'TikTok', href: 'https://www.tiktok.com/@bullizardhq', Icon: TiktokLogo },
  { name: 'YouTube', href: 'https://www.youtube.com/@bullizard', Icon: YoutubeLogo },
];

/**
 * The bottom strip (CEO, 8 Nov): our name; About Us, Legal, Terms of Service, Privacy Policy, Help Center;
 * our social accounts on the far side. The 18+ / publisher line stays (Legal pack).
 */
export function SiteFooter() {
  const links: Array<[string, string]> = [
    [t('footer2.about'), '/about'],
    [t('footer2.legal'), '/legal'],
    [t('legal.title.terms'), '/terms'],
    [t('legal.title.privacy'), '/privacy'],
  ];
  return (
    <footer className="site-footer">
      <div className="shell shell-wide ftr2">
        <div className="ftr2-brand">
          <Link to="/" className="brand" aria-label={t('brand.home')}><BrandLockup size={16} /></Link>
          <span className="small muted num">© {new Date().getFullYear()} Bullizard</span>
        </div>
        <nav className="ftr2-links" aria-label={t('footer.nav')}>
          {links.map(([label, to]) => <Link key={to} to={to} className="ftr-link">{label}</Link>)}
          <SupportLink to="/help" className="ftr-link">{t('footer2.help')}</SupportLink>
        </nav>
        <ul className="ftr2-social" aria-label={t('footer2.social')}>
          {SOCIALS.map(({ name, href, Icon }) => (
            <li key={name}>
              <a href={href} target="_blank" rel="noopener noreferrer" aria-label={name} title={name}><Icon className="size-5" aria-hidden /></a>
            </li>
          ))}
        </ul>
        <p className="ftr2-legal small muted">{t('footer.legal')}</p>
      </div>
    </footer>
  );
}
