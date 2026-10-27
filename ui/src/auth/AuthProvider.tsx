import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { createHttpClient } from "@/api/client";
import type { ApiClient } from "@/api/client";
import { createDemoClient } from "@/api/demo";
import { tokenStorage } from "./storage";

interface AuthState {
  client: ApiClient | null;
  /** The API token (live mode only), shown masked in the account page. */
  token: string | null;
  remembered: boolean;
  demo: boolean;
  /** Why the user was signed out (expired / rejected token). */
  notice: string | null;
  signIn: (token: string, remember: boolean) => Promise<void>;
  enterDemo: () => void;
  signOut: (notice?: string) => void;
}

const AuthContext = createContext<AuthState | null>(null);

const wantsDemo = (): boolean => new URLSearchParams(window.location.search).get("demo") === "1";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [stored] = useState(() => tokenStorage.read());
  const [token, setToken] = useState<string | null>(stored?.token ?? null);
  const [remembered, setRemembered] = useState(stored?.remembered ?? false);
  const [demoClient, setDemoClient] = useState<ApiClient | null>(() => (wantsDemo() || tokenStorage.readDemo() ? createDemoClient() : null));
  const [notice, setNotice] = useState<string | null>(null);

  const signOut = useCallback((message?: string) => {
    tokenStorage.clear();
    tokenStorage.writeDemo(false);
    setToken(null);
    setRemembered(false);
    setDemoClient(null);
    setNotice(message ?? null);
  }, []);

  const liveClient = useMemo(
    () =>
      token
        ? createHttpClient({ token, onUnauthorized: () => signOut("Your API token was rejected or has changed. Sign in again.") })
        : null,
    [token, signOut]
  );

  const signIn = useCallback(async (candidate: string, remember: boolean) => {
    const trimmed = candidate.trim();
    // Verify against the server before storing anything.
    await createHttpClient({ token: trimmed }).whoami();

    tokenStorage.write(trimmed, remember);
    tokenStorage.writeDemo(false);
    setDemoClient(null);
    setToken(trimmed);
    setRemembered(remember);
    setNotice(null);
  }, []);

  const enterDemo = useCallback(() => {
    tokenStorage.clear();
    tokenStorage.writeDemo(true);
    setToken(null);
    setDemoClient(createDemoClient());
    setNotice(null);
  }, []);

  const value = useMemo<AuthState>(
    () => ({ client: demoClient ?? liveClient, token: demoClient ? null : token, remembered, demo: demoClient !== null, notice, signIn, enterDemo, signOut }),
    [demoClient, liveClient, token, remembered, notice, signIn, enterDemo, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);

  if (!value) throw new Error("useAuth must be used inside AuthProvider");

  return value;
}

/** The API client of the signed-in session (live or demo). */
export function useApi(): ApiClient {
  const { client } = useAuth();

  if (!client) throw new Error("useApi requires a signed-in session");

  return client;
}
