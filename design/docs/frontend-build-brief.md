# Bullizard frontend build brief
Last updated: 2026-10-22 · from Designer

Build from these. If a screen and this brief disagree, this brief wins; ask Designer.

## Sources
- Design files in this repo: `design/` (design system, brand, mobile flows, desktop canvases).
- Design system (tokens, components, logo files, README rules): https://claude.ai/artifact/GQejm8ycsJsrk2JLZ2zmU2
- Desktop screens (G2G-style layout, shown at 1920 wide, interactive): https://claude.ai/artifact/LQ2gpMX1JSKnchdwujBX65 (Home, Game, Offer, Checkout, Order, Sell, Wallet, Messages, plus mobile chat list / thread / Arabic thread)
- Mobile + flows canvas (all 8 priority screens, Arabic RTL home, promos): https://claude.ai/artifact/FBn455dsAKNwwTySuNtTQf
- Brand canvas (mark, lockups, ranks, motion): https://claude.ai/artifact/9FXfWA8ZQ9rT3eioywqhhs

## 0. Layout widths
- Wide (max-width 1600px): the header on every page, plus the Home hero and trust strip only.
- Everything else (Home below the trust strip, footer, and all other pages): max-width 1240px, centred.
- Side padding: max(16px, 3vw).

## 1. Fonts
- No Bricolage Grotesque, IBM Plex Sans, IBM Plex Sans Arabic or IBM Plex Mono anywhere.
- Alexandria 400–800: headings, logo text, all Arabic.
- Inter 400–700: body, buttons, numbers. Money, IDs and timers use `font-variant-numeric: tabular-nums` (no mono font).

## 2. Colour tokens
Dark (default):
`frost #0d131c · paper #16202e · raised #1f2b3c · field #111925 · ink #eef1f5 · steel #9aa8bb · rule #2a3749 · rune #77bd77 · rune-soft #2c4620 · on-rune #0d131c`
Light:
`frost #eef1f5 · paper #f8fafc · ink #16202e · steel #4f5e75 · rule #cfd6e0 · rune #4bae24 · rune-soft #e4f3dd · on-rune #0d131c`
Money states (each has -soft background and -ink text): held (amber), released (teal), disputed (rose `#e0608f`, soft `#3d1a2a`, ink `#f39bbb`). Full values in `design/design-system/tokens.json`.

Rules:
- One green (rune) element per view: the main action (Buy now / Release funds). Everything else is ink or ghost.
- Text on green is always dark (`on-rune`), never white.
- Never green text on light backgrounds.
- No shadows on hover; hover = border goes from `rule` to `steel`.

## 3. Logo
- Main mark and app icon: the coin-eye (horns crescent + coin ring + slit pupil). Never altered.
- Name: outlined "Bullizard" wordmark whose B has horns and a fang. Use the SVG files; never type the name in a font.
- Files: `design/design-system/assets/Logos/` and `apps/web/public/brand/`.

## 4. Copy rules
- Say it once. Fee details, promo end dates and policy text live in the help center, not on screens.
- Seller "You earn" = the seller's own price. Never show an after-withdrawal amount on the sell form.
- Outside-contact warning: "Sharing outside contacts can get your account banned right away." May repeat. No strike counts anywhere.
- Order IDs: `order#` + 7 uppercase letters/digits, e.g. `order#7F3AK2Q`.
- Official chat messages never show money amounts or fees.

## 5. Screens
**Header (all pages, built):** logo · search · one settings button (language, currency, light/dark) · messages · notifications (tabs Purchases / Sales / Updates, "All purchases" / "All sales" links) · account menu (orders, your shop, cart with count, watchlist, browse the market, staff tools, settings, sign out). No category bar, no Market / Requests / Sell links.

**Home (built):** hero photo with dark gradient (photo anchored top-right so faces are never cropped), big game search, top searches, trust strip, games grid, "Grow with Bullizard" two photo cards (Invite friends: [X%] waiting on CEO; Founding Seller: 5% at launch → Start selling), footer.

**Game:** server switch, Silver/Gold/Items tabs, left filters (amount, delivery time, online, rank, founding), listing table: seller + rank + rating, delivery, stock, per 1M, total for entered amount, Buy. Totals recalc live.

**Offer:** seller card, offer details, reviews; sticky buy box: amount, saved character name (one tap, "Change"), per 1M, total, Buy now (green), "Held until you confirm delivery."

**Checkout:** steps Confirm → Pay → Order. Coin list (disable coins whose NOWPayments minimum is above the order, with reason). Rate lock timer chip. QR + exact amount + network + copy address. Summary: Price, From your balance, To pay.
- Underpayment: no cancel, no refund button. Partial amount goes to buyer balance; withdrawable under withdrawal rules.

**Order (buyer):** order#, item → character, price, status chip; seller's proof; tracker Paid·in escrow → Delivered → You confirm → Seller paid; green "Silver arrived · release funds"; "Something's wrong" (dispute). Right panel = the order's chat.

**Sell:** game picker, server, stock, your price per 1M, delivery time, method, note. Sticky preview with USD/EUR/EGP switch: You earn (= price) and Buyer pays (= price ÷ (1 − rate)). Publish offer.

**Wallet:** Available / In escrow / Withdrawn cards; history table (date, order# or withdrawal, Held/Released/Sent/Disputed chip, amount); withdraw box: coin, address for that network, amount, Fee (6%, min $1.50), You receive, address-confirm checkbox, Withdraw.

**Onboarding (mobile canvas):** rules test, then done screen with ID reminder.
**Ranks (mobile canvas):** Hatchling → Scale → Fang → Basilisk → Dragon; only Dragon uses the accent. Founding Seller badge.

## 6. Chat (built: /messages and the order chat)
- Inbox: chat list (search by name, listing or order#; All / Orders / Questions), thread, side panel (trader, this chat's order, "Report this chat"). Phone shows one column at a time.
- Order strip above the thread: order#, item, status chip, "Open order".
- `system_order` → official Bullizard card (inverted header with mark + check, order#, item, character, status chip). `system` text → same official frame. `delivery` / `warning` → one-line coloured notices.
- "Stay safe" panel: staff text from Ops → Texts (`chat_safety`).
- Outside contact: caught before sending and by the server (422 `offplatform_blocked`); the sender sees "Not sent. Sharing outside contacts can get your account banned right away." in place in the thread.

## 7. Arabic / RTL
- `dir="rtl"` on `<html>` for Arabic; logical CSS only. Mark sits on the right in RTL.
- Numbers and order IDs stay LTR (`dir="ltr"` on those spans); message text uses `dir="auto"`.

## 8. Accessibility
- Inputs have labels; icon buttons have aria-label; focus ring 2px ink.
- Official cards: role="article", aria-label "Message from Bullizard"; blocked notices role="status".
- Respect `prefers-reduced-motion`.
- Contrast AA minimum.
