# Bullizard

A marketplace where gamers trade in-game currency, items, top-ups and (later) accounts. Every payment goes into escrow and is released only after proof of delivery and the buyer's confirmation. The design has one job: **make a stranger's money feel safe without making the place feel like a bank.**

This system evolves the codebase's "Frost" palette. The cool neutrals, the three money colours and the fonts stay as they are. On top of that it adds a brand accent (`rune`), a full Night Frost dark theme, fixed scales for spacing, radius and type, and the Bullizard mark, rank icons and signature motion.

## The logo

Two parts, always the same:

- **The mark:** the coin-eye. A coin ring with a lizard's slit pupil and one crescent of bull horns. Main brand symbol, app icon, favicon, avatars, the Founding Seller seal.
- **The name:** "Bullizard" in Alexandria 800. The B carries bull horns on top and a fang cut into its lower bowl.

- Files in `assets/Logos/`: `bullizard-mark.svg` / `bullizard-mark-light.svg` (the eye), `bullizard-mark-solid.svg` (under 20 px), `bullizard-logo.svg` / `bullizard-logo-light.svg` (the name, outlined so no font is needed), `bullizard-app-icon.svg` (dark eye on green). Use the files, never retype the name.
- Lockup: mark left of the name, the mark about 1.1× the name's height, gap = the ring's stroke × 3. Name alone is fine in tight headers.
- One colour per lockup: `ink` on light, `#eef1f5` on dark. Never two-tone, never a gradient, never on game art without a solid plate behind it.
- Arabic: بوليزارد in Alexandria 800 with the mark on its right, the reading side.

## Principles

1. **Colour means money.** `held`, `released` and `disputed` only ever describe where funds are (and `disputed` doubles as the error colour). Success ticks, passed tests and badges stay `ink`.
2. **One rune per view.** The green accent marks the single most important action or highlight: Buy, the active game, a promo, the Dragon rank. If two things are rune, one of them is wrong.
3. **Numbers line up.** Prices, balances, order IDs and timers use tabular figures.
4. **Two numbers, not a breakdown.** Buyers see one final price. Sellers see what the buyer pays and what they keep. Fee details live in the help center.
5. **Calm surfaces, game energy in content.** Game art, the mark and its one motion carry the excitement. Chrome stays quiet.

## Ranks

Hatchling → Scale → Fang → Basilisk → Dragon. Each icon adds detail (egg, scale, fangs, crowned eye, the full mark), and 1 to 5 pips count the level, so ranks read without colour. Icons are 24 px line art at 1.75 stroke, `currentColor`. Only Dragon uses `rune`. The Founding Seller badge is the mark inside an `ink` seal with "FOUNDING SELLER · BULLIZARD · 2026" on the ring. Fees and requirements per rank are set by the CEO.

## Motion

One signature moment: when an order's money changes state, the mark's pupil reacts. Held is a narrow slit in `held`. Released opens into a full coin in `released`. Disputed shuts to a line in `disputed`. 220 ms, ease-out, transform only, plays once, off under reduced motion. Everything else: hover changes background or border colour in 120 to 160 ms. No lifts, glows, scaling, looping or scroll-triggered effects.

## Voice

Plain, short, specific. Say what happens to the money.

- "Funds stay in escrow until you confirm delivery." Not "Your purchase is protected by our advanced system."
- "Confirm & release funds." Not "Complete."
- "Add your exact in-game nickname. Wrong names can't be refunded." State the buyer's responsibility up front.
- No hype words (epic, insane, legendary deals), no em dashes, no emoji in the interface.
- **Say it once.** A screen shows only what the user needs to act right now. Rules, fee breakdowns, what happens after day X, why something happened: one line at most, or a link into the help center. If the user already saw it earlier in the flow, don't repeat it.

## Colour

| Role | Token | Rule |
|---|---|---|
| Page / card / well | `frost` / `paper` / `raised` | Cards sit on frost with a `rule` border. No shadow unless the element floats (menus, popovers, sheets). |
| Text | `ink`, `steel` | `steel` for meta, never for prices. |
| Brand | `rune`, `rune-soft`, `on-rune` | Buy buttons, active nav, promos, Dragon. A fill with `on-rune` (dark) text. Never green text on a light background (2.5:1); links stay `ink`. |
| Money | `held*`, `released*`, `disputed*` | Fill + `-soft` background + `-ink` text. Never use one for another meaning. |
| Charts | `viz-1`, `viz-2` | Price history. Blue and orange are safe for colour-blind users. |

Night Frost is a real theme, not an inverted one. Gamers browse at night, so dark mode is first-class.

## Type

- **Alexandria** (Google Fonts): headings at 800, the logo, and all Arabic text (it covers Latin and Arabic in one design).
- **Inter**: English body text, labels and numbers. Prices, balances, IDs and timers at 600 with tabular figures (`font-variant-numeric: tabular-nums`).
- Hero 48 px desktop, 32 px mobile. Never above 56 px in the product. Body 16 px. Small uppercase labels 600, 12 px, +0.06em.

No other typefaces. Bricolage Grotesque, IBM Plex Sans and IBM Plex Mono are retired.

## Layout

- Max content width 1200 px, side gutter at least 16 px.
- Spacing from the `space-*` scale only (multiples of 4). 24 px card padding on desktop, 16 px on phones.
- Radius: `radius-md` for almost everything, `radius-pill` for chips. `radius-lg` only for the app icon and promo plates.
- Mobile navigation is a bottom tab bar: Home, Search, Orders, Wallet, Account. Touch targets at least 44 px.
- Every list collapses to one column under 520 px. Nothing scrolls sideways unless it shows a cue that there's more.

## Launch scope the UI must reflect

- **Games:** Aion & Aion 2, Albion Online, Path of Exile 1 & 2. Valorant and League of Legends come later, with accounts and boosting.
- **Listing structure:** Game → Server or League (+ Softcore/Hardcore for PoE) → Category → Listing.
- **Categories at launch:** in-game currency, items, top-ups. Hide keys and gift cards from navigation for now.
- **Payment:** crypto only via NOWPayments. Checkout lists only coins whose minimum covers the order, locks the rate once checkout starts, and asks for a top-up on underpayment.
- **Release:** the buyer confirms. If not, staff review after 24 hours at the earliest. There is no automatic release.
- **The 14-day hold** applies to accounts only.
- **Chat:** every order chat shows the off-platform warning. Blocked messages and strikes (1 and 2 warn, 3 bans) appear inline.

## Not synced yet

- Component previews are static renditions styled by `components/bundle.css`. The React components in `apps/web/src/components` are not bundled.
- Rank fees, rank requirements and perks text are placeholders.
