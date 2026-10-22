# Bullizard design

Everything the Designer built, kept next to the code.

| Folder | What it is | Live version |
|---|---|---|
| `design-system/` | Tokens (`tokens.json`), rules (`README.md`), components, logo SVGs (`assets/Logos/`) | https://claude.ai/artifact/GQejm8ycsJsrk2JLZ2zmU2 |
| `brand-canvas/` | Mark, lockups (EN/AR), ranks, motion, palette | https://claude.ai/artifact/9FXfWA8ZQ9rT3eioywqhhs |
| `mobile-flows-canvas/` | The 8 priority screens on phone, Arabic home, promo visuals | https://claude.ai/artifact/FBn455dsAKNwwTySuNtTQf |
| `desktop-canvas/` | G2G-style desktop pages (Home, Game, Offer, Checkout, Order, Sell, Wallet, Messages) and phone chat screens; `images/` has the hero and "Grow with Bullizard" photos | https://claude.ai/artifact/LQ2gpMX1JSKnchdwujBX65 |
| `docs/frontend-build-brief.md` | Screen-by-screen build spec for the web app | |
| `docs/design-status.md` | What's done and what's open | |

The canvas files (`*.dc.html`, `canvas.json`) are design boards, not app code. Images inside them point at the canvas asset store (`/_blob/…`); the same images are in `desktop-canvas/images/` and the logos in `design-system/assets/Logos/`. The live links above are the newest version if they ever differ.

The app itself is in `apps/web` (brand fonts, tokens, logo, Home, Messages inbox and chat, header are already built there).
