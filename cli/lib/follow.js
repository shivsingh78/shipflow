// Poll a release until it reaches a final state.
import { getReleaseStatus } from "../deploy.js";

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Returns the final release row, or null when `timeoutMs` elapsed first.
 * `onState` is called with "STAGE (STATUS)" whenever it changes.
 */
export async function followRelease(
  release,
  {
    timeoutMs,
    pollMs = 2000,
    onState = () => {},
    getStatus = getReleaseStatus,
    sleep = sleepFor,
  }
) {
  const startedAt = Date.now();
  let lastState = null;
  let consecutiveErrors = 0;

  while (Date.now() - startedAt < timeoutMs) {
    let current;

    try {
      current = (await getStatus(release.release_id)).release;
      consecutiveErrors = 0;
    } catch (error) {
      // Tolerate brief API restarts while a build is running.
      if (++consecutiveErrors >= 5 || error.status === 404) throw error;
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
