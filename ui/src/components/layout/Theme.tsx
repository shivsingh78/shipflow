import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

export type ThemePreference = "system" | "light" | "dark";

interface ThemeState {
  preference: ThemePreference;
  setPreference: (value: ThemePreference) => void;
}

const KEY = "shipflow.theme";
const ThemeContext = createContext<ThemeState | null>(null);

function read(): ThemePreference {
  try {
    const value = localStorage.getItem(KEY);

    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function apply(preference: ThemePreference) {
  const dark = preference === "dark" || (preference === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);

  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(read);

  useEffect(() => {
    apply(preference);

    if (preference !== "system") return undefined;

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = () => apply("system");

    media.addEventListener("change", listener);

    return () => media.removeEventListener("change", listener);
  }, [preference]);

  const setPreference = useCallback((value: ThemePreference) => {
    try {
      if (value === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, value);
    } catch {
      // Preference just won't persist.
    }

    setPreferenceState(value);
  }, []);

  const value = useMemo(() => ({ preference, setPreference }), [preference, setPreference]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
  const value = useContext(ThemeContext);

  if (!value) throw new Error("useTheme must be used inside ThemeProvider");

  return value;
}
