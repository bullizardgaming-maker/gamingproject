# Bullizard social and game art

Our own art only: no official game logos or game artwork. Game names are set in text (Alexandria 800).

## Game banners
| File | Size | Use |
|---|---|---|
| `apps/web/public/games/<slug>.webp` | 1200×400, art only (10-21 KB) | The app: home tile band and game page header; the app writes the name over it |
| `game-banners/<slug>-banner.webp/.png` | 1200×400 (2x export) | With the name: social posts, store pages |
| `game-banners/<slug>-tile.webp/.png` | 512×512 | With the name: square posts, Discord channel images |

Slugs: `aion`, `aion-2`, `albion-online`, `path-of-exile`, `path-of-exile-2`.
Each game has its own pattern and tint: Aion arcs (blue), Aion 2 double arcs (violet), Albion contours (amber), PoE orbs (ember), PoE 2 hex lattice (teal). The coin-eye mark sits small in the corner.

## Community → `community/`
| File | Size | Where |
|---|---|---|
| `discord-icon.png` | 512×512 | Discord server icon (same as the app icon) |
| `telegram-avatar.png` | 640×640 | Telegram channel photo (mark kept inside the circle crop) |
| `discord-banner.png` | 960×540 | Discord server banner |
| `discord-invite-splash.png` | 1920×1080 | Discord invite background |
| `telegram-header.png` | 1280×720 | Pinned/first post image in Telegram |

## Launch posts → `launch/` (EN + AR)
square 1080×1080 · portrait 1080×1350 · story 1080×1920 · landscape 1200×675.
Copy is the Copywriter's final lines (copy deck §1 tagline, §7.1 launch). Domain left off until it's confirmed. Edit `TXT` in `src/gen.py` and rebuild to change them.

## Rebuild
```
cd design/social/src
python3 gen.py            # writes html/ + manifest.json
node render.mjs           # renders out/ with Playwright Chromium (needs Google Fonts reachable)
```
