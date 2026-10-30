/**
 * Theme selection logic (pure). The user's CHOICE is light | dark | system;
 * what the page renders is the RESOLVED theme, light | dark.
 *
 * public/theme-init.js repeats resolve/read in plain ES5 so the right theme is
 * set before first paint (the CSP forbids inline scripts, so it is a separate
 * file). theme.test.ts runs that file against this module to keep them in step.
 */

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_MODES: readonly ThemeMode[] = ["light", "dark", "system"];
export const THEME_STORAGE_KEY = "shipflow.theme";
export const DEFAULT_THEME_MODE: ThemeMode = "system";
export const DARK_QUERY = "(prefers-color-scheme: dark)";

export function parseThemeMode(value: unknown): ThemeMode | null {
  return typeof value === "string" && (THEME_MODES as readonly string[]).includes(value) ? (value as ThemeMode) : null;
}

/** The stored choice, or "system" for a first visit, an unknown value, or blocked storage. */
export function readStoredMode(storage: Pick<Storage, "getItem"> | null = safeStorage()): ThemeMode {
  try {
    return parseThemeMode(storage?.getItem(THEME_STORAGE_KEY)) ?? DEFAULT_THEME_MODE;
  } catch {
    return DEFAULT_THEME_MODE;
  }
}

export function storeMode(mode: ThemeMode, storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Private mode / storage disabled: the choice still applies for this page view.
  }
}

export function resolveTheme(mode: ThemeMode, systemPrefersDark: boolean): ResolvedTheme {
  return mode === "system" ? (systemPrefersDark ? "dark" : "light") : mode;
}

export function systemPrefersDark(win: Pick<Window, "matchMedia"> | null = typeof window === "undefined" ? null : window): boolean {
  try {
    return win?.matchMedia(DARK_QUERY).matches === true;
  } catch {
    return false;
  }
}

/** Reflect a choice on the document: data-theme is what the CSS keys on. */
export function applyTheme(root: HTMLElement, mode: ThemeMode, resolved: ResolvedTheme): void {
  root.dataset.theme = resolved;
  root.dataset.themeMode = mode;
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // Accessing localStorage can itself throw (blocked cookies).
    return null;
  }
}
