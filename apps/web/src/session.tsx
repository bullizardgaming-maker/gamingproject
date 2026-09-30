import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, session, type User } from './api';

interface SessionState {
  user: User | null;
  loading: boolean;
  refresh: () => Promise<void>;
  signOut: () => void;
}

const Ctx = createContext<SessionState>({ user: null, loading: true, refresh: async () => {}, signOut: () => {} });

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!session.token) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      setUser((await api<{ user: User }>('/me')).user);
    } catch {
      setUser(null);
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

  return <Ctx.Provider value={{ user, loading, refresh, signOut: () => session.set(null) }}>{children}</Ctx.Provider>;
}

export const useSession = () => useContext(Ctx);
