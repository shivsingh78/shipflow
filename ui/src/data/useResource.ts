import { useCallback, useEffect, useRef, useState } from "react";

export interface Resource<T> {
  data: T | undefined;
  error: unknown;
  /** "loading" only before the first result for the current inputs. */
  status: "loading" | "ready" | "error";
  /** A background refresh (poll or manual) is in flight. */
  refreshing: boolean;
  refresh: () => Promise<void>;
  updatedAt: number | null;
}

export interface ResourceOptions {
  /** Re-fetch every N ms while the tab is visible. */
  pollMs?: number | false | undefined;
  enabled?: boolean | undefined;
}

/**
 * Load data with loading / error / refresh state, optional polling, and
 * cancellation. `load` may change on every render; it re-runs when `deps` change.
 */
export function useResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  { pollMs = false, enabled = true }: ResourceOptions = {}
): Resource<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [status, setStatus] = useState<Resource<T>["status"]>("loading");
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const loadRef = useRef(load);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    loadRef.current = load;
  });

  const run = useCallback(async (background: boolean) => {
    controller.current?.abort();

    const abort = new AbortController();
    const mine = ++generation.current;

    controller.current = abort;
    if (background) setRefreshing(true);

    try {
      const result = await loadRef.current(abort.signal);

      if (mine !== generation.current) return;

      setData(result);
      setError(undefined);
      setStatus("ready");
      setUpdatedAt(Date.now());
    } catch (caught) {
      if (mine !== generation.current || (caught instanceof DOMException && caught.name === "AbortError")) return;

      setError(caught);
      // Keep showing the last good data when a background refresh fails.
      setStatus((current) => (current === "ready" && background ? "ready" : "error"));
    } finally {
      if (mine === generation.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;

    // Reset before fetching for new inputs: synchronizing React state with an external system (the API).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus("loading");
    setData(undefined);
    setError(undefined);
    void run(false);

    return () => {
      generation.current += 1;
      controller.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `deps` is the caller's dependency list.
  }, [enabled, run, ...deps]);

  useEffect(() => {
    if (!enabled || !pollMs) return undefined;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const schedule = () => {
      timer = setTimeout(() => {
        if (stopped) return;

        if (document.hidden) {
          schedule();
          return;
        }

        void run(true).finally(() => {
          if (!stopped) schedule();
        });
      }, pollMs);
    };

    schedule();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restart polling when the inputs change.
  }, [enabled, pollMs, run, ...deps]);

  const refresh = useCallback(() => run(true), [run]);

  return { data, error, status, refreshing, refresh, updatedAt };
}
