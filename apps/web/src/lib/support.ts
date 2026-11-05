/**
 * Round 29: support (help centre, "Contact support", my tickets) lives on its own subdomain. The same web build is
 * served on both hosts (Vercel domain); the API allows both origins and the refresh cookie covers the subdomain.
 * Only the live main site links across: localhost, previews and the demo keep every link on one origin.
 */
const env = import.meta.env as Record<string, string | undefined>;
export const SUPPORT_ORIGIN = env.VITE_SUPPORT_ORIGIN || 'https://support.bullizard.com';
export const MAIN_ORIGIN = env.VITE_MAIN_ORIGIN || 'https://bullizard.com';

const hostOf = (origin: string) => {
  try {
    return new URL(origin).hostname;
  } catch {
    return '';
  }
};
const here = () => (typeof location === 'undefined' ? '' : location.hostname);

export const onSupportHost = () => here() === hostOf(SUPPORT_ORIGIN);
export const onMainHost = () => {
  const h = here();
  const main = hostOf(MAIN_ORIGIN);
  return !!main && (h === main || h === `www.${main}`);
};

/** Where a support path opens: on the subdomain from the live site, in place everywhere else. */
export const supportHref = (path: string) => (onMainHost() ? SUPPORT_ORIGIN + path : path);

/** Paths the support host serves itself; anything else goes back to the main site. */
const SUPPORT_PATHS = /^\/(support|help|login|signup|forgot-password|reset-password|account|terms|privacy|refunds|seller-agreement|restricted-countries|status)(\/|$)/;
export const supportHostServes = (path: string) => SUPPORT_PATHS.test(path);
