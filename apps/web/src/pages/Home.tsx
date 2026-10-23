import { useEffect, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { GameArt } from '@/components/GameArt';
import { ArrowRight } from '@phosphor-icons/react';
import { CATEGORY_ICON, TrustStrip } from '../components/CatalogUi';
import { GameSearch } from '../components/SiteHeader';
import { BrandMark } from '../components/Brand';
import { api, money } from '../api';
import { useSession } from '../session';
import { categoryLabel, popular, slugify, useCategoryOrder, useGames, type GameEntry } from '@/lib/catalog';
import { useRecent } from '@/lib/recent';
import { statusLabel } from '@/lib/orderUi';
import { usePageMeta } from '@/lib/seo';
import { t } from '../i18n';

interface OrderLine { id: string; ref?: string; offer_id?: string; offer_title: string; game: string; amount_cents: number; currency: string; status: string; created_at: string }

/**
 * Home: the photo hero with the big search and the trust strip (full width), then what this
 * buyer had going (recently bought, continue browsing) and our top games. No game artwork.
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
  const top = games ? popular(games, 10) : [];
  const trending = games ? popular(games, 5) : [];
  const browsed = recent.browsed.filter((b) => games?.some((g) => g.game === b.game)).slice(0, 4);

  return (
    <>
      <section className="home-hero2 bleed">
        <div className="shell home-hero2-inner">
          <h1>{t('home.hero.title')}</h1>
          <p className="lede">{t('home.hero.lede')}</p>
          <div className="home-search"><GameSearch big /></div>
          {trending.length > 0 && (
            <div className="row" style={{ gap: 8 }}>
              <span className="eyebrow" style={{ margin: '0 4px 0 0' }}>{t('search.trending')}</span>
              {trending.map((g) => (
                <Link key={g.game} to={`/games/${slugify(g.game)}`} className="search-pill">{g.game}</Link>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="trust-band bleed">
        <div className="shell"><TrustStrip /></div>
      </section>

      {bought.length > 0 && (
        <section className="home-block" aria-labelledby="home-bought">
          <div className="home-head">
            <h2 id="home-bought">{t('home.recentlyBought')}</h2>
            <Link to="/orders" className="home-more">{t('home.allOrders')} <ArrowRight className="size-4 rtl:rotate-180" aria-hidden /></Link>
          </div>
          <ul className="home-bought">
            {bought.map((o) => (
              <li key={o.id} className="card">
                <span className="small muted">{o.game}</span>
                <Link to={`/orders/${o.id}`} className="home-bought-title" dir="auto">{o.offer_title}</Link>
                <div className="row spread small">
                  <span className="num">{money(o.amount_cents, o.currency)}</span>
                  <span className="muted">{statusLabel(o.status)}</span>
                </div>
                {o.offer_id && <Link to={`/offers/${o.offer_id}`} className="small">{t('home.buyAgain')}</Link>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {browsed.length > 0 && (
        <section className="home-block" aria-labelledby="home-continue">
          <div className="home-head"><h2 id="home-continue">{t('home.continue')}</h2></div>
          <div className="home-games">
            {browsed.map((b) => <GameTile key={b.game} game={games!.find((g) => g.game === b.game)!} only={b.categories} />)}
          </div>
        </section>
      )}

      <section className="home-block" aria-labelledby="home-top">
        <div className="home-head">
          <h2 id="home-top">{t('home.topGames')}</h2>
          <Link to="/games" className="home-more">{t('home.allGames')} <ArrowRight className="size-4 rtl:rotate-180" aria-hidden /></Link>
        </div>
        <div className="home-games">
          {games === null
            ? Array.from({ length: 5 }, (_, i) => <div key={i} className="card home-game-skel" aria-hidden />)
            : top.map((g) => <GameTile key={g.game} game={g} />)}
        </div>
        <Link to="/games/vote" className="small muted mt-4 inline-block">{t('home.voteNext')}</Link>
      </section>

      <section className="home-block" style={{ paddingTop: 48 }}>
        <h2 style={{ margin: 0 }}>{t('grow.title')}</h2>
        <p className="muted" style={{ margin: '6px 0 0', fontSize: 16 }}>{t('grow.sub')}</p>
        <div className="grow-grid">
          <article className="grow-card" style={{ backgroundImage: 'url(/img/grow-invite.jpg)', '--photo': 'url(/img/grow-invite.jpg)' } as CSSProperties}>
            <div className="grow-in">
              <h3>{t('grow.inviteTitle')}</h3>
              <p className="muted">{t('grow.inviteText')}</p>
              <Link to="/account" className="btn ghost">{t('grow.inviteCta')}</Link>
            </div>
          </article>
          <article className="grow-card" style={{ backgroundImage: 'url(/img/grow-sell.jpg)', '--photo': 'url(/img/grow-sell.jpg)' } as CSSProperties}>
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

/** A game as a name and its categories, no artwork. `only` limits it to the categories someone browsed. */
function GameTile({ game, only }: { game: GameEntry; only?: string[] }) {
  const order = useCategoryOrder();
  const cats = order.filter((s) => game.categories.some((c) => c.slug === s) && (!only?.length || only.includes(s)));
  const slug = slugify(game.game);
  return (
    <article className="card home-game">
      <Link to={`/games/${slug}`} className="home-game-name"><GameArt game={game.game} size={28} /> {game.game}</Link>
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
