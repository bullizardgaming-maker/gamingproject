import { t } from '../i18n';

/** Round 29 (CEO, 5 Nov): places are regions, never countries. */
export const REGIONS = ['asia', 'middle_east', 'america', 'europe', 'global'] as const;
export type Region = (typeof REGIONS)[number];
export const isRegion = (v: unknown): v is Region => typeof v === 'string' && (REGIONS as readonly string[]).includes(v);
export const regionLabel = (r: Region) => t(`region.${r}`);
