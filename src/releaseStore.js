import { pool } from "./db.js";

export async function createRelease({
  releaseId,
  repoUrl,
  status,
  currentStage,
}) {
  const result = await pool.query(
    ` 
        
        INSERT INTO releases 
        (release_id, repo_url, status, current_stage )
        VALUES
        ($1,$2,$3,$4)
        RETURNING *
        `,
    [releaseId, repoUrl, status, currentStage],
  );
  return result.rows[0];
}

export async function getRelease(releaseId) {
  const result = await pool.query(
    `
        SELECT *
        FROM releases
        WHERE release_id = $1
        `,
    [releaseId],
  );
  return result.rows[0];
}

export async function updateRelease(releaseId, updates) {
  const result = await pool.query(
     `
    UPDATE releases
    SET
      status = COALESCE($2, status),
      current_stage = COALESCE($3, current_stage),
      error_message = COALESCE($4, error_message),
      deployment_url = COALESCE($5, deployment_url),
      updated_at = CURRENT_TIMESTAMP
    WHERE release_id = $1
    RETURNING *
    `,
    [
      releaseId,
      updates.status ?? null,
      updates.currentStage ?? null,
      updates.errorMessage ?? null,
      updateRelease.deploymentUrl ?? null,
    ],
  );

  return result.rows[0];
}
