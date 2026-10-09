import ar from './ar.js';
import de from './de.js';
import es from './es.js';
import fr from './fr.js';
import pt from './pt.js';
import type { Locale, LocalePack } from './types.js';

export * from './types.js';
export const PACKS: Record<Exclude<Locale, 'en'>, LocalePack> = { ar, es, fr, de, pt };
