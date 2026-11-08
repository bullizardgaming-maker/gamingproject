import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { GameBanner } from '@/components/GameArt';
import { ArrowRight, UsersThree } from '@phosphor-icons/react';
import { CATEGORY_ICON, CategoriesRetry, TrustStrip } from '../components/CatalogUi';
import { GameSearch } from '../components/SiteHeader';
import { BrandMark, BrandWordmark } from '../components/Brand';
import { HeroEye } from '../components/HeroEye';
import { PaymentStrip } from '../components/PaymentStrip';
import { StatusEye } from '../components/StatusEye';
import { api, money } from '../api';
import { useSession } from '../session';
import { categoryLabel, popular, slugify, useCategoryOrder, useGames, type GameEntry } from '@/lib/catalog';
import { useRecent } from '@/lib/recent';
import { statusLabel } from '@/lib/orderUi';
import { usePageMeta } from '@/lib/seo';
import { t, useLocale } from '../i18n';

interface OrderLine { id: string; ref?: string; offer_id?: string; offer_title: string; game: string; amount_cents: number; currency: string; status: string; created_at: string }

/**
 * Home (CEO, 8 Nov): the eye hero ("Bullizard · Digital Marketplace", search), the trust strip, trending games,
 * what this visitor browsed and bought, two ways to get paid, and the moving strip of ways to pay.
 */
export function Home() {
  usePageMeta({ description: t('home.meta') });
  const { user } = useSession();
  const { games } = useGames();
  const recent = useRecent();
  const [bought, setBought] = useState<OrderLine[]>([]);
  useEffect(() => {
    if (!user) return setBought([]);
    api<OrderLine[]>('/orders?as=buyer').then((o) => setBought(o.filter((x) => x.status !== 'cancelled').slice(0, 4))).catch(() => setBought([]));
  }, [user?.id]);
  const trending = games ? popular(games, 6) : [];
  const browsed = recent.browsed.filter((b) => games?.some((g) => g.game === b.game)).slice(0, 4);
  const ar = useLocale() === 'ar';

  return (
    <>
      <section className="lp-hero bleed">
        <div className="shell lp-hero-in">
          <div className="lp-hero-text">
            <h1 className="lp-title">
              {ar ? <span lang="ar" className="wordmark-ar lp-word-ar">بوليزارد</span> : <BrandWordmark className="lp-word" title="Bullizard" />}
              <span className="lp-kicker">{t('lp.kicker')}</span>
            </h1>
            <p className="lp-lede">{t('lp.lede')}</p>
            <div className="home-search lp-search"><GameSearch big /></div>
          </div>
          <HeroEye className="lp-eye" />
        </div>
      </section>

      <section className="trust-band bleed">
        <div className="shell"><TrustStrip /></div>
      </section>

      <section className="home-block" aria-labelledby="home-top">
        <div className="home-head">
          <h2 id="home-top">{t('lp.trending')}</h2>
          <Link to="/games" className="home-more">{t('home.allGames')} <ArrowRight className="size-4 rtl:rotate-180" aria-hidden /></Link>
        </div>
        <CategoriesRetry />
        <div className="home-games">
          {games === null
            ? Array.from({ length: 6 }, (_, i) => <div key={i} className="card home-game-skel" aria-hidden />)
            : trending.map((g) => <GameTile key={g.game} game={g} />)}
        </div>
        <Link to="/games/vote" className="small muted mt-4 inline-block">{t('home.voteNext')}</Link>
      </section>

      {browsed.length > 0 && (
        <section className="home-block" aria-labelledby="home-continue">
          <div className="home-head"><h2 id="home-continue">{t('lp.browsed')}</h2></div>
          <div className="home-games">
            {browsed.map((b) => <GameTile key={b.game} game={games!.find((g) => g.game === b.game)!} only={b.categories} />)}
          </div>
        </section>
      )}

      {bought.length > 0 && (
        <section className="home-block" aria-labelledby="home-bought">
          <div className="home-head">
            <h2 id="home-bought">{t('home.recentlyBought')}</h2>
            <Link to="/orders" className="home-more">{t('home.allOrders')} <ArrowRight className="size-4 rtl:rotate-180" aria-hidden /></Link>
          </div>
          <ul className="home-bought">
            {bought.map((o) => (
              <li key={o.id} className="card home-bought-card">
                <div className="home-bought-text">
                  <span className="small muted">{o.game}</span>
                  <Link to={`/orders/${o.id}`} className="home-bought-title" dir="auto">{o.offer_title}</Link>
                  <span className="num small">{money(o.amount_cents, o.currency)}</span>
                  {o.offer_id && <Link to={`/offers/${o.offer_id}`} className="small">{t('home.buyAgain')}</Link>}
                </div>
                {/* The status eye sits in the middle of the card's side (word on hover). */}
                <StatusEye status={o.status} label={statusLabel(o.status)} size={34} className="home-bought-eye" />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="home-block lp-earn" aria-labelledby="lp-earn-title">
        <div className="home-head">
          <div>
            <h2 id="lp-earn-title">{t('lp.earn.title')}</h2>
            <p className="muted" style={{ margin: '6px 0 0' }}>{t('lp.earn.sub')}</p>
          </div>
        </div>
        <div className="lp-earn-grid">
          <article className="lp-earn-card" aria-labelledby="lp-aff-title">
            <div className="lp-earn-top">
              <span className="lp-earn-tag"><UsersThree className="size-4" aria-hidden /> {t('lp.aff.tag')}</span>
              <div className="lp-earn-big num" aria-hidden>20%</div>
            </div>
            <h3 id="lp-aff-title">{t('lp.aff.title')}</h3>
            <p>{t('lp.aff.text')}</p>
            <div className="lp-earn-actions">
              <Link to={user ? '/account#invite' : '/signup'} className="btn lp-go">{t('lp.earn.cta')} <ArrowRight className="size-4 rtl:rotate-180" aria-hidden /></Link>
              <Link to={`/support/new?category=other&subject=${encodeURIComponent(t('lp.aff.creatorSubject'))}`} className="lp-earn-link">{t('lp.aff.creator')}</Link>
            </div>
          </article>
          <article className="lp-earn-card lp-earn-sell" aria-labelledby="lp-sell-title">
            <div className="lp-earn-top">
              <span className="lp-earn-tag"><BrandMark style={{ width: 16, height: 14 }} /> {t('grow.sellBadge')}</span>
              <div className="lp-earn-big num" aria-hidden>5%</div>
            </div>
            <h3 id="lp-sell-title">{t('lp.sell.title')}</h3>
            <p>{t('lp.sell.text')}</p>
            <div className="lp-earn-actions">
              <Link to="/sell" className="btn lp-go">{t('lp.earn.cta')} <ArrowRight className="size-4 rtl:rotate-180" aria-hidden /></Link>
            </div>
          </article>
        </div>
      </section>

      <PaymentStrip />
    </>
  );
}

/** A game as a name and its categories, no artwork. `only` limits it to the categories someone browsed. */
function GameTile({ game, only }: { game: GameEntry; only?: string[] }) {
  const order = useCategoryOrder();
  const cats = order.filter((s) => game.categories.some((c) => c.slug === s) && (!only?.length || only.includes(s)));
  const slug = slugify(game.game);
  return (
    <article className="card home-game">
      <Link to={`/games/${slug}`} className="home-game-name">
        <GameBanner game={game.game} height={96}><span className="game-banner-name">{game.game}</span></GameBanner>
      </Link>
      <div className="home-game-cats">
        {cats.map((s) => {
          const Icon = CATEGORY_ICON[s]!;
          return (
            <Link key={s} to={`/games/${slug}/${s}`} className="pg-cat">
              <Icon className="size-4" aria-hidden /> {categoryLabel(s)}
            </Link>
          );
        })}
      </div>
    </article>
  );
}
