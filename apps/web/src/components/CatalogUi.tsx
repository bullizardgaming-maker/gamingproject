import { Link } from 'react-router-dom';
import { money } from '../api';
import { BadgeCheck, Coins, Gamepad2, Gift, KeyRound, Rocket, ShieldCheck, Smartphone, Star, Swords, UserRound, Zap } from 'lucide-react';
import { categoryLabel, deliveryLabel, hueOf, initials, slugify } from '@/lib/catalog';
import { cn } from '@/lib/utils';
import { attributePairs } from '@/lib/attributes';
import { usePrice } from '@/lib/prefs';
import type { Offer } from '../pages/Market';
import { t } from '../i18n';

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

export function OfferTable({ offers, showGame = false, showSeller = true, empty }: { offers: Offer[]; showGame?: boolean; showSeller?: boolean; empty?: React.ReactNode }) {
  const price = usePrice();
  if (offers.length === 0) return <div className="card text-center text-muted-foreground">{empty ?? t('table.empty')}</div>;
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div
        className={cn(
          'hidden border-b border-border bg-secondary/50 px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.1em] text-muted-foreground md:grid md:gap-4',
          showSeller ? 'md:grid-cols-[minmax(0,2.4fr)_minmax(0,1.3fr)_90px_70px_120px]' : 'md:grid-cols-[minmax(0,3fr)_90px_70px_120px]',
        )}
      >
        <span>{t('table.offer')}</span>
        {showSeller && <span>{t('table.seller')}</span>}
        <span>{t('table.delivery')}</span>
        <span>{t('table.stock')}</span>
        <span className="text-end">{t('table.price')}</span>
      </div>
      <ul className="m-0 list-none p-0">
        {offers.map((o) => (
          <li key={o.id} className="group relative border-b border-border/70 last:border-b-0 hover:bg-secondary/40">
            <div
              className={cn(
                'grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 px-4 py-3.5 md:items-center',
                showSeller ? 'md:grid-cols-[minmax(0,2.4fr)_minmax(0,1.3fr)_90px_70px_120px]' : 'md:grid-cols-[minmax(0,3fr)_90px_70px_120px]',
              )}
            >
              <div className="col-span-2 min-w-0 md:col-span-1">
                {showGame && (
                  <div className="mb-0.5 font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                    {o.game} · {categoryLabel(o.category_slug)}
                  </div>
                )}
                <Link to={`/offers/${o.id}`} className="block font-medium leading-snug no-underline after:absolute after:inset-0 group-hover:underline">
                  {o.title}
                </Link>
                <AttributeLine offer={o} />
                <ProtectionTag offer={o} />
              </div>
              {showSeller && (
                <div className="relative z-[1] order-1 flex min-w-0 items-center gap-2.5 md:order-none">
                  <Avatar name={o.seller_name} className="size-8 text-xs" />
                  <div className="min-w-0">
                    <Link to={`/sellers/${o.seller_id}`} className="block truncate text-sm font-medium no-underline hover:underline">{o.seller_name}</Link>
                    <Rating value={o.seller_rating} count={o.seller_review_count} />
                  </div>
                </div>
              )}
              <div className="order-3 col-span-2 flex items-center gap-3 md:order-none md:col-span-1 md:block">
                <DeliveryTag offer={o as any} />
                <span className="font-mono text-xs text-muted-foreground md:hidden">· {t('table.inStock', { n: o.stock })}</span>
              </div>
              <span className="hidden font-mono text-sm text-muted-foreground md:block">{o.stock}</span>
              <div className="order-2 flex flex-col items-end justify-center md:order-none">
                <span className="font-mono text-base font-semibold">{price.offer(o as any)}</span>
                {!!o.price_tiers?.length && (
                  <span className="text-xs text-released">{t('tier.bulkFrom', { price: money(o.price_tiers.at(-1)!.priceCents, o.currency), qty: o.price_tiers.at(-1)!.minQty })}</span>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function GameCard({ game, offers, min, categories }: { game: string; offers: number; min: number; categories: Array<{ slug: string; count: number }> }) {
  const price = usePrice();
  return (
    <Link to={`/games/${slugify(game)}`} className="group block overflow-hidden rounded-xl border border-border bg-card no-underline transition hover:-translate-y-0.5 hover:border-foreground hover:shadow-[0_14px_30px_-18px_rgba(22,32,46,.45)]">
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
    [Zap, t('trust.instant'), t('trust.instant.text')],
    [BadgeCheck, t('trust.insurance'), t('trust.insurance.text')],
    [Star, t('trust.reviews'), t('trust.reviews.text')],
  ] as const;
  return (
    <div className={cn('grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-4', className)}>
      {items.map(([Icon, title, text]) => (
        <div key={title} className="flex gap-3 bg-card p-4">
          <Icon className="mt-0.5 size-5 shrink-0 text-released" strokeWidth={1.8} />
          <div>
            <div className="text-sm font-semibold">{title}</div>
            <div className="text-xs leading-snug text-muted-foreground">{text}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
