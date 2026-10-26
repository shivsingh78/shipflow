// HTTP client for the ShipFlow API. Connection settings come from
// SHIPFLOW_API_URL / SHIPFLOW_API_TOKEN or the file written by
// `shipflow login` (see lib/credentials.js).
import { resolveConnection } from "./lib/credentials.js";
import type { ConnectionOverrides } from "./lib/credentials.js";
import type { ProjectConfig } from "./lib/projectConfig.js";

let overrides: ConnectionOverrides = {};

export function setConnectionOverrides(value: ConnectionOverrides): void {
  overrides = value;
}

/** A release row as returned by the API. */
export interface ReleaseRow {
  release_id: string;
  project?: string | null;
  repo_url: string;
  ref?: string | null;
  mode?: string | null;
  target?: string | null;
  status: string;
  current_stage: string;
  commit_sha?: string | null;
  test_status?: string | null;
  artifact_path?: string | null;
  is_active?: boolean | number | null;
  public_deployment_url?: string | null;
  error_message?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApiCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ApiErrorBody {
  message?: string;
  errors?: { path: string; message: string }[];
  checks?: ApiCheck[];
}

export interface SecretRow {
  name: string;
  updated_at: string;
}

export interface TargetInfo {
  name: string;
  description: string;
  capabilities: {
    candidateVerification: string;
    atomicActivation: boolean;
    rollback: boolean;
  };
}

export interface ReleaseResponse {
  release: ReleaseRow;
}

export interface ProjectRow {
  name: string;
  repo_url: string;
  target: string;
  hostname?: string | null;
}

export interface PutProjectResponse {
  missingSecrets?: string[];
}

export interface WhoamiResponse {
  instance: string;
  secretsEnabled?: boolean;
  allowedRepoPrefixes?: string[];
  artifactStore: string;
  targets: TargetInfo[];
}

export interface ReleaseLogsResponse {
  release: ReleaseRow;
  logs: { stage: string; level: string; message: string }[];
  notifications: { type: string; message: string }[];
}

export interface EvidenceResponse {
  evidence: {
    releaseId: string;
    project: string;
    mode: string;
    status: string;
    stage: string;
    target: string;
    buildStrategy: string | null;
    artifact: { type: string; path?: string; digest?: string } | null;
    commitSha: string | null;
    testStatus: string | null;
    timeline: { stage: string; errors: number; warnings: number }[];
    failure: { stage: string; message: string } | null;
    diagnosis: { category: string; summary: string; suggestions: string[] } | null;
  };
}

export interface RollbackResponse {
  rollback: { previousReleaseId?: string | null; targetReleaseId: string };
}

export interface CancelResponse {
  status?: string;
}

export interface ProjectResponse {
  project: ProjectRow;
  activeReleaseId?: string | null;
  secrets: SecretRow[];
}

export interface ReadyResponse {
  checks?: ApiCheck[];
}

export class ApiError extends Error {
  status: number;
  body: ApiErrorBody;

  constructor(message: string, status: number, body: ApiErrorBody = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Call the ShipFlow API and turn every failure into a readable ApiError.
 */
async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  { timeoutMs = 30_000 }: { timeoutMs?: number } = {}
): Promise<T> {
  const { url: API_URL, token: API_TOKEN } = resolveConnection(overrides);
  const headers: Record<string, string> = {};

  if (API_TOKEN) {
    headers.Authorization = `Bearer ${API_TOKEN}`;
  }

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  let response;

  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const err = error as { name?: string; message?: string; cause?: { code?: string; message?: string } };
    const reason =
      err.name === "TimeoutError"
        ? "request timed out"
        : err.cause?.code || err.cause?.message || err.message;

    throw new ApiError(
      `Cannot reach ShipFlow API at ${API_URL} (${reason}). ` +
        "Is it running? Set SHIPFLOW_API_URL or run `shipflow login --server <url>`.",
      0
    );
  }

  const text = await response.text();
  let data: ApiErrorBody;

  try {
    data = text ? (JSON.parse(text) as ApiErrorBody) : {};
  } catch {
    data = { message: text.slice(0, 300) };
  }

  if (!response.ok) {
    let message = data.message || response.statusText;

    if (response.status === 401) {
      message += API_TOKEN
        ? ". Check that SHIPFLOW_API_TOKEN matches the server (or run `shipflow login` again)."
        : ". Set SHIPFLOW_API_TOKEN to the token configured on the server, or run `shipflow login`.";
    }

    throw new ApiError(
      `${message} (HTTP ${response.status})`,
      response.status,
      data
    );
  }

  return data as T;
}

const enc = encodeURIComponent;

/**
 * Create a new release. Accepts a repository URL (legacy form, project
 * "default") or { project, ref, mode }.
 */
export async function createRelease(
  repoUrlOrOptions: string | { project: string; ref?: string | undefined; mode?: string }
): Promise<ReleaseResponse> {
  return request<ReleaseResponse>(
    "POST",
    "/deploy",
    typeof repoUrlOrOptions === "string" ? { repoUrl: repoUrlOrOptions } : repoUrlOrOptions
  );
}

/**
 * Get the current state of a release.
 */
export async function getReleaseStatus(releaseId: string): Promise<ReleaseResponse> {
  return request<ReleaseResponse>("GET", `/releases/${enc(releaseId)}`);
}

export async function getAllReleases(project?: string): Promise<{ releases: ReleaseRow[] }> {
  return request<{ releases: ReleaseRow[] }>("GET", `/releases${project ? `?project=${enc(project)}` : ""}`);
}

export async function getReleaseLogs(releaseId: string): Promise<ReleaseLogsResponse> {
  return request<ReleaseLogsResponse>("GET", `/releases/${enc(releaseId)}/logs`);
}

export async function getReleaseEvidence(releaseId: string): Promise<EvidenceResponse> {
  return request<EvidenceResponse>("GET", `/releases/${enc(releaseId)}/evidence`);
}

export async function rollbackRelease(releaseId: string): Promise<RollbackResponse> {
  return request<RollbackResponse>("POST", `/rollback/${enc(releaseId)}`, undefined, { timeoutMs: 600_000 });
}

export const cancelRelease = (releaseId: string) =>
  request<CancelResponse>("POST", `/releases/${enc(releaseId)}/cancel`);
export const whoami = () => request<WhoamiResponse>("GET", "/whoami");
export const ready = () => request<ReadyResponse>("GET", "/ready");
export const health = () => request<unknown>("GET", "/health");
export const listProjects = () => request<{ projects: ProjectRow[] }>("GET", "/projects");
export const getProject = (name: string) => request<ProjectResponse>("GET", `/projects/${enc(name)}`);
export const putProject = (name: string, config: ProjectConfig) =>
  request<PutProjectResponse>("PUT", `/projects/${enc(name)}`, { config });
export const listSecrets = (project: string) =>
  request<{ secrets: SecretRow[] }>("GET", `/projects/${enc(project)}/secrets`);
export const setSecret = (project: string, name: string, value: string) =>
  request<unknown>("PUT", `/projects/${enc(project)}/secrets/${enc(name)}`, { value });
export const deleteSecret = (project: string, name: string) =>
  request<unknown>("DELETE", `/projects/${enc(project)}/secrets/${enc(name)}`);
export const checkProjectTarget = (project: string) =>
  request<ReadyResponse>("POST", `/projects/${enc(project)}/check`, undefined, { timeoutMs: 120_000 });
