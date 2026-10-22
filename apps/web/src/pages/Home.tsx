import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { GameCard, TrustStrip } from '../components/CatalogUi';
import { GameSearch } from '../components/SiteHeader';
import { BrandMark } from '../components/Brand';
import { popular, slugify, useGames } from '@/lib/catalog';
import { usePageMeta } from '@/lib/seo';
import { t } from '../i18n';

/**
 * Home, G2G-style but ours: a wide photo hero with the big search and the trust strip (both full
 * width), then games and "Grow with Bullizard" at the normal page width. Say it once: fee details
 * and policies live in the help centre, not here.
 */
export function Home() {
  usePageMeta({ description: t('home.meta') });
  const { games } = useGames();
  const top = games ? popular(games, 10) : [];
  const searches = games ? popular(games, 4) : [];

  return (
    <>
      <section className="home-hero2 bleed">
        <div className="shell shell-wide home-hero2-inner">
          <h1>
            {t('home.heroTitle1')}
            <br />
            <span className="rune-text">{t('home.heroTitle2')}</span>
          </h1>
          <p className="lede">{t('home.heroLede')}</p>
          <div className="home-search"><GameSearch big /></div>
          <div className="row" style={{ gap: 8 }}>
            <span className="eyebrow" style={{ margin: '0 4px 0 0' }}>{t('home.topSearches')}</span>
            {searches.map((g) => (
              <Link key={g.game} to={`/games/${slugify(g.game)}`} className="search-pill">{g.game}</Link>
            ))}
          </div>
        </div>
      </section>

      <section className="trust-band bleed">
        <div className="shell shell-wide"><TrustStrip /></div>
      </section>

      <section className="home-block">
        <div className="row spread" style={{ alignItems: 'end' }}>
          <h2 style={{ margin: 0 }}>{t('home.games')}</h2>
          <Link to="/games" className="inline-flex items-center gap-1 text-sm font-medium no-underline hover:underline">
            {t('home.allGames')} <ArrowRight className="size-4 rtl:rotate-180" />
          </Link>
        </div>
        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {games === null
            ? Array.from({ length: 10 }, (_, i) => <div key={i} className="aspect-[4/5] animate-pulse rounded-xl bg-secondary" />)
            : top.map((g) => <GameCard key={g.game} game={g.game} offers={g.offers} min={g.min_price_cents} categories={g.categories} />)}
        </div>
        <Link to="/support/new" className="small muted mt-4 inline-block">{t('home.missingGame')}</Link>
      </section>

      <section className="home-block" style={{ paddingTop: 48 }}>
        <h2 style={{ margin: 0 }}>{t('grow.title')}</h2>
        <p className="muted" style={{ margin: '6px 0 0', fontSize: 17 }}>{t('grow.sub')}</p>
        <div className="grow-grid">
          <article className="grow-card" style={{ backgroundImage: 'url(/img/grow-invite.jpg)' }}>
            <div className="grow-in">
              <h3>{t('grow.inviteTitle')}</h3>
              <p className="muted">{t('grow.inviteText')}</p>
              <Link to="/account" className="btn ghost">{t('grow.inviteCta')}</Link>
            </div>
          </article>
          <article className="grow-card" style={{ backgroundImage: 'url(/img/grow-sell.jpg)' }}>
            <div className="grow-in">
              <span className="founding"><BrandMark style={{ width: 18, height: 16 }} />{t('grow.sellBadge')}</span>
              <h3>{t('grow.sellTitle')}</h3>
              <p className="muted">{t('grow.sellText')}</p>
              <Link to="/sell" className="btn go">{t('grow.sellCta')}</Link>
            </div>
          </article>
        </div>
      </section>
    </>
  );
}
