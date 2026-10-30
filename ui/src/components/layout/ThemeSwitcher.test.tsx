import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THEME_STORAGE_KEY } from "@/lib/theme";
import { ThemeProvider } from "./Theme";
import { ThemeSwitcher } from "./ThemeSwitcher";

/** A matchMedia whose "prefers dark" can be flipped, like the OS appearance setting. */
function operatingSystem(initialDark: boolean) {
  let dark = initialDark;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();

  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return query.includes("dark") ? dark : false;
    },
    media: query,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => void listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => void listeners.delete(listener),
  }));

  return {
    setDark(next: boolean) {
      dark = next;
      act(() => listeners.forEach((listener) => listener({ matches: next } as MediaQueryListEvent)));
    },
    listenerCount: () => listeners.size,
  };
}

const mount = () => render(<ThemeProvider><ThemeSwitcher /></ThemeProvider>);
const root = () => document.documentElement;
const trigger = () => screen.getByRole("button", { name: /^Theme:/ });

describe("theme switcher", () => {
  beforeEach(() => {
    localStorage.clear();
    root().removeAttribute("data-theme");
    root().removeAttribute("data-theme-mode");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults a first-time visitor to System and follows a dark OS", () => {
    operatingSystem(true);
    mount();

    expect(root().dataset.themeMode).toBe("system");
    expect(root().dataset.theme).toBe("dark");
    expect(trigger()).toHaveAccessibleName("Theme: System (dark)");
  });

  it("follows a light OS too", () => {
    operatingSystem(false);
    mount();

    expect(root().dataset.theme).toBe("light");
    expect(trigger()).toHaveAccessibleName("Theme: System (light)");
  });

  it("offers Light, Dark and System as a menu with icons, marking the current one", async () => {
    operatingSystem(false);
    mount();
    await userEvent.click(trigger());

    const menu = screen.getByRole("menu", { name: "Theme" });
    const options = within(menu).getAllByRole("menuitemradio");

    expect(options.map((option) => option.textContent?.replace(/\s+/g, " ").trim())).toEqual(["Light", "Dark", "System · currently light"]);
    expect(options.map((option) => option.getAttribute("aria-checked"))).toEqual(["false", "false", "true"]);
    expect(menu.querySelectorAll("svg").length).toBeGreaterThanOrEqual(4); // three icons + the check
  });

  it("applies an explicit choice immediately, persists it, and restores it after a reload", async () => {
    operatingSystem(false);

    const first = mount();

    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole("menuitemradio", { name: /^Dark/ }));

    expect(root().dataset.theme).toBe("dark");
    expect(root().dataset.themeMode).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(trigger()).toHaveAccessibleName("Theme: dark");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    // "Reload": a brand-new provider with only localStorage left over.
    first.unmount();
    root().removeAttribute("data-theme");
    mount();

    expect(root().dataset.theme).toBe("dark");
    expect(trigger()).toHaveAccessibleName("Theme: dark");
  });

  it("System follows OS appearance changes live; an explicit choice ignores them", async () => {
    const os = operatingSystem(false);

    mount();
    expect(root().dataset.theme).toBe("light");

    os.setDark(true);
    expect(root().dataset.theme).toBe("dark");
    expect(trigger()).toHaveAccessibleName("Theme: System (dark)");

    os.setDark(false);
    expect(root().dataset.theme).toBe("light");

    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole("menuitemradio", { name: /^Light/ }));
    os.setDark(true);
    expect(root().dataset.theme).toBe("light");

    // Going back to System picks the OS up again.
    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole("menuitemradio", { name: /^System/ }));
    expect(root().dataset.theme).toBe("dark");
  });

  it("stops listening to the OS when it unmounts", () => {
    const os = operatingSystem(false);
    const view = mount();

    expect(os.listenerCount()).toBe(1);
    view.unmount();
    expect(os.listenerCount()).toBe(0);
  });

  it("picks up a choice made in another tab", () => {
    operatingSystem(false);
    mount();

    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY }));
    });

    expect(root().dataset.theme).toBe("dark");
  });

  it("ignores a corrupt stored value", () => {
    operatingSystem(true);
    localStorage.setItem(THEME_STORAGE_KEY, "hotpink");
    mount();

    expect(root().dataset.themeMode).toBe("system");
    expect(root().dataset.theme).toBe("dark");
  });

  it("is fully keyboard operable", async () => {
    operatingSystem(false);
    const user = userEvent.setup();

    mount();
    trigger().focus();
    await user.keyboard("{Enter}");

    const [light, dark, system] = screen.getAllByRole("menuitemradio");

    // Focus lands on the selected option (System), and wraps around the ends.
    expect(system).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(light).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(system).toHaveFocus();
    await user.keyboard("{Home}");
    expect(light).toHaveFocus();
    await user.keyboard("{End}");
    expect(system).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(dark).toHaveFocus();

    // Enter selects and returns focus to the trigger.
    await user.keyboard("{Enter}");
    expect(root().dataset.theme).toBe("dark");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();

    // Escape closes without changing anything and returns focus.
    await user.keyboard("{Enter}");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
    expect(root().dataset.theme).toBe("dark");
  });

  it("closes on an outside click and exposes its state to assistive tech", async () => {
    operatingSystem(false);
    mount();

    expect(trigger()).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(trigger());
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
  });
});
