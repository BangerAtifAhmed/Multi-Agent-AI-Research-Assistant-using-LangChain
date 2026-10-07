import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import authApi from '../services/authApi.js';
import { onUnauthorized } from '../services/apiClient.js';

const AuthContext = createContext(null);

/** Reads the ticket the Google callback left in the URL fragment, and removes it. */
function takeOAuthTicket() {
  if (typeof window === 'undefined') return null;
  const ticket = new URLSearchParams(window.location.hash.slice(1)).get('oauth_ticket');
  if (ticket) {
    window.history.replaceState({}, '', window.location.pathname + window.location.search);
  }
  return ticket;
}

// Shared so a double-invoked effect (StrictMode) cannot spend the ticket twice.
let initialSession = null;

function loadInitialSession() {
  initialSession ??= (async () => {
    const ticket = takeOAuthTicket();
    if (ticket) {
      try {
        return await authApi.googleExchange(ticket);
      } catch (error) {
        // LoginPage reads ?error= when it mounts.
        const code = encodeURIComponent(error?.code || 'google_failed');
        window.history.replaceState({}, '', `${window.location.pathname}?error=${code}`);
      }
    }
    return authApi.me();
  })();
  return initialSession;
}

/**
 * Session state for the whole app.
 *
 * The session itself lives in an HttpOnly cookie the browser cannot read, so
 * "am I signed in?" is answered by asking the server (`GET /api/auth/me`)
 * rather than by inspecting a token in localStorage.
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  // Optimistic on purpose: the button is only hidden when the server explicitly
  // reports Google is unconfigured. A failed/slow config request must not make
  // the sign-in option disappear.
  const [googleEnabled, setGoogleEnabled] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setUser(await authApi.me());
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadInitialSession()
      .then(setUser, () => setUser(null))
      .finally(() => setLoading(false));
    authApi
      .authConfig()
      .then((data) => setGoogleEnabled(data.google !== false))
      .catch(() => {
        /* keep the button: the backend may just be starting up */
      });
  }, []);

  // An expired or revoked session anywhere in the app drops us back to login.
  useEffect(() => onUnauthorized(() => setUser(null)), []);

  const login = useCallback(async (credentials) => {
    const signedIn = await authApi.login(credentials);
    setUser(signedIn);
    return signedIn;
  }, []);

  const signup = useCallback(async (details) => {
    const created = await authApi.signup(details);
    setUser(created);
    return created;
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      setUser(null);
    }
  }, []);

  const value = useMemo(
    () => ({ user, setUser, loading, googleEnabled, login, signup, logout, refresh }),
    [user, loading, googleEnabled, login, signup, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an AuthProvider');
  return context;
}

export default AuthContext;
