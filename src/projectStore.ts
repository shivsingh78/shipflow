import type { ProjectConfig } from "../cli/lib/projectConfig.js";
import { pool } from "./db.js";

export interface ProjectRow {
  name: string;
  repo_url: string;
  target: string;
  hostname: string | null;
  config: ProjectConfig;
  created_at: Date;
  updated_at: Date;
}

export type ProjectSummaryRow = Omit<ProjectRow, "config">;

export async function upsertProject(
  config: ProjectConfig
): Promise<ProjectRow | undefined> {
  const target = config.deployment.target;
  const hostname =
    config.deployment.target === "shipflow"
      ? config.deployment.shipflow.hostname ?? null
      : null;

  const result = await pool.query<ProjectRow>(
    `
    INSERT INTO projects (name, repo_url, target, hostname, config)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (name) DO UPDATE SET
      repo_url = EXCLUDED.repo_url,
      target = EXCLUDED.target,
      hostname = EXCLUDED.hostname,
      config = EXCLUDED.config,
      updated_at = CURRENT_TIMESTAMP
    RETURNING *
    `,
    [config.project.name, config.project.repository, target, hostname, config]
  );

  return result.rows[0];
}

export async function getProject(name: string): Promise<ProjectRow | undefined> {
  const result = await pool.query<ProjectRow>("SELECT * FROM projects WHERE name = $1", [name]);
  return result.rows[0];
}

export async function listProjects(): Promise<ProjectSummaryRow[]> {
  const result = await pool.query<ProjectSummaryRow>(
    "SELECT name, repo_url, target, hostname, created_at, updated_at FROM projects ORDER BY name"
  );
  return result.rows;
}

/**
 * Projects whose repository matches a GitHub "owner/repo" full name.
 */
export async function findProjectsByRepository(
  fullName: string
): Promise<ProjectRow[]> {
  const result = await pool.query<ProjectRow>(
    `
    SELECT * FROM projects
    WHERE lower(regexp_replace(repo_url, '(\\.git)?/?$', '')) = lower($1)
    `,
    [`https://github.com/${fullName}`]
  );
  return result.rows;
}

/**
 * Which project the site server should serve for a request Host.
 * 1. a "shipflow"-target project with that hostname;
 * 2. SHIPFLOW_SITE_DEFAULT_PROJECT, if set;
 * 3. otherwise the most recently activated project that has no hostname
 *    (covers single-project installs and legacy "default" releases).
 */
export async function resolveSiteProject(
  hostname: string | null | undefined,
  fallbackProject: string | null | undefined
): Promise<string | null> {
  if (hostname) {
    const byHost = await pool.query<{ name: string }>(
      "SELECT name FROM projects WHERE target = 'shipflow' AND hostname = $1",
      [hostname.toLowerCase()]
    );
    if (byHost.rows[0]) return byHost.rows[0].name;
  }

  if (fallbackProject) return fallbackProject;

  // Each project's newest pointer; projects taken offline (null) are skipped
  // so a failed first deploy cannot hide another project's live site.
  const recent = await pool.query<{ project: string }>(
    `
    SELECT latest.project
    FROM (
      SELECT DISTINCT ON (project) project, release_id, id
      FROM activations
      ORDER BY project, id DESC
    ) latest
    LEFT JOIN projects p ON p.name = latest.project
    WHERE latest.release_id IS NOT NULL
      AND (p.name IS NULL OR (p.target = 'shipflow' AND p.hostname IS NULL))
    ORDER BY latest.id DESC
    LIMIT 1
    `
  );

  return recent.rows[0]?.project ?? null;
}
