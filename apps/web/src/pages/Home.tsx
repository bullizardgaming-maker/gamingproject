import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, BadgeCheck, MessagesSquare, PackageCheck, Wallet } from 'lucide-react';
import { api } from '../api';
import { CATEGORY_ICON, GameCard, OfferTable, TrustStrip } from '../components/CatalogUi';
import { GameSearch } from '../components/SiteHeader';
import { CATEGORY_META, CATEGORY_ORDER, popular, slugify, useGames } from '@/lib/catalog';
import type { Offer } from './Market';
import { EscrowTrack, formatRemaining } from '../components/EscrowTrack';
import { FeeLadder } from '../components/FeeLadder';
import { usePageMeta } from '@/lib/seo';
import { t } from '../i18n';

const DEMO_LOG = [
  { seq: 1, who: 'system', text: 'Payment received. $300 locked in escrow.' },
  { seq: 2, who: 'seller', text: 'Delivered login + original registration email.' },
  { seq: 3, who: 'buyer', text: 'Changed password, recovery email, 2FA.' },
  { seq: 4, who: 'system', text: '14-day insurance ended. No dispute.' },
  { seq: 5, who: 'system', text: 'Released $261.03 to seller (fee 12.99%).' },
];
const hash = (n: number) => ((n * 2654435761) >>> 0).toString(16).padStart(8, '0');

/** Hero demo: one account sale moving through escrow on a compressed clock. */
function LiveEscrow() {
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const [t, setT] = useState(reduced ? 45 : 0);

  useEffect(() => {
    if (reduced) return;
    const id = setInterval(() => setT((x) => (x + 1) % 120), 100);
    return () => clearInterval(id);
  }, [reduced]);

  // 0-14 pending, 15-94 held (14 days compressed), 95-119 released
  const stage = t < 15 ? 0 : t < 95 ? 1 : 2;
  const elapsed = stage === 1 ? (t - 15) / 80 : 0;
  const remaining = 14 * 86_400_000 * (1 - elapsed);
  const shown = stage === 0 ? 1 : stage === 1 ? 2 + Math.floor(elapsed * 2) : 5;

  return (
    <div className="hero-panel" aria-label="Example: a game account sale in escrow">
      <div className="receipt">
        <span>Order 7F3A · WoW account, lvl 80</span>
        <span>$300.00</span>
      </div>
      <EscrowTrack
        amountCents={300_00}
        stage={stage as 0 | 1 | 2}
        variant={stage === 2 ? 'released' : 'held'}
        elapsed={elapsed}
        windowLabel="14-day asset insurance"
        clock={stage === 1 ? formatRemaining(remaining) : stage === 2 ? 'Settled' : 'Awaiting payment'}
      />
      <div className="log" aria-live="off">
        {DEMO_LOG.slice(0, shown).slice(-3).map((l) => (
          <div key={l.seq}>
            #{l.seq} <b>{l.who}</b> {l.text} <span>· {hash(l.seq)}…</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Home() {
  usePageMeta({ description: t('home.meta') });
  const { games } = useGames();
  const [instant, setInstant] = useState<Offer[] | null>(null);
  const [fresh, setFresh] = useState<Offer[] | null>(null);
  useEffect(() => {
    api<{ items: Offer[] }>('/offers?delivery=instant&sort=best_selling&pageSize=6').then((r) => setInstant(r.items)).catch(() => setInstant([]));
    api<{ items: Offer[] }>('/offers?sort=newest&pageSize=6&category=accounts&ownerVerified=true').then((r) => setFresh(r.items)).catch(() => setFresh([]));
  }, []);

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const g of games ?? []) for (const c of g.categories) m[c.slug] = (m[c.slug] ?? 0) + c.count;
    return m;
  }, [games]);
  const top = games ? popular(games, 12) : [];
  const trending = games ? popular(games, 6) : [];

  return (
    <>
      <section className="home-hero">
        <div className="stack" style={{ minWidth: 0 }}>
          <div className="eyebrow">{t('home.eyebrow')}</div>
          <h1>
            {t('home.title')} <em>{t('home.titleEm')}</em>.
          </h1>
          <p className="lede" style={{ marginTop: 12 }}>
            {games ? t('home.lede', { offers: games.reduce((s, g) => s + g.offers, 0), games: games.length }) : t('home.ledeLoading')}
          </p>
          <GameSearch big />
          <div className="row small" style={{ gap: 8 }}>
            <span className="muted">{t('home.trending')}</span>
            {trending.map((g) => (
              <Link key={g.game} to={`/games/${slugify(g.game)}`} className="chip" style={{ textDecoration: 'none' }}>{g.game}</Link>
            ))}
          </div>
        </div>
        <LiveEscrow />
      </section>

      <TrustStrip className="mt-8" />

      <section className="section" style={{ paddingTop: 48 }}>
        <div className="row spread" style={{ alignItems: 'end' }}>
          <div>
            <div className="eyebrow">{t('home.byCategory')}</div>
            <h2 style={{ margin: 0 }}>{t('home.byCategory.title')}</h2>
          </div>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {CATEGORY_ORDER.map((slug) => {
            const Icon = CATEGORY_ICON[slug]!;
            const meta = CATEGORY_META[slug]!;
            return (
              <Link key={slug} to={`/market?category=${slug}`} className="cat-tile group">
                <span className="grid size-10 place-items-center rounded-lg bg-secondary transition group-hover:bg-foreground group-hover:text-background">
                  <Icon className="size-5" strokeWidth={1.8} />
                </span>
                <span className="min-w-0">
                  <b className="block font-display text-[15px] tracking-tight">{meta.label}</b>
                  <span className="block text-xs leading-snug text-muted-foreground">{meta.hint}</span>
                </span>
                <span className="ms-auto self-start font-mono text-xs text-muted-foreground">{counts[slug] ?? '·'}</span>
              </Link>
            );
          })}
        </div>
      </section>

      <section className="section" style={{ paddingTop: 48 }}>
        <div className="row spread" style={{ alignItems: 'end' }}>
          <div>
            <div className="eyebrow">{t('home.popular')}</div>
            <h2 style={{ margin: 0 }}>{t('home.popular.title')}</h2>
          </div>
          <Link to="/games" className="inline-flex items-center gap-1 text-sm font-medium no-underline hover:underline">{t('home.allGames')} <ArrowRight className="size-4 rtl:rotate-180" /></Link>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {games === null
            ? Array.from({ length: 12 }, (_, i) => <div key={i} className="aspect-[4/5] animate-pulse rounded-xl bg-secondary" />)
            : top.map((g) => <GameCard key={g.game} game={g.game} offers={g.offers} min={g.min_price_cents} categories={g.categories} />)}
        </div>
      </section>

      <section className="section grid gap-8 lg:grid-cols-2" style={{ paddingTop: 48 }}>
        <div className="min-w-0">
          <div className="row spread" style={{ alignItems: 'end', marginBottom: 16 }}>
            <div>
              <div className="eyebrow">{t('home.instant')}</div>
              <h3 style={{ margin: 0 }}>{t('home.instant.title')}</h3>
            </div>
            <Link to="/market?delivery=instant" className="small" style={{ whiteSpace: 'nowrap' }}>{t('home.seeAll')}</Link>
          </div>
          {instant ? <OfferTable offers={instant} showGame showSeller={false} /> : <p className="muted">{t('home.loading')}</p>}
        </div>
        <div className="min-w-0">
          <div className="row spread" style={{ alignItems: 'end', marginBottom: 16 }}>
            <div>
              <div className="eyebrow">{t('home.verified')}</div>
              <h3 style={{ margin: 0 }}>{t('home.verified.title')}</h3>
            </div>
            <Link to="/market?category=accounts&ownerVerified=true" className="small" style={{ whiteSpace: 'nowrap' }}>{t('home.seeAll')}</Link>
          </div>
          {fresh ? <OfferTable offers={fresh} showGame showSeller={false} /> : <p className="muted">{t('home.loading')}</p>}
        </div>
      </section>

      {games && games.length > 0 && (
        <section className="section" style={{ paddingTop: 48 }}>
          <div className="row spread" style={{ alignItems: 'end' }}>
            <div>
              <div className="eyebrow">{t('home.index')}</div>
              <h2 style={{ margin: 0 }}>{t('home.index.title')}</h2>
            </div>
            <Link to="/games" className="inline-flex items-center gap-1 text-sm font-medium no-underline hover:underline">{t('home.directory')} <ArrowRight className="size-4 rtl:rotate-180" /></Link>
          </div>
          <div className="mt-5 columns-1 gap-6 sm:columns-2 lg:columns-4">
            {games.map((g) => (
              <div key={g.game} className="mb-3 break-inside-avoid">
                <Link to={`/games/${slugify(g.game)}`} className="text-[15px] font-semibold no-underline hover:underline">{g.game}</Link>
                <div className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                  {g.categories.map((c) => (
                    <Link key={c.slug} to={`/games/${slugify(g.game)}/${c.slug}`} className="no-underline hover:text-foreground hover:underline">
                      {CATEGORY_META[c.slug]?.label ?? c.slug}
                    </Link>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="section" id="how" style={{ paddingTop: 64 }}>
        <div className="eyebrow">{t('home.how')}</div>
        <h2>{t('home.how.title')}</h2>
        <ol className="steps">
          {[
            [Wallet, t('home.step1'), t('home.step1.text')],
            [PackageCheck, t('home.step2'), t('home.step2.text')],
            [MessagesSquare, t('home.step3'), t('home.step3.text')],
            [BadgeCheck, t('home.step4'), t('home.step4.text')],
          ].map(([Icon, title, text], i) => {
            const I = Icon as typeof Wallet;
            return (
              <li key={i} className="card">
                <span className="step-no mono">0{i + 1}</span>
                <I className="size-6 text-released" strokeWidth={1.8} />
                <h3 style={{ margin: '12px 0 6px' }}>{title as string}</h3>
                <p className="small muted" style={{ margin: 0 }}>{text as string}</p>
              </li>
            );
          })}
        </ol>
        <div className="windows" style={{ marginTop: 24 }}>
          <div className="card window-card held stack">
            <div className="big mono">72h</div>
            <h3>{t('home.window72')}</h3>
            <p className="muted">{t('home.window72.text')}</p>
          </div>
          <div className="card window-card ins stack">
            <div className="big mono">14d</div>
            <h3>{t('home.window14')}</h3>
            <p className="muted">{t('home.window14.text')}</p>
          </div>
        </div>
        <p className="small muted" style={{ marginTop: 16 }}>
          {t('home.highRiskNote', { chip: '\u0000' }).split('\u0000')[0]}
          <span className="chip disputed">{t('badge.highRisk')}</span>
          {t('home.highRiskNote', { chip: '\u0000' }).split('\u0000')[1]}
        </p>
      </section>

      <section className="section split" id="fees">
        <div className="stack">
          <div className="eyebrow">{t('home.sellers')}</div>
          <h2>{t('home.sellers.title')}</h2>
          <p className="muted">{t('home.sellers.text')}</p>
          <div className="ok">
            <b>{t('home.shield')}</b> {t('home.shield.text')}
          </div>
          <p className="muted small">
            {t('home.api')} <Link to="/developers">{t('home.api.link')}</Link>.
          </p>
          <div className="row">
            <Link className="btn" to="/sell">{t('home.openShop')}</Link>
            <span className="small muted">{t('home.freeToList')}</span>
          </div>
        </div>
        <div className="card">
          <FeeLadder />
        </div>
      </section>

      <section className="section">
        <div className="eyebrow">{t('home.rule')}</div>
        <h2>{t('home.rule.title')}</h2>
        <p className="lede">{t('home.rule.text')}</p>
      </section>
    </>
  );
}
