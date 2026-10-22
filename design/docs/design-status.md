# Bullizard design status (Designer)
Last updated: 2026-10-22 (pages round)

## Where things live
- Design files in this repo: `design/` (see `design/README.md`).
- Design system: https://claude.ai/artifact/GQejm8ycsJsrk2JLZ2zmU2
- Brand identity canvas: https://claude.ai/artifact/9FXfWA8ZQ9rT3eioywqhhs
- Mobile + flows canvas: https://claude.ai/artifact/FBn455dsAKNwwTySuNtTQf
- Desktop canvas: https://claude.ai/artifact/LQ2gpMX1JSKnchdwujBX65
- Build spec: `design/docs/frontend-build-brief.md`

## Identity (final)
- Mark + app icon: coin-eye (horns crescent, coin ring, slit pupil).
- Name: outlined "Bullizard" wordmark; the B has horns and a fang.
- Type: Alexandria (headings, logo, Arabic) + Inter (body, numbers). Bricolage, IBM Plex Sans/Mono removed.
- Colour: Night Frost dark + light; one green accent per view (dark text on green); held/released/disputed for money.

## Built in the app (apps/web)
- Brand foundations: fonts, tokens, dark default, logo and icons.
- Home: wide hero with search, trust strip, games grid, "Grow with Bullizard".
- Header: logo, search, one settings button (language, currency, theme), messages, notifications split Purchases / Sales / Updates, account menu. Category bar removed.
- Messages inbox (/messages) and order chat: official order card, "Stay safe" panel, outside contact never sent ("Not sent." in place).
- Game: night band with server switch and tabs, left filters with "How many?", listing table with each + total + Buy.
- Offer: seller card, offer details, reviews, sticky buy box (saved character one tap, "Buy now", "Held until you confirm delivery.").
- Checkout: Confirm → Pay → Order steps, coin list, QR + exact amount + copy, order summary.
- Order: order#, item → character, tracker, green release button, "Something's wrong", chat on the right.
- Sell: launch-game picker, form, sticky preview (USD/EUR/EGP, You earn = price, Buyer pays), "Publish offer".
- Wallet (/sell/money): Available / In escrow / Withdrawn, history table, withdraw box with fee, You receive, address check.

## Next
- Help center, logo motion sting.

## Needs back-end
- Offers don't send the seller's rank name yet (`seller_rank`); the table shows it once they do.
- Coins too big for an order are left out by the API, so they can't be shown greyed with a reason.
- No "From your balance" amount on checkout yet (no buyer-credit data on the order).

## Open questions
- Mobile app dark or light (chat boards are dark).
- Referral % for "Grow with Bullizard".
- Copywriter's final Arabic (incl. rank names).
