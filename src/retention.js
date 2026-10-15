// Bounded storage: keep the newest successful releases of each project (and
// whatever is live), remove stored artifacts of the rest, and delete old
// log rows. Runs best-effort; failures are logged, never fatal.
import { config } from "./config.js";
import { pool } from "./db.js";
import { getActiveReleaseId } from "./activation.js";

const FINAL = ["SUCCESS", "FAILED", "CANCELLED"];

/**
 * Pure selection: which releases' artifacts to delete.
 * `releases` are newest first.
 */
export function selectPrunable(releases, { keep, activeReleaseId }) {
  if (!keep) return [];

  let keptSuccess = 0;
  const prune = [];

  for (const release of releases) {
    if (!FINAL.includes(release.status) || release.release_id === activeReleaseId) {
      continue;
    }

    if (release.status === "SUCCESS" && keptSuccess < keep) {
      keptSuccess += 1;
      continue;
    }

    prune.push(release.release_id);
  }

  return prune;
}

export async function pruneArtifacts({ project, store, keep = config.keepReleases }) {
  const activeReleaseId = await getActiveReleaseId(project);
  const result = await pool.query(
    `
    SELECT release_id, status FROM releases
    WHERE project = $1 AND mode = 'deploy' AND NOT artifacts_pruned
    ORDER BY id DESC
    `,
    [project]
  );

  const prune = selectPrunable(result.rows, { keep, activeReleaseId });

  for (const releaseId of prune) {
    const objects = await store.list(`releases/${releaseId}/`);

    if (objects.length > 0) {
      await store.remove(objects.map((object) => object.key));
    }

    await pool.query(
      `UPDATE releases SET artifact_path = NULL, artifacts_pruned = TRUE WHERE release_id = $1`,
      [releaseId]
    );
  }

  return prune;
}

export async function pruneLogs(days = config.logRetentionDays) {
  if (!days) return 0;

  const logs = await pool.query(
    `DELETE FROM release_logs WHERE created_at < CURRENT_TIMESTAMP - make_interval(days => $1)`,
    [days]
  );
  await pool.query(
    `DELETE FROM notifications WHERE created_at < CURRENT_TIMESTAMP - make_interval(days => $1)`,
    [days]
  );

  return logs.rowCount;
}
