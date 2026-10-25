import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { DEMO } from '../api';
import { t } from '../i18n';

/**
 * Cloudflare Turnstile (Round 23a) on sign-up, sign-in and password reset only. The script is loaded when one of
 * those forms mounts, never in index.html, so pages that start a payment keep a first-party-only script inventory
 * (payment-scripts.json). Leaving an auth page after the script loaded reloads the next page, so its code is gone
 * before any checkout. No site key (development, the demo): nothing is rendered and the API has the check off.
 */
const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

declare global {
  interface Window {
    turnstile?: {
      render(el: HTMLElement, opts: Record<string, unknown>): string;
      reset(id?: string): void;
      remove(id: string): void;
    };
  }
}

export function turnstileSiteKey(): string {
  const key = (import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined) ?? '';
  if (key) return key;
  // Browser tests of the demo build switch the widget on with Cloudflare's test site key.
  if (DEMO) {
    try {
      return localStorage.getItem('bz.demo.turnstile') ?? '';
    } catch {
      return '';
    }
  }
  return '';
}

/** The only pages that load the widget. */
export const AUTH_PATHS = new Set(['/login', '/forgot-password', '/reset-password']);

let loading: Promise<void> | null = null;
let loaded = false;

/**
 * Mounted once in the app: when the visitor leaves the auth pages after the widget script loaded, the next page is
 * loaded in full, so the third-party script is gone before any page that starts a payment.
 */
export function TurnstileUnloader() {
  const { pathname } = useLocation();
  useEffect(() => {
    if (loaded && !AUTH_PATHS.has(pathname)) window.location.reload();
  }, [pathname]);
  return null;
}
function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SCRIPT;
    s.async = true;
    s.dataset.turnstile = 'true';
    s.onload = () => resolve();
    s.onerror = () => {
      loading = null;
      reject(new Error('turnstile'));
    };
    document.head.appendChild(s);
    loaded = true;
  });
  return loading;
}

/** Renders the widget and reports each token (null when it expires or fails). `resetKey` changes ask for a new one. */
export function Turnstile({ onToken, resetKey = 0, action }: { onToken: (token: string | null) => void; resetKey?: number; action: 'signup' | 'signin' | 'reset' }) {
  const box = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const cb = useRef(onToken);
  cb.current = onToken;
  const siteKey = turnstileSiteKey();

  useEffect(() => {
    if (!siteKey) return;
    let cancelled = false;
    loadScript()
      .then(() => {
        if (cancelled || !box.current || !window.turnstile) return;
        widget.current = window.turnstile.render(box.current, {
          sitekey: siteKey,
          action,
          appearance: 'interaction-only',
          callback: (token: string) => cb.current(token),
          'expired-callback': () => cb.current(null),
          'error-callback': () => cb.current(null),
        });
      })
      .catch(() => cb.current(null));
    return () => {
      cancelled = true;
      if (widget.current && window.turnstile) window.turnstile.remove(widget.current);
      widget.current = null;
    };
  }, [siteKey, action]);

  useEffect(() => {
    if (resetKey && widget.current && window.turnstile) {
      cb.current(null);
      window.turnstile.reset(widget.current);
    }
  }, [resetKey]);

  if (!siteKey) return null;
  return <div ref={box} className="turnstile" aria-label={t('auth.botCheck')} />;
}
