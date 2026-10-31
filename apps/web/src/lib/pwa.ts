import { useSyncExternalStore } from 'react';

/**
 * Installable app: registers the service worker (offline page, cached build assets, push) and
 * keeps the browser's install prompt so the UI can offer "Install app" at a good moment.
 */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: InstallPromptEvent | null = null;
let installed = typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone === true);
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l));

export function setUpPwa() {
  if (typeof window === 'undefined') return;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // we show our own button instead of the mini-infobar
    deferred = e as InstallPromptEvent;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    installed = true;
    emit();
  });
  // Dev servers serve modules the worker shouldn't cache; register in builds only.
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }
}

const isIos = () => typeof navigator !== 'undefined' && /iphone|ipad|ipod/i.test(navigator.userAgent) && !(window as any).MSStream;

/** What install option this browser has: a native prompt, iOS's Share → Add to Home Screen, or none. */
export function useInstall() {
  const state = useSyncExternalStore(subscribe, () => (installed ? 'installed' : deferred ? 'prompt' : isIos() ? 'ios' : 'none'));
  const install = async () => {
    if (!deferred) return false;
    const e = deferred;
    deferred = null;
    emit();
    await e.prompt();
    return (await e.userChoice).outcome === 'accepted';
  };
  return { state: state as 'installed' | 'prompt' | 'ios' | 'none', install };
}
