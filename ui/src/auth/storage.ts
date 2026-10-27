// The API token is a credential. It lives in sessionStorage by default (gone
// when the tab closes); "remember on this device" is an explicit opt-in that
// uses localStorage. It is never put in a URL, a cookie or a log line.
const KEY = "shipflow.token";
const DEMO_KEY = "shipflow.demo";

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export const tokenStorage = {
  read(): { token: string; remembered: boolean } | null {
    const session = safe(() => sessionStorage.getItem(KEY), null);

    if (session) return { token: session, remembered: false };

    const local = safe(() => localStorage.getItem(KEY), null);

    return local ? { token: local, remembered: true } : null;
  },

  write(token: string, remember: boolean): void {
    this.clear();
    safe(() => (remember ? localStorage : sessionStorage).setItem(KEY, token), undefined);
  },

  clear(): void {
    safe(() => sessionStorage.removeItem(KEY), undefined);
    safe(() => localStorage.removeItem(KEY), undefined);
  },

  readDemo: (): boolean => safe(() => sessionStorage.getItem(DEMO_KEY) === "1", false),
  writeDemo: (on: boolean): void => safe(() => (on ? sessionStorage.setItem(DEMO_KEY, "1") : sessionStorage.removeItem(DEMO_KEY)), undefined),
};
