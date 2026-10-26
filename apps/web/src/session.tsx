import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, refreshAccessToken, session, signOut, type User } from './api';
import { chosenLocale, currentLocale, isLocale, setLocale } from './i18n';

interface SessionState {
  user: User | null;
  /** Staff permissions (e.g. 'aml.review'); empty for regular users. */
  permissions: Set<string>;
  can: (permission: string) => boolean;
  loading: boolean;
  refresh: () => Promise<void>;
  signOut: () => void;
}

const Ctx = createContext<SessionState>({ user: null, permissions: new Set(), can: () => false, loading: true, refresh: async () => {}, signOut: () => {} });

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [permissions, setPermissions] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    // Round 23d: the access token is not persisted; a reload exchanges the refresh cookie for a new one first.
    // Round 23e: also once per browser without the flag — a refresh cookie may exist that this browser forgot about.
    if (!session.token && (session.maybeSignedIn || session.takeProbe())) {
      const ok = await refreshAccessToken(); // on success session.set() fires 'session' and this runs again with a token
      if (!ok) {
        setUser(null);
        setLoading(false);
      }
      return;
    }
    if (!session.token) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      const u = (await api<{ user: User }>('/me')).user;
      // Keep the account's language (used for emails and notifications) and this browser's in step:
      // a language picked here wins; otherwise this browser adopts the account's.
      if (chosenLocale() && u.locale !== currentLocale()) api('/me/locale', { method: 'PUT', body: { locale: currentLocale() } }).catch(() => {});
      else if (!chosenLocale() && isLocale(u.locale) && u.locale !== currentLocale()) void setLocale(u.locale);
      setUser(u);
      setPermissions(
        u.role === 'user' ? new Set() : new Set((await api<{ permissions: string[] }>('/me/permissions').catch(() => ({ permissions: [] }))).permissions),
      );
    } catch {
      setUser(null);
      setPermissions(new Set());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const onChange = () => refresh();
    window.addEventListener('session', onChange);
    return () => window.removeEventListener('session', onChange);
  }, [refresh]);

  return (
    <Ctx.Provider value={{ user, permissions, can: (p) => permissions.has(p), loading, refresh, signOut: () => void signOut() }}>{children}</Ctx.Provider>
  );
}

export const useSession = () => useContext(Ctx);
