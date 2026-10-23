/**
 * The games Bullizard opens with (master plan, phase 1). Buyers browse and sellers list only
 * these; more games come in through the game vote.
 */
export const LAUNCH_GAMES = ['Aion', 'Aion 2', 'Albion Online', 'Path of Exile', 'Path of Exile 2'] as const;
export type LaunchGame = (typeof LAUNCH_GAMES)[number];

export const isLaunchGame = (game: string) => LAUNCH_GAMES.some((g) => g.toLowerCase() === game.trim().toLowerCase());
/** The launch game's canonical spelling for something a user typed, or null. */
export const launchGameFor = (game: string) => LAUNCH_GAMES.find((g) => g.toLowerCase() === game.trim().toLowerCase()) ?? null;

/**
 * The games a seller can list. Production: the launch games. The demo's full test catalogue
 * (localStorage 'bz-demo-full') opens every known game so older flows can still be exercised.
 */
export function sellableGames(known: readonly string[]): readonly string[] {
  return PHASE2_UI ? known : LAUNCH_GAMES;
}

/**
 * Phase-2 UI (card payments, 72h window, 14-day account insurance, keys/boosting, bundles, tax):
 * hidden at launch. The demo's full test catalogue (VITE_DEMO + localStorage 'bz-demo-full' = '1')
 * still shows it so the older browser tests keep working.
 */
export const PHASE2_UI: boolean = (() => {
  try {
    return import.meta.env.VITE_DEMO === 'true' && localStorage.getItem('bz-demo-full') === '1';
  } catch {
    return false;
  }
})();
