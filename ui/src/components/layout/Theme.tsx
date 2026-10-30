import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { DARK_QUERY, THEME_STORAGE_KEY, applyTheme, readStoredMode, resolveTheme, storeMode, systemPrefersDark } from "@/lib/theme";
import type { ResolvedTheme, ThemeMode } from "@/lib/theme";

interface ThemeValue {
  /** What the user chose. */
  mode: ThemeMode;
  /** What is actually showing. */
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

/**
 * Light / Dark / System. The choice persists in localStorage; "system" follows the
 * OS appearance live. public/theme-init.js has already set data-theme before React
 * mounts, so the first render matches and nothing flashes.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => readStoredMode());
  const [dark, setDark] = useState<boolean>(() => systemPrefersDark());
  const resolved = resolveTheme(mode, dark);

  // Follow OS appearance changes (only matters while mode is "system", but cheap to keep current).
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;

    const query = window.matchMedia(DARK_QUERY);
    const onChange = (event: MediaQueryListEvent) => setDark(event.matches);

    query.addEventListener("change", onChange);

    return () => query.removeEventListener("change", onChange);
  }, []);

  // Another tab changed the choice.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY) setModeState(readStoredMode());
    };

    window.addEventListener("storage", onStorage);

    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    applyTheme(document.documentElement, mode, resolved);
  }, [mode, resolved]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    storeMode(next);
  }, []);

  const value = useMemo(() => ({ mode, resolved, setMode }), [mode, resolved, setMode]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);

  if (!value) throw new Error("useTheme must be used inside <ThemeProvider>");

  return value;
}
