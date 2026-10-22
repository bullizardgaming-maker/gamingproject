import { useId } from 'react';
import { Link } from 'react-router-dom';
import { money } from '../api';
import { Award, BadgeCheck, Coins, Gamepad2, Gift, KeyRound, Rocket, ShieldCheck, Smartphone, Star, Swords, UserRound, Video, Zap } from 'lucide-react';
import { categoryLabel, deliveryLabel, hueOf, initials, slugify } from '@/lib/catalog';
import { cn } from '@/lib/utils';
import { attributePairs } from '@/lib/attributes';
import { usePrice } from '@/lib/prefs';
import { unitPriceFor } from '@/lib/tiers';
import type { Offer } from '../pages/Market';
import { OnlineDot } from '@/lib/presence';
import { t, type MessageKey } from '../i18n';

export const CATEGORY_ICON: Record<string, typeof Coins> = {
  accounts: UserRound,
  currency: Coins,
  items: Swords,
  boosting: Rocket,
  'top-ups': Smartphone,
  keys: KeyRound,
  'gift-cards': Gift,
  'video-games': Gamepad2,
};

/**
 * Generated cover art for a game: a two-tone field in the game's own hue under Bullizard's
 * scale pattern, with the game's initials. No publisher artwork is used anywhere.
 */
export function GameArt({ game, className, size = 'md' }: { game: string; className?: string; size?: 'sm' | 'md' | 'lg' }) {
  const h = hueOf(game);
  const id = `sc-${slugify(game)}-${size}`;
  return (
    <div className={cn('relative overflow-hidden', className)} aria-hidden>
      <svg className="absolute inset-0 size-full" preserveAspectRatio="xMidYMid slice" viewBox="0 0 160 100">
        <defs>
          <linearGradient id={`${id}-g`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={`hsl(${h} 42% 20%)`} />
            <stop offset="1" stopColor={`hsl(${(h + 38) % 360} 55% 36%)`} />
          </linearGradient>
          <pattern id={id} width="16" height="12" patternUnits="userSpaceOnUse">
            <path d="M0 12a8 8 0 0 1 16 0M-8 6a8 8 0 0 1 16 0M8 6a8 8 0 0 1 16 0" fill="none" stroke="#fff" strokeOpacity=".09" strokeWidth="1.2" />
          </pattern>
        </defs>
        <rect width="160" height="100" fill={`url(#${id}-g)`} />
        <rect width="160" height="100" fill={`url(#${id})`} />
        <circle cx="132" cy="18" r="34" fill={`hsl(${(h + 70) % 360} 70% 60%)`} opacity=".16" />
      </svg>
      <span
        className={cn(
          'absolute bottom-[8%] left-[7%] font-display font-bold leading-none tracking-tight text-white/90',
          size === 'sm' ? 'text-base' : size === 'lg' ? 'text-6xl' : 'text-3xl',
        )}
      >
        {initials(game)}
      </span>
    </div>
  );
}

export function Avatar({ name, className }: { name: string; className?: string }) {
  const h = hueOf(name);
  return (
    <span
      aria-hidden
      className={cn('grid size-9 shrink-0 place-items-center rounded-full font-display text-sm font-bold text-white', className)}
      style={{ background: `linear-gradient(135deg, hsl(${h} 45% 32%), hsl(${(h + 40) % 360} 55% 44%))` }}
    >
      {initials(name)}
    </span>
  );
}

export function Rating({ value, count, className }: { value: number | string | null; count: number; className?: string }) {
  if (!count || value == null) return <span className={cn('text-xs text-muted-foreground', className)}>{t('rating.new')}</span>;
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs text-muted-foreground', className)}>
      <Star className="size-3.5 fill-held text-held" />
      <b className="font-mono text-foreground">{Number(value).toFixed(2)}</b>
      <span>({count.toLocaleString()})</span>
    </span>
  );
}

export function DeliveryTag({ offer }: { offer: Pick<Offer, 'delivery_mode'> & { delivery_hours?: number | null } }) {
  const instant = offer.delivery_mode === 'auto';
  return (
    <span className={cn('inline-flex items-center gap-1 whitespace-nowrap font-mono text-xs', instant ? 'text-released' : 'text-muted-foreground')}>
      {instant && <Zap className="size-3.5 fill-released" />}
      {deliveryLabel(offer.delivery_mode, offer.delivery_hours)}
    </span>
  );
}

export function ProtectionTag({ offer }: { offer: Offer }) {
  if (offer.category_kind !== 'account') return <span className="text-[11px] text-muted-foreground">{t('protect.inspection')}</span>;
  return offer.high_risk_secondary ? (
    <span className="text-[11px] text-disputed">{t('protect.noProof')}</span>
  ) : (
    <span className="inline-flex items-center gap-1 text-[11px] text-released"><BadgeCheck className="size-3.5" /> {t('protect.verified')}</span>
  );
}

/**
 * The comparison table every game, search and seller page uses: one row per listing with the
 * seller, delivery speed, stock and price side by side. Collapses to cards on narrow screens.
 */
/** A listing's game-specific fields as one quiet line: "EUW · Gold → Platinum". */
export function AttributeLine({ offer, className }: { offer: Pick<Offer, 'game' | 'category_slug' | 'attributes'>; className?: string }) {
  const pairs = attributePairs(offer.game, offer.category_slug, offer.attributes);
  if (!pairs.length) return null;
  return (
    <div className={cn('mt-1 flex flex-wrap gap-1', className)}>
      {pairs.map(([label, v]) => (
        <span key={label} title={label} className="rounded border border-border bg-background px-1.5 py-px text-[11.5px] leading-5 text-muted-foreground">{v}</span>
      ))}
    </div>
  );
}

export function OfferTable({ offers, showGame = false, showSeller = true, empty, amount }: { offers: Offer[]; showGame?: boolean; showSeller?: boolean; empty?: React.ReactNode; amount?: number }) {
  const price = usePrice();
  if (offers.length === 0) return <div className="card text-center text-muted-foreground">{empty ?? t('table.empty')}</div>;
  const withTotal = amount != null;
  const uid = useId();
  return (
    <div className={cn('lt', withTotal && 'lt-total')}>
      <div className="lt-row lt-head" aria-hidden>
        <span>{t('table.offer')}</span>
        <span>{t('table.delivery')}</span>
        <span>{t('table.stock')}</span>
        <span className="text-end">{withTotal ? t('table.perUnit') : t('table.price')}</span>
        <span className="text-end">{withTotal ? t('table.totalFor', { n: amount }) : ''}</span>
      </div>
      <ul className="m-0 list-none p-0">
        {offers.map((o) => {
          const qty = withTotal ? Math.min(amount!, Math.max(1, o.stock)) : 1;
          const unit = withTotal ? unitPriceFor(o, qty) : o.price_cents;
          const tooMany = withTotal && amount! > o.stock;
          return (
            <li key={o.id} className="lt-row group">
              <div className="lt-offer">
                {showGame && <div className="lt-game">{o.game} · {categoryLabel(o.category_slug)}</div>}
                <Link id={`${uid}-${o.id}`} to={`/offers/${o.id}`} className="lt-title after:absolute after:inset-0">{o.title}</Link>
                <AttributeLine offer={o} />
                {showSeller && (
                  <div className="lt-seller">
                    <Avatar name={o.seller_name} className="size-7 text-[11px]" />
                    <Link to={`/sellers/${o.seller_id}`} className="lt-name">{o.seller_name}</Link>
                    {o.seller_online && <OnlineDot />}
                    {o.seller_rank && <RankPill name={o.seller_rank} />}
                    {o.seller_trust_level && o.seller_trust_level !== 'new' && <TrustBadge level={o.seller_trust_level} />}
                    {o.seller_founding && <FoundingBadge />}
                    <Rating value={o.seller_rating} count={o.seller_review_count} />
                  </div>
                )}
                <div className="lt-tags">
                  <ProtectionTag offer={o} />
                  {o.is_bundle && <span className="chip">{t('bundle.chip')}</span>}
                  {o.featured && <span className="chip" data-testid="featured-chip"><Star className="size-3" /> {t('featured.chip')}</span>}
                </div>
              </div>
              <div className="lt-del"><DeliveryTag offer={o as any} /></div>
              <span className="lt-stock"><span className="md:hidden">{t('table.stock')} </span><span className="num">{o.stock}</span></span>
              <div className="lt-price">
                {o.regular_price_cents != null && o.regular_price_cents > o.price_cents && (
                  <span className="num text-xs text-muted-foreground line-through">{money(o.regular_price_cents, o.currency)}</span>
                )}
                <span className="num">{withTotal ? price.offer({ ...o, price_cents: unit, price_settlement_cents: null } as any) : price.offer(o as any)}</span>
                {!!o.price_tiers?.length && (
                  <span className="text-xs text-muted-foreground">{t('tier.bulkFrom', { price: money(o.price_tiers.at(-1)!.priceCents, o.currency), qty: o.price_tiers.at(-1)!.minQty })}</span>
                )}
              </div>
              <div className="lt-buy">
                {withTotal && (
                  <b className="num" title={tooMany ? t('table.onlyStock', { n: o.stock }) : undefined}>
                    {price.offer({ ...o, price_cents: unit * qty, price_settlement_cents: null } as any)}
                    {tooMany && <span className="block text-xs font-normal text-muted-foreground">{t('table.onlyStock', { n: o.stock })}</span>}
                  </b>
                )}
                <Link className="btn sm" to={withTotal ? `/offers/${o.id}?qty=${qty}` : `/offers/${o.id}`} aria-describedby={`${uid}-${o.id}`}>{t('table.buy')}</Link>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Seller rank pill (Hatchling → Dragon). Only the top rank uses the accent. */
export function RankPill({ name, className }: { name: string; className?: string }) {
  return <span className={cn('rank', /dragon/i.test(name) && 'top', className)}>{name}</span>;
}

export function GameCard({ game, offers, min, categories }: { game: string; offers: number; min: number; categories: Array<{ slug: string; count: number }> }) {
  const price = usePrice();
  return (
    <Link to={`/games/${slugify(game)}`} className="group block overflow-hidden rounded-xl border border-border bg-card no-underline transition-colors hover:border-muted-foreground">
      <GameArt game={game} className="aspect-[16/9]" />
      <div className="p-3">
        <div className="truncate font-display text-[15px] font-semibold tracking-tight">{game}</div>
        <div className="mt-0.5 flex items-center justify-between text-xs text-muted-foreground">
          <span>{t('offers.count', { count: offers })}</span>
          <span className="font-mono">{t('offers.from', { price: price(min) })}</span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          {categories.slice(0, 3).map((c) => (
            <span key={c.slug} className="rounded-md bg-secondary px-1.5 py-0.5 text-[11px] text-muted-foreground">{categoryLabel(c.slug)}</span>
          ))}
        </div>
      </div>
    </Link>
  );
}

export function TrustStrip({ className }: { className?: string }) {
  const items = [
    [ShieldCheck, t('trust.escrow'), t('trust.escrow.text')],
    [Video, t('trust.proof'), t('trust.proof.text')],
    [Coins, t('trust.crypto'), t('trust.crypto.text')],
    [Star, t('trust.reviews'), t('trust.reviews.text')],
  ] as const;
  return (
    <div className={cn('trust-strip', className)}>
      {items.map(([Icon, title, text]) => (
        <div key={title} className="trust-item">
          <span className="trust-icon"><Icon className="size-[18px]" strokeWidth={1.8} /></span>
          <div className="min-w-0">
            <div className="text-sm font-semibold">{title}</div>
            <div className="text-[13px] leading-snug text-muted-foreground">{text}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Seller trust level badge (nothing for new sellers). */
/** Founding Sellers opened their shop during the launch: the badge stays for good. */
export function FoundingBadge({ className }: { className?: string }) {
  return (
    <span className={cn('rank', className)} title={t('founding.hint')} data-testid="founding-badge">
      <Rocket className="size-3" aria-hidden /> {t('founding.badge')}
    </span>
  );
}

export function TrustBadge({ level, className }: { level?: string | null; className?: string }) {
  if (!level || level === 'new') return null;
  return (
    <span className={cn('rank', className)} title={t(`trust.${level}.hint` as MessageKey)}>
      <Award className="size-3" aria-hidden /> {t(`trust.${level}` as MessageKey)}
    </span>
  );
}
