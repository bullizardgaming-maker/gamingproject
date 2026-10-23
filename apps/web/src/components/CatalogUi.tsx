import { useId } from 'react';
import { Link } from 'react-router-dom';
import { money } from '../api';
import { Medal as Award, SealCheck as BadgeCheck, Coins, GameController as Gamepad2, Gift, Key as KeyRound, RocketLaunch as Rocket, ShieldCheck, DeviceMobile as Smartphone, Star, Sword as Swords, UserCircle as UserRound, VideoCamera as Video, Lightning as Zap } from '@phosphor-icons/react';
import { categoryLabel, deliveryLabel, initials } from '@/lib/catalog';
import { cn } from '@/lib/utils';
import { attributePairs } from '@/lib/attributes';
import { usePrice } from '@/lib/prefs';
import { unitPriceFor } from '@/lib/tiers';
import type { Offer } from '../pages/Market';
import { OnlineDot, lastSeenLabel } from '@/lib/presence';
import { intlLocale, t, type MessageKey } from '../i18n';
import { isTopRank, rankName, rankPerk } from '@/lib/ranks';

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

export function Avatar({ name, className }: { name: string; className?: string }) {
  return (
    <span aria-hidden className={cn('avatar-ini grid size-9 shrink-0 place-items-center rounded-full text-sm font-bold', className)}>
      {initials(name)}
    </span>
  );
}

export function Rating({ value, count, className }: { value: number | string | null; count: number; className?: string }) {
  if (!count || value == null) return <span className={cn('text-xs text-muted-foreground', className)}>{t('rating.new')}</span>;
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs text-muted-foreground', className)}>
      <Star className="size-3.5 text-held" weight="fill" />
      <b className="font-mono text-foreground">{Number(value).toFixed(2)}</b>
      <span>({count.toLocaleString()})</span>
    </span>
  );
}

export function DeliveryTag({ offer }: { offer: Pick<Offer, 'delivery_mode'> & { delivery_hours?: number | null } }) {
  const instant = offer.delivery_mode === 'auto';
  return (
    <span className={cn('inline-flex items-center gap-1 whitespace-nowrap font-mono text-xs', instant ? 'text-released' : 'text-muted-foreground')}>
      {instant && <Zap className="size-3.5" weight="fill" />}
      {deliveryLabel(offer.delivery_mode, offer.delivery_hours)}
    </span>
  );
}

export function ProtectionTag({ offer }: { offer: Offer }) {
  if (offer.category_kind !== 'account') return null;
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
                <Link id={`${uid}-${o.id}`} to={`/offers/${o.id}`} className="lt-title after:absolute after:inset-0" dir="auto">{o.title}</Link>
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
  return <span className={cn('rank', isTopRank(name) && 'top', className)} title={rankPerk(name) || undefined} data-rank={name}>{rankName(name)}</span>;
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
          <Icon className="trust-icon size-5" aria-hidden />
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

/** Seller picture with the online dot on it (green while online). */
export function SellerAvatar({ name, online, className, size = 'size-10' }: { name: string; online?: boolean; className?: string; size?: string }) {
  return (
    <span className={cn('relative inline-flex shrink-0', className)}>
      <Avatar name={name} className={size} />
      {online && <span className="sa-dot" role="img" aria-label={t('presence.online')} title={t('presence.online')} />}
    </span>
  );
}

/** The two badges a seller chose to show. */
export function SellerBadges({ badges }: { badges?: string[] | null }) {
  if (!badges?.length) return null;
  return (
    <>
      {badges.slice(0, 2).map((b) => <SellerBadge key={b} badge={b} />)}
    </>
  );
}

/** One badge by its API key: rank:<name>, founding, id_verified, top_seller. */
export function SellerBadge({ badge: b }: { badge: string }) {
  if (b.startsWith('rank:')) return <RankPill name={b.slice(5).replace(/^./, (c) => c.toUpperCase())} />;
  if (b === 'founding') return <FoundingBadge />;
  if (b === 'top_seller' || b === 'trust:top') return <TrustBadge level="top" />;
  if (b.startsWith('trust:')) return <TrustBadge level={b.slice(6)} />;
  return <span className="rank"><BadgeCheck className="size-3" aria-hidden /> {t('badge.idVerified')}</span>;
}

/** "Online now", or how long the seller has been away. */
export function PresenceText({ online, lastSeen }: { online?: boolean; lastSeen?: string | null }) {
  if (online) return <span className="presence on">{t('presence.online')}</span>;
  const l = lastSeenLabel(lastSeen);
  return l ? <span className="presence">{l}</span> : null;
}

/** Currency sold by amount, G2G / Eldorado style: seller first, then stock, minimum, delivery and the price per unit. */
export function CurrencyTable({ offers, empty, current }: { offers: Offer[]; empty?: React.ReactNode; current?: string }) {
  const price = usePrice();
  if (offers.length === 0) return <div className="card text-center text-muted-foreground">{empty ?? t('table.empty')}</div>;
  return (
    <ul className="ct" aria-label={t('ct.sellers')}>
      {offers.map((o) => (
        <li key={o.id} className={cn('ct-row', o.id === current && 'on')} aria-current={o.id === current || undefined}>
          {o.id === current && <span className="ct-current">{t('ct.current')}</span>}
          <div className="ct-seller">
            <SellerAvatar name={o.seller_name} online={o.seller_online} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <Link to={`/offers/${o.id}`} className="ct-name after:absolute after:inset-0" aria-label={o.unit_label ? undefined : `${o.title} · ${o.seller_name}`}>{o.seller_name}</Link>
                <SellerBadges badges={o.seller_badges} />
              </div>
              <Rating value={o.seller_rating} count={o.seller_review_count} />
              {!o.unit_label && <span className="block truncate text-xs text-muted-foreground" dir="auto">{o.title}</span>}
            </div>
          </div>
          <div className="ct-cell"><span className="ct-k">{t('ct.server')}</span><span>{Object.values(o.attributes ?? {}).slice(0, 2).join(' · ') || '—'}</span></div>
          <div className="ct-cell"><span className="ct-k">{t('table.stock')}</span><span className="num">{fmtUnits(o.stock, o.unit_label)}</span></div>
          <div className="ct-cell"><span className="ct-k">{t('ct.min')}</span><span className="num">{fmtUnits(o.min_qty ?? 1, o.unit_label)}</span></div>
          <div className="ct-cell"><span className="ct-k">{t('table.delivery')}</span><DeliveryTag offer={o as any} /></div>
          <div className="ct-price">
            <span><b className="num">{price.offer(o as any)}</b>{o.unit_label && <span className="small muted"> / {o.unit_label}</span>}</span>
            {!!o.price_tiers?.length && <span className="small text-released num">{t('tier.bulkFrom', { price: money(o.price_tiers.at(-1)!.priceCents, o.currency), qty: o.price_tiers.at(-1)!.minQty })}</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}
const fmtQty = (n: number) => n.toLocaleString(intlLocale());
/** "850 Divine Orb", or "850 × 1M" when the unit is itself a number. */
export const fmtUnits = (n: number, unit?: string | null) => `\u2066${!unit ? fmtQty(n) : /^\d/.test(unit) ? `${fmtQty(n)} × ${unit}` : `${fmtQty(n)} ${unit}`}\u2069`; // isolated so it reads left to right inside Arabic
