import { Link } from 'react-router-dom';
import { ArrowRight, FileText } from '@phosphor-icons/react';
import { SupportLink } from '../components/SupportLink';
import { HeroEye } from '../components/HeroEye';
import { LEGAL_DOCS, legalTitle } from './Legal';
import { usePageMeta } from '@/lib/seo';
import { t } from '../i18n';

/** /about (CEO, 8 Nov footer): what Bullizard is, in three short paragraphs. */
export function AboutPage() {
  usePageMeta({ title: t('about.title'), description: t('about.p1') });
  return (
    <article className="co-page about-page">
      <div className="about-head">
        <div>
          <div className="eyebrow">{t('lp.kicker')}</div>
          <h1>{t('about.title')}</h1>
        </div>
        <HeroEye className="about-eye" />
      </div>
      <p className="lede">{t('about.p1')}</p>
      <p>{t('about.p2')}</p>
      <p>{t('about.p3')}</p>
      <p className="small muted">{t('footer.legal')}</p>
      <div className="row">
        <Link to="/games" className="btn">{t('home.allGames')} <ArrowRight className="size-4 rtl:rotate-180" aria-hidden /></Link>
        <SupportLink to="/help" className="btn ghost">{t('footer.helpCentre')}</SupportLink>
      </div>
    </article>
  );
}

/** /legal: the five legal documents (Legal pack, Oct 24), reachable from the footer's single "Legal" link. */
export function LegalIndex() {
  usePageMeta({ title: t('legalIndex.title'), description: t('legal.lede') });
  return (
    <div className="co-page">
      <h1>{t('legalIndex.title')}</h1>
      <p className="muted">{t('legal.lede')}</p>
      <ul className="legal-index" data-testid="legal-index">
        {LEGAL_DOCS.map((d) => (
          <li key={d}>
            <Link to={`/${d}`} className="card legal-index-link">
              <FileText className="size-5" aria-hidden />
              <span>{legalTitle(d)}</span>
              <ArrowRight className="size-4 rtl:rotate-180 legal-index-arrow" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
