import { useEffect } from 'react';

const SITE = 'Bullizard';
const DEFAULT_DESCRIPTION =
  'Buy and sell game accounts, keys, currency and boosting with escrow: 72-hour inspection for items, 14-day insurance for accounts.';

function setMeta(attr: 'name' | 'property', key: string, value: string) {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.content = value;
}

function setCanonical(path: string) {
  let el = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!el) {
    el = document.createElement('link');
    el.rel = 'canonical';
    document.head.appendChild(el);
  }
  el.href = `${window.location.origin}${path}`;
}

/**
 * Per-page title, description and canonical URL (also as Open Graph tags for link previews).
 * `noindex` keeps private pages (orders, account, operations) out of search results.
 */
export function usePageMeta(meta: { title?: string; description?: string; noindex?: boolean }) {
  const { title, description, noindex } = meta;
  useEffect(() => {
    const full = title ? `${title} · ${SITE}` : `${SITE} — escrow-protected game marketplace`;
    document.title = full;
    setMeta('name', 'description', description ?? DEFAULT_DESCRIPTION);
    setMeta('property', 'og:title', full);
    setMeta('property', 'og:description', description ?? DEFAULT_DESCRIPTION);
    setMeta('property', 'og:type', 'website');
    setMeta('name', 'robots', noindex ? 'noindex, nofollow' : 'index, follow');
    setCanonical(window.location.pathname);
  }, [title, description, noindex]);
}
