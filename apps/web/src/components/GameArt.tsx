import { useState } from 'react';
import { slugify } from '@/lib/catalog';

const EXT = ['webp', 'png', 'jpg'];

/**
 * Our own banner for a game from /games/<slug>.(webp|png|jpg) (the Designer's files go in
 * public/games/). No publisher logos or artwork: the game name is always text next to or over
 * it. While no file exists the band is a brand-coloured gradient, never a broken image.
 */
export function GameBanner({ game, height = 120, className, children }: { game: string; height?: number; className?: string; children?: React.ReactNode }) {
  const [i, setI] = useState(0);
  const src = i < EXT.length ? `/games/${slugify(game)}.${EXT[i]}` : null;
  return (
    <div className={`game-banner${className ? ` ${className}` : ''}`} style={{ height }} data-game={slugify(game)}>
      {src && <img src={src} alt="" loading="lazy" onError={() => setI((n) => n + 1)} />}
      {children}
    </div>
  );
}
