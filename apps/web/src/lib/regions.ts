import { useSyncExternalStore } from 'react';
import { t } from '../i18n';

/** Round 29 (CEO, 5 Nov): places are regions, never countries. */
export const REGIONS = ['asia', 'middle_east', 'america', 'europe', 'global'] as const;
export type Region = (typeof REGIONS)[number];
export const isRegion = (v: unknown): v is Region => typeof v === 'string' && (REGIONS as readonly string[]).includes(v);
export const regionLabel = (r: Region) => t(`region.${r}`);

const KEY = 'bz.region';
const MIDDLE_EAST = /^(Africa\/(Cairo|Tripoli)|Asia\/(Riyadh|Dubai|Qatar|Kuwait|Bahrain|Muscat|Amman|Beirut|Damascus|Baghdad|Aden|Jerusalem|Gaza|Hebron|Tehran))$/;

/** First visit: a guess from the device's time zone (never a country, never asked); Global when unsure. */
export function guessRegion(): Region {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
    if (MIDDLE_EAST.test(zone)) return 'middle_east';
    if (zone.startsWith('Europe/') || /^Atlantic\/(Azores|Canary|Madeira|Faroe|Reykjavik)$/.test(zone)) return 'europe';
    if (zone.startsWith('America/')) return 'america';
    if (zone.startsWith('Asia/')) return 'asia';
  } catch {
    /* no Intl: Global */
  }
  return 'global';
}

const read = () => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};
let region: Region = isRegion(read()) ? (read() as Region) : guessRegion();
const listeners = new Set<() => void>();

/** The region this browser shows (the header pill); a signed-in account's saved region wins (session sync). */
export function setRegion(r: Region) {
  region = r;
  try {
    localStorage.setItem(KEY, r);
  } catch {
    /* storage blocked: the choice lasts for this page view */
  }
  listeners.forEach((l) => l());
}
export const getRegion = () => region;
export const useRegion = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => region,
    () => region,
  );
