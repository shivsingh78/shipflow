// Keeps PostgreSQL release state consistent with the queue after crashes.
//
// BullMQ delivers jobs at least once. ShipFlow does not re-run a stalled
// job (maxStalledCount: 0) because deploy stages have side effects; a
// release whose worker disappeared is marked FAILED with an explanation
// instead, and can be redeployed deliberately.
import { pool } from "./db.js";
import { transitionRelease } from "./releaseStore.js";
import type { ReleaseRow } from "./releaseStore.js";

/** The release columns reconciliation reads. */
export type ReconcileRelease = Pick<ReleaseRow, "release_id" | "status" | "current_stage">;

/** The part of a BullMQ queue reconciliation needs. */
export interface JobLookup {
  getJob(
    id: string
  ): Promise<{ getState(): Promise<string> } | undefined | null>;
}

const LIVE_JOB_STATES = ["waiting", "delayed", "prioritized", "active", "waiting-children"];

export function orphanMessage(release: ReconcileRelease, jobState: string): string {
  if (release.status === "QUEUED") {
    return `Release job is missing from the queue (state: ${jobState}); redeploy to try again`;
  }

  const base = `The worker stopped while this release was in ${release.current_stage}; it was not retried automatically`;

  return release.current_stage === "ACTIVATE"
    ? `${base}. It may already be live: check \`shipflow status\` and roll back if needed`
    : `${base}. Redeploy to try again`;
}

export function isOrphaned(release: ReconcileRelease, jobState: string): boolean {
  if (release.status === "RUNNING") return jobState !== "active";
  return !LIVE_JOB_STATES.includes(jobState);
}

export async function reconcileReleases(queue: JobLookup): Promise<string[]> {
  const result = await pool.query<ReconcileRelease>(
    "SELECT release_id, status, current_stage FROM releases WHERE status IN ('QUEUED', 'RUNNING')"
  );
  const fixed: string[] = [];

  for (const release of result.rows) {
    const job = await queue.getJob(release.release_id);
    const state = job ? await job.getState() : "missing";

    if (isOrphaned(release, state)) {
      const updated = await transitionRelease(
        release.release_id,
        [release.status],
        "FAILED",
        orphanMessage(release, state)
      );
      if (updated) fixed.push(release.release_id);
    }
  }

  return fixed;
}
