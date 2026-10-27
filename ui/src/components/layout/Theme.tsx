import { useEffect } from "react";
import type { ReactNode } from "react";

/**
 * The dashboard is dark-only (the design defines no light theme). This marks the
 * document so CSS and the browser's built-in controls use the dark scheme.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    document.documentElement.dataset.theme = "dark";
  }, []);

  return <>{children}</>;
}
