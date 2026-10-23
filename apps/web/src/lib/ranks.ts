import en from '../i18n/en';
import { t, type MessageKey } from '../i18n';

/**
 * Seller ranks are stored in English (Hatchling → Dragon). The interface shows them through
 * `rank.name.<English>` / `rank.perk.<English>` (copy deck §3); an unknown rank falls back to
 * the raw name so a rank staff add later still shows.
 */
const has = (k: string): k is MessageKey => k in en;
export const rankName = (name: string) => (has(`rank.name.${name}`) ? t(`rank.name.${name}` as MessageKey) : name);
export const rankPerk = (name: string) => (has(`rank.perk.${name}`) ? t(`rank.perk.${name}` as MessageKey) : '');
/** Only the top rank uses the accent colour. */
export const isTopRank = (name: string) => /^dragon$/i.test(name);
