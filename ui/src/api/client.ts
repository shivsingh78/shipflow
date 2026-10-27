import { ApiError } from "./errors";
import type { ApiIssue } from "./errors";
import type { ProjectConfig } from "@/lib/projectConfig";
import type {
  CancelResult,
  CheckResult,
  DeployRequest,
  Evidence,
  ListReleasesOptions,
  ProjectDetail,
  ProjectSummary,
  Readiness,
  Release,
  ReleaseList,
  ReleaseLogs,
  RollbackResult,
  SaveProjectResult,
  WhoAmI,
} from "./types";

/**
 * Everything the dashboard asks of the server. The live implementation talks
 * to the ShipFlow API; the demo implementation (demo.ts) serves sample data
 * from memory and is only reachable through the explicit "demo" entry.
 */
export interface ApiClient {
  readonly mode: "live" | "demo";
  whoami(signal?: AbortSignal): Promise<WhoAmI>;
  ready(signal?: AbortSignal): Promise<Readiness>;
  listProjects(signal?: AbortSignal): Promise<ProjectSummary[]>;
  getProject(name: string, signal?: AbortSignal): Promise<ProjectDetail>;
  /** Create or update a project from a validated shipflow.yml configuration. */
  saveProject(config: ProjectConfig): Promise<SaveProjectResult>;
  /** Run the deployment target's own diagnostics (read-only). */
  checkProject(name: string): Promise<{ ok: boolean; checks: CheckResult[] }>;
  /** Write-only: the value is stored encrypted and never returned. */
  setSecret(project: string, name: string, value: string): Promise<void>;
  removeSecret(project: string, name: string): Promise<void>;
  listReleases(options?: ListReleasesOptions, signal?: AbortSignal): Promise<ReleaseList>;
  getRelease(releaseId: string, signal?: AbortSignal): Promise<Release>;
  getReleaseLogs(releaseId: string, signal?: AbortSignal): Promise<ReleaseLogs>;
  getEvidence(releaseId: string, signal?: AbortSignal): Promise<Evidence>;
  deploy(request: DeployRequest): Promise<Release>;
  cancelRelease(releaseId: string): Promise<CancelResult>;
  rollback(releaseId: string): Promise<RollbackResult>;
}

interface ErrorBody {
  message?: string;
  errors?: unknown;
}

function issuesOf(errors: unknown): ApiIssue[] {
  if (!Array.isArray(errors)) return [];

  return errors
    .filter((e): e is { path?: unknown; message?: unknown } => typeof e === "object" && e !== null)
    .map((e) => ({
      ...(typeof e.path === "string" ? { path: e.path } : {}),
      message: typeof e.message === "string" ? e.message : "Invalid value",
    }));
}

const enc = encodeURIComponent;

/** The real API client. `token` is sent as a bearer token on every request. */
export function createHttpClient({
  token,
  baseUrl = "",
  fetchImpl = (...args: Parameters<typeof fetch>) => fetch(...args),
  onUnauthorized,
}: {
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  onUnauthorized?: () => void;
}): ApiClient {
  async function request<T>(
    method: string,
    path: string,
    { body, signal, allowStatuses = [] }: { body?: unknown; signal?: AbortSignal | undefined; allowStatuses?: number[] } = {}
  ): Promise<T> {
    let response: Response;

    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
        credentials: "omit",
        cache: "no-store",
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new ApiError("Cannot reach the ShipFlow API", 0);
    }

    let json: unknown = null;

    try {
      json = await response.json();
    } catch {
      // Non-JSON body: handled below.
    }

    if (!response.ok && !allowStatuses.includes(response.status)) {
      if (response.status === 401) onUnauthorized?.();

      const data = (json ?? {}) as ErrorBody;

      throw new ApiError(data.message ?? `Request failed (HTTP ${response.status})`, response.status, issuesOf(data.errors));
    }

    if (json === null || typeof json !== "object") {
      throw new ApiError("The server returned an unexpected response", response.status);
    }

    return json as T;
  }

  return {
    mode: "live",

    async whoami(signal) {
      return request<WhoAmI & { success: boolean }>("GET", "/whoami", { signal });
    },

    async ready(signal) {
      // 503 carries the failing checks; it is data, not an error.
      const result = await request<{ success: boolean; checks: CheckResult[] }>("GET", "/ready", { signal, allowStatuses: [503] });

      return { ok: result.success, checks: result.checks };
    },

    async listProjects(signal) {
      return (await request<{ projects: ProjectSummary[] }>("GET", "/projects", { signal })).projects;
    },

    async getProject(name, signal) {
      return request<ProjectDetail>("GET", `/projects/${enc(name)}`, { signal });
    },

    async saveProject(config) {
      return request<SaveProjectResult>("PUT", `/projects/${enc(config.project.name)}`, { body: { config } });
    },

    async checkProject(name) {
      const result = await request<{ success: boolean; checks: CheckResult[] }>("POST", `/projects/${enc(name)}/check`, { body: {}, allowStatuses: [] });

      return { ok: result.success, checks: result.checks };
    },

    async setSecret(project, name, value) {
      await request("PUT", `/projects/${enc(project)}/secrets/${enc(name)}`, { body: { value } });
    },

    async removeSecret(project, name) {
      await request("DELETE", `/projects/${enc(project)}/secrets/${enc(name)}`);
    },

    async listReleases(options = {}, signal) {
      const query = new URLSearchParams();

      if (options.project) query.set("project", options.project);
      if (options.limit) query.set("limit", String(options.limit));

      const suffix = query.size > 0 ? `?${query.toString()}` : "";

      return request<ReleaseList>("GET", `/releases${suffix}`, { signal });
    },

    async getRelease(releaseId, signal) {
      return (await request<{ release: Release }>("GET", `/releases/${enc(releaseId)}`, { signal })).release;
    },

    async getReleaseLogs(releaseId, signal) {
      return request<ReleaseLogs>("GET", `/releases/${enc(releaseId)}/logs`, { signal });
    },

    async getEvidence(releaseId, signal) {
      return (await request<{ evidence: Evidence }>("GET", `/releases/${enc(releaseId)}/evidence`, { signal })).evidence;
    },

    async deploy(deployRequest) {
      return (await request<{ release: Release }>("POST", "/deploy", { body: { trigger: "dashboard", ...deployRequest } })).release;
    },

    async cancelRelease(releaseId) {
      return request<CancelResult>("POST", `/releases/${enc(releaseId)}/cancel`, { body: {}, allowStatuses: [] });
    },

    async rollback(releaseId) {
      return (await request<{ rollback: RollbackResult }>("POST", `/rollback/${enc(releaseId)}`, { body: {} })).rollback;
    },
  };
}
