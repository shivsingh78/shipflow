import type { PoolClient } from "pg";

import { pool } from "./db.js";

export type ActivationAction = "DEPLOY" | "ROLLBACK";

export class StaleReleaseError extends Error {
  statusCode: number;

  constructor(message: string) {
    super(message);
    this.name = "StaleReleaseError";
    this.statusCode = 409;
  }
}

/**
 * A DEPLOY activation must never replace a live release that was created
 * after the candidate (for example a stalled, older job finishing late).
 * Rollbacks and reverts deliberately activate older releases.
 */
export function isStaleCandidate({
  action,
  candidateSeq,
  activeSeq,
}: {
  action: string;
  candidateSeq: number | undefined;
  activeSeq: number | null | undefined;
}): boolean {
  return (
    action === "DEPLOY" &&
    activeSeq != null &&
    candidateSeq !== undefined &&
    candidateSeq < activeSeq
  );
}

const LATEST_ACTIVATION = `
  SELECT a.release_id, r.id AS seq
  FROM activations a
  LEFT JOIN releases r ON r.release_id = a.release_id
  WHERE a.project = $1
  ORDER BY a.id DESC
  LIMIT 1
`;

interface ActivationRow {
  release_id: string | null;
  seq: number | null;
}

/**
 * The active release of a project is the newest row in `activations` for
 * that project.
 */
export async function getActiveReleaseId(project = "default"): Promise<string | null> {
  const result = await pool.query<ActivationRow>(LATEST_ACTIVATION, [project]);

  return result.rows[0]?.release_id ?? null;
}

async function withProjectLock<T>(
  project: string,
  work: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    // Serializes activations of one project (worker deploys, API rollbacks).
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('shipflow-activation:' || $1))",
      [project]
    );

    const result = await work(client);

    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Make `releaseId` the live release of `project`.
 *
 * `apply` (optional) performs the target's own switch (for example an SSH
 * symlink swap) while the lock is held. If it throws, nothing is recorded.
 * The pointer row is inserted only after `apply` succeeds.
 */
export async function activateRelease({
  project = "default",
  releaseId,
  action,
  apply,
}: {
  project?: string;
  releaseId: string;
  action: ActivationAction;
  apply?: (info: { previousReleaseId: string | null }) => unknown;
}): Promise<{ project: string; releaseId: string; previousReleaseId: string | null }> {
  return withProjectLock(project, async (client) => {
    const candidate = await client.query<{ id: number }>(
      "SELECT id FROM releases WHERE release_id = $1",
      [releaseId]
    );
    const current = await client.query<ActivationRow>(LATEST_ACTIVATION, [project]);

    const previousReleaseId = current.rows[0]?.release_id ?? null;

    if (
      isStaleCandidate({
        action,
        candidateSeq: candidate.rows[0]?.id,
        activeSeq: current.rows[0]?.seq,
      })
    ) {
      throw new StaleReleaseError(
        `Newer release ${previousReleaseId} is already live; refusing to activate older release ${releaseId}`
      );
    }

    if (apply) {
      await apply({ previousReleaseId });
    }

    await client.query(
      `
      INSERT INTO activations (project, release_id, previous_release_id, action)
      VALUES ($1, $2, $3, $4)
      `,
      [project, releaseId, previousReleaseId, action]
    );

    return { project, releaseId, previousReleaseId };
  });
}

/**
 * Undo an activation whose live check failed, but only if nothing else has
 * been activated since. `apply` switches the target back.
 * `previousReleaseId` null (first deployment) records a null pointer: the
 * project then has no live release.
 */
export async function revertActivation({
  project = "default",
  releaseId,
  previousReleaseId,
  apply,
}: {
  project?: string;
  releaseId: string;
  previousReleaseId: string | null;
  apply?: (info: { releaseId: string | null }) => unknown;
}): Promise<boolean> {
  return withProjectLock(project, async (client) => {
    const current = await client.query<ActivationRow>(LATEST_ACTIVATION, [project]);

    if (current.rows[0]?.release_id !== releaseId) {
      return false;
    }

    if (apply) {
      await apply({ releaseId: previousReleaseId });
    }

    await client.query(
      `
      INSERT INTO activations (project, release_id, previous_release_id, action)
      VALUES ($1, $2, $3, 'REVERT')
      `,
      [project, previousReleaseId, releaseId]
    );

    return true;
  });
}
