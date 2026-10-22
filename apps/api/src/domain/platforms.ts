// No imports: the web app bundles this to offer the right "Link Steam / Riot" choice per game.

export type Platform = 'steam' | 'riot';

/** Games whose accounts live on a platform we can verify by sign-in (names as listed, any case). */
export const PLATFORM_GAMES: Record<Platform, string[]> = {
  steam: ['Counter-Strike 2', 'Dota 2', 'Team Fortress 2', 'Rust', 'PUBG: Battlegrounds', 'Apex Legends', 'Baldur’s Gate 3', 'Elden Ring', 'Cyberpunk 2077', 'Hogwarts Legacy', 'Path of Exile 2', 'Steam'],
  riot: ['Valorant', 'League of Legends', 'Teamfight Tactics', 'Legends of Runeterra'],
};

export function platformForGame(game: string): Platform | null {
  const g = game.trim().toLowerCase();
  for (const [p, games] of Object.entries(PLATFORM_GAMES) as Array<[Platform, string[]]>) if (games.some((x) => x.toLowerCase() === g)) return p;
  return null;
}
