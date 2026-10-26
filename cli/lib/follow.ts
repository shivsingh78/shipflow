// Poll a release until it reaches a final state.
import { getReleaseStatus } from "../deploy.js";
import type { ReleaseResponse, ReleaseRow } from "../deploy.js";

const sleepFor = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Returns the final release row, or null when `timeoutMs` elapsed first.
 * `onState` is called with "STAGE (STATUS)" whenever it changes.
 */
export async function followRelease(
  release: { release_id: string },
  {
    timeoutMs,
    pollMs = 2000,
    onState = () => {},
    getStatus = getReleaseStatus,
    sleep = sleepFor,
  }: {
    timeoutMs: number;
    pollMs?: number | undefined;
    onState?: (state: string) => void;
    getStatus?: (releaseId: string) => Promise<ReleaseResponse>;
    sleep?: (ms: number) => Promise<unknown>;
  }
): Promise<ReleaseRow | null> {
  const startedAt = Date.now();
  let lastState: string | null = null;
  let consecutiveErrors = 0;

  while (Date.now() - startedAt < timeoutMs) {
    let current: ReleaseRow;

    try {
      current = (await getStatus(release.release_id)).release;
      consecutiveErrors = 0;
    } catch (error) {
      // Tolerate brief API restarts while a build is running.
      if (++consecutiveErrors >= 5 || (error as { status?: unknown }).status === 404) throw error;
      await sleep(pollMs);
      continue;
    }

    const state = `${current.current_stage} (${current.status})`;

    if (state !== lastState) {
      onState(state);
      lastState = state;
    }

    if (["SUCCESS", "FAILED", "CANCELLED"].includes(current.status)) {
      return current;
    }

    await sleep(pollMs);
  }

  return null;
}
