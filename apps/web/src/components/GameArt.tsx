import { useState } from 'react';
import { slugify } from '@/lib/catalog';

const EXT = ['webp', 'png', 'svg'];

/**
 * A game's official logo from /games/<slug>.(webp|png|svg) (the owner drops the files in
 * public/games/). Renders nothing while no file exists, so tiles never show a broken image.
 */
export function GameArt({ game, size = 40, className }: { game: string; size?: number; className?: string }) {
  const [i, setI] = useState(0);
  if (i >= EXT.length) return null;
  return (
    <img
      src={`/games/${slugify(game)}.${EXT[i]}`}
      alt=""
      width={size}
      height={size}
      className={className}
      style={{ width: size, height: size, objectFit: 'contain', borderRadius: 8, flex: 'none' }}
      onError={() => setI((n) => n + 1)}
    />
  );
}
