import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_THEME_MODE, THEME_STORAGE_KEY, parseThemeMode, readStoredMode, resolveTheme, storeMode, systemPrefersDark } from "./theme";
import type { ThemeMode } from "./theme";

const memory = (initial?: string) => {
  const data = new Map<string, string>(initial === undefined ? [] : [[THEME_STORAGE_KEY, initial]]);

  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
};

describe("theme logic", () => {
  it("accepts only the three modes", () => {
    for (const mode of ["light", "dark", "system"]) expect(parseThemeMode(mode)).toBe(mode);
    for (const bad of ["Dark", "auto", "", null, undefined, 1, {}]) expect(parseThemeMode(bad)).toBeNull();
  });

  it("defaults a first-time visitor to System", () => {
    expect(DEFAULT_THEME_MODE).toBe("system");
    expect(readStoredMode(memory())).toBe("system");
  });

  it("restores a stored choice and ignores junk", () => {
    expect(readStoredMode(memory("dark"))).toBe("dark");
    expect(readStoredMode(memory("light"))).toBe("light");
    expect(readStoredMode(memory("purple"))).toBe("system");
  });

  it("survives blocked storage", () => {
    const blocked = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };

    expect(readStoredMode(blocked)).toBe("system");
    expect(() => storeMode("dark", blocked)).not.toThrow();
    expect(readStoredMode(null)).toBe("system");
  });

  it("persists the choice", () => {
    const storage = memory();

    storeMode("dark", storage);
    expect(storage.data.get(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("resolves System from the OS and passes explicit choices through", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("reads the OS preference defensively", () => {
    expect(systemPrefersDark({ matchMedia: () => ({ matches: true }) as MediaQueryList })).toBe(true);
    expect(systemPrefersDark({ matchMedia: () => { throw new Error("nope"); } })).toBe(false);
    expect(systemPrefersDark(null)).toBe(false);
  });
});

describe("public/theme-init.js (runs before first paint)", () => {
  const script = readFileSync(resolve(__dirname, "../../public/theme-init.js"), "utf-8");

  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-theme-mode");
  });

  const THROWS = Symbol("throws");
  const run = (stored: string | null | typeof THROWS, prefersDark: boolean | typeof THROWS) => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        if (stored === THROWS) throw new Error("blocked");

        return stored;
      },
    });
    vi.stubGlobal("matchMedia", () => {
      if (prefersDark === THROWS) throw new Error("unsupported");

      return { matches: prefersDark };
    });
    // The script reads window.localStorage / window.matchMedia.
    // Deliberately executing the shipped script: this test exists to prove it behaves like theme.ts.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    (new Function(script) as () => void)();

    return { theme: document.documentElement.getAttribute("data-theme"), mode: document.documentElement.getAttribute("data-theme-mode") };
  };

  it("matches src/lib/theme.ts for every stored value and OS preference", () => {
    const stored: Array<string | null> = ["light", "dark", "system", null, "junk", ""];

    for (const value of stored) {
      for (const dark of [true, false]) {
        const mode: ThemeMode = readStoredMode(memory(value ?? undefined));
        const expected = { theme: resolveTheme(mode, dark), mode };

        expect(run(value, dark), `stored=${String(value)} dark=${dark}`).toEqual(expected);
      }
    }
  });

  it("falls back safely when storage or matchMedia throw", () => {
    expect(run(THROWS, false)).toEqual({ theme: "light", mode: "system" });
    expect(run("dark", THROWS)).toEqual({ theme: "dark", mode: "dark" });
    expect(run(null, THROWS)).toEqual({ theme: "light", mode: "system" });
  });
});
