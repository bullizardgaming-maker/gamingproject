import type { FastifyInstance } from 'fastify';
import { verifyMessage } from 'ethers';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { many, maybeOne, one } from '../db.js';
import { featureListing, foundingStatus, listRanks, pricePreview, sellerTier, unfeatureListing } from '../domain/commission.js';
import { relistExpired } from '../domain/leagues.js';
import { MAX_SHOWN_BADGES, earnedBadges, setShownBadges, shownBadges } from '../domain/badges.js';
import { onboardingStatus, rulesTestFor, submitRulesTest } from '../domain/onboarding.js';
import { recordSignals } from '../domain/fraud.js';
import { sellerAvailable } from '../domain/ledger.js';
import { EFFECTIVE_MIN_QTY_SQL, createOffer, getOffer, requireSeller, submitOwnerProof, updateOffer, uploadInventory, duplicateOffer, previewOffer, priceGuide, setListingState } from '../domain/offers.js';
import { createSellerCode, endSale, listSellerCodes, setSale, setSellerCodeActive } from '../domain/discounts.js';
import { trustSummary } from '../domain/trust.js';
import { exportListings, importListings } from '../domain/bulkListings.js';
import { listLinked, startLink, unlink } from '../domain/linkedAccounts.js';
import { DELIVERY_TIME_KEYS, MAX_VOLUME_DISCOUNTS, MAX_VOLUME_PERCENT, parseUnitPrice } from '../domain/unitPrice.js';
import { ACCENTS, MAX_INTRO, MAX_PINNED, deleteBanner, storefront, updateStorefront, uploadBanner } from '../domain/storefront.js';
import { confirmPayoutAddress, payoutAddressOf, removePayoutAddress, requestCryptoWithdrawal, requestPayoutAddress, withdrawalFee } from '../domain/cryptoPayouts.js';
import { NowPaymentsProvider } from '../providers/payments/nowpayments.js';
import { withdrawable } from '../domain/payoutholds.js';
import { EXPORT_KINDS, buildExport, exportRange, toCsv, type ExportKind } from '../domain/exports.js';
import { screenUser } from '../domain/aml.js';
import { payoutCurrency, sellerBalances, setPayoutCurrency } from '../domain/sellerfx.js';
import { getTaxProfile, setTaxProfile } from '../domain/tax.js';
import { getInvoice, invoicePdf, listInvoices } from '../domain/invoices.js';
import { listCreditNotes } from '../domain/clawback.js';
import { sellerAnalytics } from '../domain/analytics.js';
import { sellerDebts, shopHeldForDebt, startDebtPayment } from '../domain/debts.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { me } from '../server.js';

/** Query of the seller exports (statement, orders, payouts…). */
const ExportQuery = z.object({
  from: z.string().date().optional(), // default: first day of this month
  to: z.string().date().optional(), // exclusive; default tomorrow; at most one year after from
  currency: z.string().length(3).toUpperCase().optional(), // statement only: which balance (default: the payout currency)
  format: z.enum(['csv', 'json']).default('csv'),
});

const Id = z.object({ id: z.string().uuid() });

export const OfferBody = z.object({
  categorySlug: z.string(),
  game: z.string().trim().min(1).max(80),
  title: z.string().trim().max(140).optional().describe('Required except for currency listings (Round 26: their title is game · server · faction, built by the API)'),
  description: z.string().max(5_000).optional().describe('Round 26: shown on every listing; put delivery notes for the buyer here'),
  priceCents: z.number().int().positive().max(100_000_00).optional().describe('Price of one unit in minor units (required except for currency listings, which give unitPrice)'),
  currency: z.string().length(3).toUpperCase().optional().describe('Listing currency (e.g. USD, EUR, EGP)'),
  deliveryMode: z.enum(['auto', 'manual']),
  stock: z.number().int().min(0).max(2_000_000_000).optional(),
  lowStockThreshold: z.number().int().min(0).max(100_000).optional(),
  deliveryHours: z.number().int().min(1).max(72).optional().describe('Promised delivery time in hours (older clients; see deliveryMinutes)'),
  deliveryTime: z.enum(DELIVERY_TIME_KEYS as [string, ...string[]]).optional().describe('Round 25 list value (15m, 1h, 3h, 6h, 12h, 24h); still accepted'),
  unitPrice: z.string().max(20).optional().describe('Round 25, currency listings: price of one unit with up to 6 decimals, e.g. "0.000123"'),
  unitPriceMicros: z.number().int().positive().max(100_000_00 * 10_000).optional().describe('Round 25, currency listings: the same in micro-units (123 = 0.000123)'),
  volumeDiscounts: z
    .array(
      z.union([
        z.object({ minQty: z.number().int().min(2).max(2_000_000_000), type: z.enum(['percent', 'fixed']), value: z.number().int().min(1).max(100_000_00 * 10_000) }),
        z.object({ minQty: z.number().int().min(2).max(2_000_000_000), percentOff: z.number().int().min(1).max(MAX_VOLUME_PERCENT) }),
      ]),
    )
    .max(MAX_VOLUME_DISCOUNTS)
    .optional()
    .describe('Round 26b, currency listings: up to 4 tiers {minQty, type: "percent" (value 1–50) | "fixed" (value = unit price in micros, below the base and the previous tier)}; the Round 25 {minQty, percentOff} spelling still works. Send [] to remove.'),
  warrantyDays: z.union([z.literal(0), z.literal(7), z.literal(14), z.literal(30), z.literal(60), z.literal(90)]).optional().describe('Account listings only: a warranty after escrow releases, in days'),
  linkedAccountId: z.string().uuid().nullable().optional().describe('Account listings: a Steam/Riot account you linked (GET /v1/seller/linked-accounts); null detaches'),
  attributes: z.record(z.string().max(30), z.string().max(60)).optional().describe('Game-specific fields such as server, region, platform or rank (GET /v1/catalog/attributes)'),
  bundle: z
    .array(z.object({ offerId: z.string().uuid(), quantity: z.number().int().min(1).max(20) }))
    .min(2)
    .max(10)
    .optional()
    .describe('Make this listing a bundle of your own instant-delivery listings (2–10), delivered from their stock'),
  priceTiers: z
    .array(z.object({ minQty: z.number().int().min(2).max(100_000), priceCents: z.number().int().positive().max(100_000_00) }))
    .max(5)
    .optional()
    .describe('Cheaper unit prices for larger orders, e.g. [{"minQty":10,"priceCents":450}]. Send [] to remove.'),
  unitLabel: z.string().trim().max(12).nullable().optional().describe('Currency sold by amount: what one unit of quantity is, e.g. "M", "k", "orbs"'),
  unitSize: z.number().int().min(1).max(1_000_000_000_000).nullable().optional().describe('Game currency per unit, e.g. 1000000 for "M"'),
  minQty: z.number().int().min(1).max(2_000_000_000).optional().describe('Smallest order, in units (default 1)'),
  maxQty: z.number().int().nullable().optional().describe('Ignored (Round 26b): the most a buyer may order is the stock'),
  deliveryMinutes: z.number().int().min(1).max(72 * 60).optional().describe('Round 26b: the delivery time the seller typed, in minutes (1 – 4320); hours × 60'),
  deliveryMethods: z.array(z.string().max(20)).max(10).nullable().optional().describe('Round 24: delivery methods from the game\'s list (f2f, mail, market, uid), at least one; null = all'),
});

/**
 * Round 25: `unitPrice` ("0.000123") becomes unitPriceMicros (both may not disagree). `minBuyerReputation` and
 * `establishedBuyersOnly` are no longer read: zod drops them, so an older client sending them still works.
 */
function offerInput<T extends { unitPrice?: string; unitPriceMicros?: number; deliveryTime?: string }>(body: T) {
  const { unitPrice, ...rest } = body;
  let micros = body.unitPriceMicros;
  if (unitPrice != null) {
    const parsed = parseUnitPrice(unitPrice);
    if (parsed == null || parsed < 1) throw badRequest('invalid_unit_price', 'The unit price is a number with up to 6 decimals, e.g. 0.000123');
    if (micros != null && micros !== parsed) throw badRequest('invalid_unit_price', 'unitPrice and unitPriceMicros disagree');
    micros = parsed;
  }
  return { ...rest, unitPriceMicros: micros } as Omit<T, 'unitPrice' | 'deliveryTime'> & { unitPriceMicros?: number; deliveryTime?: any };
}

export const InventoryBody = z.object({
  format: z.enum(['txt', 'json']),
  content: z.string().min(1).max(10 * 1024 * 1024),
});

export async function sellerRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/seller/dashboard', async (req) => {
    const user = me(req);
    const currency = await payoutCurrency(ctx, ctx.db, user.id);
    const hold = await withdrawable(ctx, ctx.db, user.id, currency);
    const [tier, available, stats, escrow] = await Promise.all([
      sellerTier(ctx.db, user.id),
      sellerAvailable(ctx.db, user.id, currency),
      one(
        ctx.db,
        `SELECT count(*) FILTER (WHERE status = 'completed')::int AS completed,
                count(*) FILTER (WHERE status IN ('paid', 'delivered'))::int AS in_progress,
                count(*) FILTER (WHERE status = 'disputed')::int AS disputed,
                count(*) FILTER (WHERE status = 'charged_back')::int AS charged_back
           FROM orders WHERE seller_id = $1`,
        [user.id],
      ),
      one(ctx.db, `SELECT COALESCE(SUM(seller_net_cents), 0)::bigint AS pending FROM orders WHERE seller_id = $1 AND status IN ('paid', 'delivered', 'disputed') AND rail = 'fiat'`, [user.id]),
    ]);
    return {
      tier: tier.tier,
      monthlySalesCents: tier.monthlySalesCents,
      next: tier.next,
      rank: tier.rank,
      rateBps: tier.rateBps,
      promo: tier.promo,
      tiers: (await listRanks(ctx.db)).map((r) => ({ ...r, accountRateBps: r.rateBps, otherRateBps: r.rateBps })),
      onboarding: await onboardingStatus(ctx.db, user.id),
      founding: await foundingStatus(ctx.db, user.id),
      payoutCurrency: currency,
      balances: { currency, availableCents: available, pendingEscrowCents: escrow.pending, withdrawableCents: hold.withdrawableCents, onHoldCents: hold.heldCents },
      allBalances: await sellerBalances(ctx.db, user.id),
      debts: await sellerDebts(ctx, user.id),
      payoutHold: { level: hold.level, days: hold.holdDays, upcoming: hold.upcoming },
      withdrawalsFrozen: user.withdrawals_frozen,
      shop: await one(
        ctx.db,
        `SELECT (shop_paused AND (shop_paused_until IS NULL OR shop_paused_until > now())) AS paused,
                shop_paused_until AS until, shop_pause_message AS message, show_online AS "showOnline",
                response_minutes AS "responseMinutes", response_sample AS "responseSample" FROM users WHERE id = $1`,
        [user.id],
      ),
      stats,
    };
  });

  /** The seller's trust level, the numbers behind it and what the next level needs. */
  app.get('/seller/trust', async (req) => trustSummary(ctx.db, me(req).id));

  // --- Linked game accounts (Steam / Riot sign-in) ------------------------------------------
  app.get('/seller/linked-accounts', async (req) => listLinked(ctx.db, me(req).id));
  app.post('/seller/linked-accounts/:provider/start', async (req) => {
    const user = me(req);
    requireSeller(user);
    const { provider } = z.object({ provider: z.enum(['steam', 'riot']) }).parse(req.params);
    const body = z.object({ mockAccount: z.string().max(80).optional() }).parse(req.body ?? {});
    return startLink(ctx, user.id, provider, body);
  });
  app.delete('/seller/linked-accounts/:id', async (req) => {
    await unlink(ctx, me(req).id, Id.parse(req.params).id);
    return listLinked(ctx.db, me(req).id);
  });

  // --- Bulk listings: CSV export and import (preview first) ---------------------------------
  app.get('/seller/listings/export.csv', async (req, reply) => {
    const csv = await exportListings(ctx.db, me(req).id);
    return reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="bullizard-listings.csv"').send(csv);
  });
  app.post('/seller/listings/import', async (req) => {
    const user = me(req);
    requireSeller(user);
    const body = z.object({ csv: z.string().min(1).max(2_000_000), dryRun: z.boolean().default(true) }).parse(req.body);
    return importListings(ctx, user, body.csv, { dryRun: body.dryRun });
  });

  // --- Badges: up to two of the earned ones, shown next to the seller's name --------------------
  app.get('/seller/badges', async (req) => {
    const user = me(req);
    return { badges: await shownBadges(ctx.db, user.id), earned: await earnedBadges(ctx.db, user.id) };
  });
  app.put('/seller/badges', async (req) => {
    const user = me(req);
    const { badges } = z.object({ badges: z.array(z.string().trim().min(1).max(40)).max(MAX_SHOWN_BADGES) }).parse(req.body);
    return setShownBadges(ctx.db, user.id, badges);
  });

  // --- Storefront: banner, intro (about), accent, pinned (featured) listings, languages ----------
  app.get('/seller/storefront', async (req) => storefront(ctx.db, me(req).id));
  app.put('/seller/storefront', async (req) => {
    const user = me(req);
    requireSeller(user);
    const body = z
      .object({
        intro: z.string().max(MAX_INTRO + 100).optional(),
        accent: z.enum(ACCENTS).optional(),
        pinned: z.array(z.string().uuid()).max(MAX_PINNED).optional(),
        languages: z.array(z.string().trim().regex(/^[A-Za-z]{2,3}(-[A-Za-z]{2,4})?$/, 'BCP-47 language codes such as en, ar, pt-BR')).max(8).optional(),
      })
      .parse(req.body);
    return updateStorefront(ctx, user.id, body);
  });
  /** Banner image: raw PNG/JPEG/WebP body, cropped to 1500×400. */
  app.post('/seller/storefront/banner', async (req) => {
    const user = me(req);
    requireSeller(user);
    if (!Buffer.isBuffer(req.body)) throw badRequest('unsupported_file', 'Send the image bytes with Content-Type image/png, image/jpeg or image/webp');
    return uploadBanner(ctx, user.id, req.body);
  });
  app.delete('/seller/storefront/banner', async (req) => {
    await deleteBanner(ctx, me(req).id);
    return storefront(ctx.db, me(req).id);
  });

  app.get('/seller/analytics', async (req) => {
    const user = me(req);
    requireSeller(user);
    const { days } = z.object({ days: z.coerce.number().pipe(z.union([z.literal(7), z.literal(30), z.literal(90), z.literal(365)])).default(30) }).parse(req.query);
    return sellerAnalytics(ctx.dbRead, user.id, days);
  });

  // --- Offers & inventory ------------------------------------------------------------
  app.get('/seller/offers', async (req) =>
    many(
      ctx.db,
      `SELECT f.*, CASE WHEN f.status = 'active' AND f.available <= 0 THEN 'out_of_stock' ELSE f.status END AS listing_state,
              ${EFFECTIVE_MIN_QTY_SQL} AS effective_min_qty,
              (SELECT count(*)::int FROM orders o WHERE o.offer_id = f.id AND o.status IN ('awaiting_payment', 'paid', 'delivered', 'disputed')) AS open_orders
         FROM offers f WHERE seller_id = $1 AND status <> 'removed' ORDER BY created_at DESC`,
      [me(req).id],
    ),
  );

  app.post('/offers', async (req, reply) => reply.status(201).send(await createOffer(ctx, me(req), offerInput(OfferBody.parse(req.body)))));
  /** Round 26 (B10): the listing as the buyer will see it (buyer prices at the seller's rate), without creating it. */
  /** Round 26b: the market for a game + server (+ faction) — lowest / median / recommended buyer unit price, as micros, and the same as the seller's net. */
  app.get('/offers/price-guide', async (req) => {
    const q = z.object({ game: z.string().trim().min(1).max(80), server: z.string().trim().min(1).max(60).optional(), faction: z.string().trim().min(1).max(60).optional(), category: z.string().trim().min(1).max(40).default('currency') }).parse(req.query);
    requireSeller(me(req));
    return priceGuide(ctx, me(req), q);
  });
  app.post('/offers/preview', async (req) => previewOffer(ctx, me(req), offerInput(OfferBody.parse(req.body))));
  /** Round 26 (B3): copy a listing to another server; stock starts at what the seller enters. */
  app.post('/offers/:id/duplicate', async (req, reply) => {
    const body = z.object({ attributes: z.record(z.string().max(30), z.string().max(60)).optional(), stock: z.number().int().min(0).max(2_000_000_000).optional() }).parse(req.body ?? {});
    return reply.status(201).send(await duplicateOffer(ctx, me(req), Id.parse(req.params).id, body));
  });
  /** Round 26 (B2): pause / resume / soft delete (open orders → pause only). */
  app.post('/offers/:id/pause', async (req) => setListingState(ctx, me(req).id, Id.parse(req.params).id, 'pause'));
  app.post('/offers/:id/resume', async (req) => {
    requireSeller(me(req)); // Round 26c (H1): a banned or ID-overdue seller cannot bring listings back
    return setListingState(ctx, me(req).id, Id.parse(req.params).id, 'resume');
  });
  app.delete('/offers/:id', async (req) => setListingState(ctx, me(req).id, Id.parse(req.params).id, 'delete'));

  /** Founding Sellers: free featured spots during the launch (see dashboard.founding for the allowance). */
  app.post('/offers/:id/feature', async (req) => featureListing(ctx, me(req).id, Id.parse(req.params).id));
  app.delete('/offers/:id/feature', async (req) => unfeatureListing(ctx, me(req).id, Id.parse(req.params).id));
  /** Bring a listing expired by a league ending back, in an open league. */
  app.post('/offers/:id/relist', async (req) => {
    const { league } = z.object({ league: z.string().trim().min(1).max(60) }).parse(req.body);
    await relistExpired(ctx, me(req).id, Id.parse(req.params).id, league);
    return getOffer(ctx.db, Id.parse(req.params).id);
  });
  app.patch('/offers/:id', async (req) => {
    const body = OfferBody.pick({ title: true, description: true, priceCents: true, stock: true, lowStockThreshold: true, deliveryHours: true, deliveryTime: true, attributes: true, priceTiers: true, warrantyDays: true, linkedAccountId: true, unitLabel: true, unitSize: true, minQty: true, maxQty: true, deliveryMethods: true, unitPrice: true, unitPriceMicros: true, volumeDiscounts: true, deliveryMinutes: true })
      .partial()
      .extend({ version: z.number().int().min(0), status: z.enum(['active', 'paused', 'removed']).optional() })
      .parse(req.body);
    const { version, ...patch } = body;
    if (patch.status === 'active') requireSeller(me(req)); // Round 26c (H1)
    return updateOffer(ctx, me(req).id, Id.parse(req.params).id, version, offerInput(patch));
  });

  app.post('/offers/:id/inventory', async (req) => {
    const user = me(req);
    requireSeller(user);
    const body = InventoryBody.parse(req.body);
    return uploadInventory(ctx, user.id, Id.parse(req.params).id, body.format, body.content);
  });

  app.post('/offers/:id/owner-proof', async (req, reply) => {
    const user = me(req);
    requireSeller(user);
    const body = z
      .object({
        registrationEmail: z.string().email(),
        registrationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        billingName: z.string().max(120).optional(),
        evidence: z.record(z.string(), z.unknown()).default({}),
      })
      .parse(req.body);
    return reply.status(201).send(await submitOwnerProof(ctx, user.id, Id.parse(req.params).id, body));
  });

  // --- Payouts ------------------------------------------------------------------
  app.post('/seller/withdrawals', async (req, reply) => {
    const user = me(req);
    const body = z.object({ amountCents: z.number().int().positive(), currency: z.string().length(3).toUpperCase().optional() }).parse(req.body);
    const currency = body.currency ?? 'USD'; // Round 22b: withdrawals are USD only (anything else: 400 unsupported_currency)
    // Round 25: USDT only (TRC-20 / BEP-20), 6% fee with a $1.50 minimum; no card-era transfer path.
    return reply.status(201).send(await requestCryptoWithdrawal(ctx, user.id, body.amountCents, currency));
  });
  /** Sell-form preview: buyer price at the seller's rate and what is left after the withdrawal fee. */
  // ---- Onboarding: the rules test before the first listing; the ID deadline on the dashboard ----
  app.get('/seller/rules-test', async (req) => rulesTestFor(ctx.db, me(req), z.object({ lang: z.string().max(10).optional() }).parse(req.query).lang ?? me(req).locale ?? 'en'));
  app.post('/seller/rules-test', async (req) => {
    const { answers, lang } = z.object({ answers: z.record(z.string().uuid(), z.number().int().min(0).max(9)), lang: z.string().max(10).optional() }).parse(req.body);
    return submitRulesTest(ctx, me(req), answers, lang ?? me(req).locale ?? 'en');
  });
  app.get('/seller/onboarding', async (req) => onboardingStatus(ctx.db, me(req).id));

  app.get('/seller/price-preview', async (req) => {
    const q = z.object({ priceCents: z.coerce.number().int().positive().max(100_000_00), currency: z.string().length(3).toUpperCase().optional() }).parse(req.query);
    return pricePreview(ctx, me(req).id, q.priceCents, q.currency);
  });

  /** What a withdrawal of this size costs (6%, at least 1.50) and what arrives. */
  app.get('/seller/withdrawals/quote', async (req) => {
    // Round 24: the web asks only once an amount is typed; an empty, zero or malformed amount is a clear 400, never a 500.
    const raw = (req.query as Record<string, unknown> | undefined)?.amountCents;
    const amountCents = typeof raw === 'string' && /^\d{1,12}$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
    if (!(amountCents > 0)) throw badRequest('amount_required', 'Enter an amount to see the fee');
    const fee = withdrawalFee(ctx, amountCents);
    return { amountCents, feeCents: fee, netCents: amountCents - fee, feeBps: ctx.cfg.WITHDRAWAL_FEE_BPS, feeMinCents: ctx.cfg.WITHDRAWAL_FEE_MIN_CENTS };
  });

  // --- Crypto payout address: confirmed by email link (+ 2FA when on) ------------------------
  app.get('/seller/payout-address', async (req) => payoutAddressOf(ctx.db, me(req).id));
  app.post('/seller/payout-address', async (req) => {
    const body = z.object({ address: z.string().trim().min(10).max(128), currency: z.string().min(2).max(20) }).parse(req.body);
    return requestPayoutAddress(ctx, me(req), body);
  });
  app.post('/seller/payout-address/confirm', async (req) => {
    const body = z.object({ token: z.string().min(10).max(200), code: z.string().trim().min(6).max(12).optional() }).parse(req.body);
    return confirmPayoutAddress(ctx, me(req), body);
  });
  app.delete('/seller/payout-address', async (req) => removePayoutAddress(ctx, me(req).id));

  /** Currency new sales are credited and paid out in (the buyer's conversion is the only one). */
  app.put('/seller/payout-currency', async (req) => {
    const { currency } = z.object({ currency: z.string().length(3) }).parse(req.body);
    return setPayoutCurrency(ctx, me(req).id, currency);
  });

  /** Holiday mode: listings disappear from the market and can't be bought until resumed (or `until` passes). */
  app.put('/seller/shop-status', async (req) => {
    const user = me(req);
    const body = z
      .object({ paused: z.boolean(), until: z.string().datetime().optional(), message: z.string().trim().max(200).optional() })
      .parse(req.body);
    if (body.until && new Date(body.until) <= new Date()) throw badRequest('invalid_until', 'Pick a time in the future');
    if (!body.paused && (await shopHeldForDebt(ctx.db, user.id))) {
      throw new AppError(409, 'debt_outstanding', 'Your shop reopens as soon as your balance is settled');
    }
    const row = await one(
      ctx.db,
      `UPDATE users SET shop_paused = $2, shop_paused_until = $3, shop_pause_message = $4 WHERE id = $1
       RETURNING shop_paused AS paused, shop_paused_until AS until, shop_pause_message AS message`,
      [user.id, body.paused, body.paused ? body.until ?? null : null, body.paused ? body.message ?? null : null],
    );
    const open = await one<{ n: number }>(ctx.db, `SELECT count(*)::int AS n FROM orders WHERE seller_id = $1 AND status = 'paid'`, [user.id]);
    return { ...row, ordersStillToDeliver: open.n };
  });

  // ---- Seller-funded discounts: timed sales and discount codes ----
  app.put('/offers/:id/sale', async (req) => {
    const user = me(req);
    requireSeller(user);
    const body = z.object({ salePriceCents: z.number().int().positive().max(100_000_00), startsAt: z.string().datetime().optional(), endsAt: z.string().datetime() }).parse(req.body);
    await setSale(ctx, user.id, Id.parse(req.params).id, body);
    return getOffer(ctx.db, Id.parse(req.params).id);
  });
  app.delete('/offers/:id/sale', async (req) => {
    const user = me(req);
    await endSale(ctx, user.id, Id.parse(req.params).id);
    return getOffer(ctx.db, Id.parse(req.params).id);
  });
  app.get('/seller/codes', async (req) => listSellerCodes(ctx.db, me(req).id));
  app.post('/seller/codes', async (req, reply) => {
    const user = me(req);
    requireSeller(user);
    const body = z
      .object({
        code: z.string().trim().min(3).max(30).regex(/^[A-Za-z0-9_-]+$/, 'Letters, digits, - and _ only'),
        percentOff: z.number().int().min(1).max(90),
        minOrderCents: z.number().int().min(0).max(100_000_00).optional(),
        maxUses: z.number().int().positive().max(1_000_000).optional(),
        perBuyerLimit: z.number().int().positive().max(100).optional(),
        startsAt: z.string().datetime().optional(),
        endsAt: z.string().datetime().optional(),
      })
      .parse(req.body);
    return reply.status(201).send(await createSellerCode(ctx.db, user.id, body));
  });
  app.patch('/seller/codes/:id', async (req) => {
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    return setSellerCodeActive(ctx.db, me(req).id, Id.parse(req.params).id, active);
  });

  /** Whether buyers see "Online now" for this seller. */
  app.put('/seller/presence', async (req) => {
    const { showOnline } = z.object({ showOnline: z.boolean() }).parse(req.body);
    return one(ctx.db, 'UPDATE users SET show_online = $2 WHERE id = $1 RETURNING show_online AS "showOnline"', [me(req).id, showOnline]);
  });


  // --- Tax profile & commission invoices -------------------------------------------------
  app.get('/seller/tax-profile', async (req) => getTaxProfile(ctx, me(req).id));
  app.put('/seller/tax-profile', async (req) => {
    const body = z
      .object({
        country: z.string().length(2).regex(/^[A-Za-z]{2}$/),
        isBusiness: z.boolean(),
        taxId: z.string().trim().max(20).nullable().optional(),
        billingAddress: z.string().trim().max(300).nullable().optional(),
      })
      .parse(req.body);
    return setTaxProfile(ctx, me(req).id, body);
  });
  app.get('/seller/invoices', async (req) => listInvoices(ctx, me(req).id));
  app.get('/seller/credit-notes', async (req) => listCreditNotes(ctx, me(req).id));
  app.get('/seller/invoices/:id', async (req) => getInvoice(ctx, Id.parse(req.params).id, me(req).id));
  app.get('/seller/invoices/:id/pdf', async (req, reply) => {
    const inv = await getInvoice(ctx, Id.parse(req.params).id, me(req).id);
    reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `attachment; filename="${inv.number}.pdf"`);
    return reply.send(await invoicePdf(inv));
  });

  const sendExport = async (req: any, reply: any, sellerId: string, kind: ExportKind) => {
    const q = ExportQuery.parse(req.query);
    const range = exportRange(q.from, q.to);
    const currency = q.currency ?? (await payoutCurrency(ctx, ctx.db, sellerId));
    const out = await buildExport(ctx.dbRead, sellerId, kind, range, currency);
    if (q.format === 'json') return { kind, ...range, currency: kind === 'statement' ? currency : undefined, rows: out.rows };
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="bullizard-${kind}-${range.from}-to-${range.to}.csv"`);
    return toCsv(out.columns, out.rows);
  };
  app.get('/seller/exports/:kind', async (req, reply) => {
    const { kind } = z.object({ kind: z.enum(EXPORT_KINDS) }).parse(req.params);
    return sendExport(req, reply, me(req).id, kind);
  });

  app.get('/seller/payout-hold', async (req) => {
    const { currency } = z.object({ currency: z.string().length(3).toUpperCase().optional() }).parse(req.query);
    const id = me(req).id;
    return withdrawable(ctx, ctx.db, id, currency ?? (await payoutCurrency(ctx, ctx.db, id)));
  });
  app.get('/seller/debts', async (req) => sellerDebts(ctx, me(req).id));
  app.post('/seller/debts/:id/pay', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { amountCents } = z.object({ amountCents: z.number().int().positive().optional() }).parse(req.body ?? {});
    const user = me(req);
    return reply.status(201).send(await startDebtPayment(ctx, user, id, amountCents));
  });
  app.get('/seller/withdrawals', async (req) => many(ctx.db, 'SELECT * FROM withdrawals WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100', [me(req).id]));

  /** Link a self-custody wallet (for crypto escrow payouts), proven by a personal_sign signature. */
  app.post('/me/wallet', async (req) => {
    const user = me(req);
    const { address, signature } = z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/), signature: z.string() }).parse(req.body);
    const message = `Link wallet ${address.toLowerCase()} to Bullizard account ${user.id}`;
    let recovered: string;
    try {
      recovered = verifyMessage(message, signature);
    } catch {
      throw badRequest('invalid_signature', 'Signature could not be verified');
    }
    if (recovered.toLowerCase() !== address.toLowerCase()) throw badRequest('invalid_signature', `Sign exactly: "${message}"`);
    await ctx.db.query('UPDATE users SET wallet_address = $2 WHERE id = $1', [user.id, address.toLowerCase()]);
    await recordSignals(ctx.db, user.id, { wallet: address.toLowerCase() });
    await screenUser(ctx, user.id);
    return { wallet: address.toLowerCase() };
  });
}
