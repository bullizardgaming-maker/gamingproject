# Designer handoff — everything the next agent needs
Written 2026-10-22 by the outgoing Designer agent. Read this first, then `design/README.md`.

## 1. Where to work
- **Only repo:** https://github.com/bullizardgaming-maker/gamingproject — branch **`main`**. Everything is on `main`.
- Do NOT use `eslamjetli/Gaming-Marketplace` (old, abandoned). Do not create side repos or branches without asking.
- A leftover branch `design/bullizard-frontend` exists on the team repo; it is identical to older `main` history (already merged). Ask the owner before deleting it.
- Commit trailers in this project: none required by the owner; previous commits used "Co-Authored-By: Claude".

## 2. How the owner wants to work (important)
- Keep explanations brief and to the point.
- Ask before choosing a repo, branch or folder; never pick your own location.
- Don't waste usage: no duplicate docs, no work the owner didn't ask for.
- Never delete assets/files unless asked. Ask before anything irreversible.
- "Say it once": details go to the help center; screens stay simple and beginner friendly.

## 3. The product (Bullizard)
- Gamer marketplace for in-game currency, items, top-ups. Launch games: Aion, Aion 2, Albion Online, Path of Exile 1 & 2. MENA first, Arabic (RTL) + English (+ ES/FR/DE/PT in code).
- Payments: crypto only via NOWPayments. Prices USD / EUR / EGP.
- Fees: 13.99% commission added on top (buyer price = seller price ÷ (1 − rate)); 5% for a seller's first 60 days. Withdrawal 6% (min $1.50).
- Escrow: seller delivers + uploads proof, buyer confirms, funds released; staff can release 24h+ after delivery.
- Ranks: Hatchling → Scale → Fang → Basilisk → Dragon. Founding Seller badge.
- Full business rules: Claude Project docs `claude/bullizard-master-plan.md` and `claude/backend-change-brief.md`.

## 4. Owner's design decisions (do not undo)
- **Logo:** the coin-eye mark (horns crescent + coin ring + slit pupil) is THE main mark and app icon — never change it. The name "Bullizard" is an outlined wordmark whose **B has horns and a fang (ناب)**. Files: `design/design-system/assets/Logos/`, `apps/web/public/brand/`.
- **Fonts:** Alexandria (headings, logo, Arabic) + Inter (body, numbers, tabular-nums). Bricolage Grotesque, IBM Plex Sans/Arabic/Mono must never come back.
- **Colour:** Night Frost dark is default. One green (rune `#77bd77` dark / `#4bae24` light) per view, only for the main action; text on green is dark `#0d131c`; never green text on light. No hover shadows (hover = border rule → steel). Money states: held amber, released teal, disputed rose.
- **Layout:** desktop looks like G2G but in Bullizard style. Header + Home hero + trust strip are wide (1600px); everything else 1240px centred.
- **Header (built):** logo · search · ONE settings button (language, currency, light/dark) · messages · notifications split Purchases / Sales / Updates · account menu (orders, shop, cart, watchlist, browse, settings, sign out). Category bar deleted. No Market / Requests / Sell links.
- **Copy rules:** "You earn" = seller's own price (never after-withdrawal). Outside-contact warning: "Sharing outside contacts can get your account banned right away." — may repeat, no strike counts, can be instant ban. Underpayment: no cancel/refund button; partial amount goes to buyer balance (withdrawable). Official chat messages never show money amounts or fees. Order IDs: `order#` + 7 chars (e.g. `order#7F3AK2Q`).
- **Chat:** every order chat shows the official Bullizard order card (server-only `system_order`, can't be faked) and a "Stay safe" panel. Outside contact is never delivered; sender sees "Not sent." in place.
- **Home:** "How a trade works" was replaced by "Grow with Bullizard" (two photo cards: invite friends [X%], Founding Seller 5%). People photos must show full face and hair (images anchored top).

## 5. What is built in the app (`apps/web`, on main)
1. Brand foundations: fonts, tokens, dark default, logo, favicon/app icons, manifest.
2. Home: wide hero + big search, trust strip, games grid, Grow with Bullizard.
3. Chat: `/messages` inbox (list, thread, side panel; search by name/listing/order#; tabs All/Orders/Questions; phone = one column), restyled order chat, official card, Stay safe panel, "Not sent." in place. Files: `src/pages/Messages.tsx`, `src/components/Chat.tsx`, `src/lib/orderUi.ts`.
4. Header + menus: `src/components/SiteHeader.tsx`, `src/components/HeaderMenus.tsx` (PrefsMenu, AccountMenu, usePopover), `src/components/NotificationBell.tsx`.
5. Brand CSS layers appended at the end of `src/styles.css` (brand layer, Home, chat/inbox, header menus).
6. All new strings exist in en/ar/es/fr/de/pt (`src/i18n/*.ts`; every locale must contain every key or TypeScript fails).

## 6. NOT yet done
- Reskin these app pages to match the desktop canvas: Game, Offer (buy box), Checkout (crypto), Order, Sell (preview), Wallet. Back-End's working versions exist; restyle without breaking logic or tests.
- Help center design; logo motion sting.
- Open questions for the owner: phone app dark or light; referral % for the invite card; Copywriter's final Arabic (rank names too).

## 7. Design files
- In repo: `design/` — `design-system/`, `brand-canvas/`, `mobile-flows-canvas/`, `desktop-canvas/` (+ `images/` hero and grow photos), `docs/frontend-build-brief.md`, `docs/design-status.md`.
- Live canvases (claude.ai artifacts, newest version wins):
  - Design system: https://claude.ai/artifact/GQejm8ycsJsrk2JLZ2zmU2 (also https://claude.ai/code/artifact/7cc67169-de88-492b-9c55-1c3ddfd1e887)
  - Brand: https://claude.ai/artifact/9FXfWA8ZQ9rT3eioywqhhs
  - Mobile flows: https://claude.ai/artifact/FBn455dsAKNwwTySuNtTQf
  - Desktop: https://claude.ai/artifact/LQ2gpMX1JSKnchdwujBX65
- Canvas boards reference images as `/_blob/<id>` (artifact asset store). Copies are in `design/desktop-canvas/images/`.

## 8. How to run and check the web app
- Demo mode (no backend): `cd apps/web && VITE_DEMO=true npx vite --port 4173`. Demo sign-in on `/login` (Buyer / Seller / Admin buttons, code 123456).
- Typecheck: `cd apps/web && npx tsc -b`.
- Browser tests: `VITE_DEMO=true npm run build -w apps/web` then `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npx playwright test` in `apps/web` (PWA test needs the build, not the dev server). Last full run: all green after fixes (one flaky bundles test passes on rerun).
- Test helpers: `e2e/helpers.ts` has `signIn`, `signOut` (via account menu), `buy`.
- API typecheck has one pre-existing error in `apps/api/src/context.ts` (not from design work). API tests need Postgres.

## 9. Gotchas
- Screenshots: Playwright must run from inside `apps/web` and use `executablePath: '/opt/pw-browsers/chromium'`.
- `getByLabel('Language')` also matches the settings button ("Language, currency and theme") — use `{ exact: true }`.
- Order refs come from the API (`orders.ref`, `order_ref` in chat rooms); `lib/orderUi.ts` falls back to a code derived from the id.
- Demo data lives in `src/demo/mock.ts` and `src/demo/seed.ts` (seed games are not the launch games).
