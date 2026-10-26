import type { ProjectConfig } from "../cli/lib/projectConfig.js";
import { pool } from "./db.js";
import type { Artifact } from "./artifacts.js";

export interface ReleaseRow {
  id: number;
  release_id: string;
  repo_url: string;
  status: string;
  current_stage: string;
  created_at: Date;
  updated_at: Date;
  error_message: string | null;
  deployment_url: string | null;
  artifact_path: string | null;
  public_deployment_url: string | null;
  commit_sha: string | null;
  test_status: string | null;
  project: string;
  mode: string;
  ref: string | null;
  trigger: string;
  target: string;
  config: ProjectConfig | null;
  cancel_requested: boolean;
  artifacts_pruned: boolean;
  artifact_type: string;
  artifact: Artifact | null;
  build_strategy: string | null;
  deployment: Record<string, unknown> | null;
}

export interface CreateReleaseInput {
  releaseId: string;
  repoUrl: string;
  status: string;
  currentStage: string;
  project?: string;
  mode?: string;
  ref?: string | null;
  trigger?: string;
  target?: string;
  config?: ProjectConfig | null;
}

export interface ReleaseUpdates {
  status?: string | null;
  currentStage?: string | null;
  errorMessage?: string | null;
  deploymentUrl?: string | null;
  artifactPath?: string | null;
  publicDeploymentUrl?: string | null;
  commitSha?: string | null;
  testStatus?: string | null;
  artifact?: Artifact | null;
  buildStrategy?: string | null;
  deployment?: Record<string, unknown> | null;
}

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
}: CreateReleaseInput): Promise<ReleaseRow | undefined> {
  const result = await pool.query<ReleaseRow>(
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
  releaseId: string
): Promise<ReleaseRow | undefined> {
  const result = await pool.query<ReleaseRow>(
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
  releaseId: string,
  updates: ReleaseUpdates
): Promise<ReleaseRow | undefined> {
  const result = await pool.query<ReleaseRow>(
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
      artifact_type = COALESCE($10, artifact_type),
      artifact = COALESCE($11::jsonb, artifact),
      build_strategy = COALESCE($12, build_strategy),
      deployment = COALESCE($13::jsonb, deployment),
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
      updates.artifact?.type ?? null,
      updates.artifact ? JSON.stringify(updates.artifact) : null,
      updates.buildStrategy ?? null,
      updates.deployment ? JSON.stringify(updates.deployment) : null,
    ]
  );

  return result.rows[0];
}

export async function getAllReleases(
  limit = 50,
  project: string | null = null
): Promise<ReleaseRow[]> {
  const result = await pool.query<ReleaseRow>(`
    SELECT *
    FROM releases
    WHERE ($2::text IS NULL OR project = $2)
    ORDER BY id DESC
    LIMIT $1
    `, [limit, project])

    return result.rows;

}

export async function requestCancel(
  releaseId: string
): Promise<ReleaseRow | undefined> {
  const result = await pool.query<ReleaseRow>(
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
export async function transitionRelease(
  releaseId: string,
  from: string[],
  to: string,
  errorMessage: string | null = null
): Promise<ReleaseRow | undefined> {
  const result = await pool.query<ReleaseRow>(
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
