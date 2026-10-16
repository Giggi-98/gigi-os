import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, setCsrf, setMfaSetupHandler, setUnauthorizedHandler, type AuthState, type User } from './api';

type Ctx = {
  state: AuthState | null;
  user: User | null;
  isAdmin: boolean;
  /** Operatore o amministratore: riavvio container, download, revisione media (D-028). */
  isOperator: boolean;
  refresh: () => Promise<void>;
  setUser: (u: User | null) => void;
  logout: () => Promise<void>;
};

const AuthCtx = createContext<Ctx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState | null>(null);
  const qc = useQueryClient();

  const refresh = useCallback(async () => {
    try {
      const s = await api<AuthState>('/auth/state');
      setCsrf(s.user?.csrf ?? null);
      setState(s);
    } catch {
      setState((prev) => prev ?? { setupRequired: false, user: null });
    }
  }, []);

  useEffect(() => {
    void refresh();
    setUnauthorizedHandler(() => {
      setCsrf(null);
      qc.clear();
      setState((s) => (s ? { ...s, user: null } : s));
    });
    setMfaSetupHandler(() => void refresh());
  }, [refresh, qc]);

  const setUser = useCallback((u: User | null) => {
    setCsrf(u?.csrf ?? null);
    setState((s) => ({ setupRequired: false, ...(s ?? {}), user: u }));
  }, []);

  const logout = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } finally {
      setCsrf(null);
      qc.clear();
      setState((s) => (s ? { ...s, user: null } : s));
    }
  }, [qc]);

  const value = useMemo(
    () => ({
      state,
      user: state?.user ?? null,
      isAdmin: state?.user?.role === 'admin',
      isOperator: state?.user?.role === 'admin' || state?.user?.role === 'operator',
      refresh,
      setUser,
      logout,
    }),
    [state, refresh, setUser, logout],
  );
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth() {
  const c = useContext(AuthCtx);
  if (!c) throw new Error('AuthProvider mancante');
  return c;
}
