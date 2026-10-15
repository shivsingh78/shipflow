import { pool } from "./db.js";

export async function createRelease({
  releaseId,
  repoUrl,
  status,
  currentStage,
  project = "default",
  mode = "deploy",
  ref = null,
  trigger = "cli",
  target = "shipflow",
  config = null,
}) {
  const result = await pool.query(
    `
    INSERT INTO releases
      (release_id, repo_url, status, current_stage, project, mode, ref, trigger, target, config)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING *
    `,
    [
      releaseId,
      repoUrl,
      status,
      currentStage,
      project,
      mode,
      ref,
      trigger,
      target,
      config,
    ]
  );

  return result.rows[0];
}

export async function getRelease(
  releaseId
) {
  const result = await pool.query(
    `
    SELECT *
    FROM releases
    WHERE release_id = $1
    `,
    [releaseId]
  );

  return result.rows[0];
}

export async function updateRelease(
  releaseId,
  updates
) {
  const result = await pool.query(
    `
    UPDATE releases
    SET
      status = COALESCE($2, status),
      current_stage = COALESCE($3, current_stage),
      error_message = COALESCE($4, error_message),
      deployment_url = COALESCE($5, deployment_url),
      artifact_path = COALESCE($6, artifact_path),
      public_deployment_url = COALESCE($7, public_deployment_url),
      commit_sha = COALESCE($8, commit_sha),
      test_status = COALESCE($9, test_status),
      updated_at = CURRENT_TIMESTAMP
    WHERE release_id = $1
    RETURNING *
    `,
    [
      releaseId,
      updates.status ?? null,
      updates.currentStage ?? null,
      updates.errorMessage ?? null,
      updates.deploymentUrl ?? null,
      updates.artifactPath ?? null,
      updates.publicDeploymentUrl ?? null,
      updates.commitSha ?? null,
      updates.testStatus ?? null,
    ]
  );

  return result.rows[0];
}

export async function getAllReleases(limit = 50, project = null) {
  const result = await pool.query(`
    SELECT *
    FROM releases
    WHERE ($2::text IS NULL OR project = $2)
    ORDER BY id DESC
    LIMIT $1
    `, [limit, project])

    return result.rows;

}

export async function requestCancel(releaseId) {
  const result = await pool.query(
    `
    UPDATE releases
    SET cancel_requested = TRUE, updated_at = CURRENT_TIMESTAMP
    WHERE release_id = $1 AND status IN ('QUEUED', 'RUNNING')
    RETURNING *
    `,
    [releaseId]
  );

  return result.rows[0];
}

/**
 * Atomically move a release from one status to another. Returns the row, or
 * undefined when the release was not in `from` (someone else moved it).
 */
export async function transitionRelease(releaseId, from, to, errorMessage = null) {
  const result = await pool.query(
    `
    UPDATE releases
    SET status = $3,
        error_message = COALESCE($4, error_message),
        updated_at = CURRENT_TIMESTAMP
    WHERE release_id = $1 AND status = ANY($2)
    RETURNING *
    `,
    [releaseId, from, to, errorMessage]
  );

  return result.rows[0];
}
