// HTTP client for the ShipFlow API. Connection settings come from
// SHIPFLOW_API_URL / SHIPFLOW_API_TOKEN or the file written by
// `shipflow login` (see lib/credentials.js).
import { resolveConnection } from "./lib/credentials.js";

let overrides = {};

export function setConnectionOverrides(value) {
  overrides = value;
}

export class ApiError extends Error {
  constructor(message, status, body = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Call the ShipFlow API and turn every failure into a readable ApiError.
 */
async function request(method, path, body, { timeoutMs = 30_000 } = {}) {
  const { url: API_URL, token: API_TOKEN } = resolveConnection(overrides);
  const headers = {};

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
    const reason =
      error.name === "TimeoutError"
        ? "request timed out"
        : error.cause?.code || error.cause?.message || error.message;

    throw new ApiError(
      `Cannot reach ShipFlow API at ${API_URL} (${reason}). ` +
        "Is it running? Set SHIPFLOW_API_URL or run `shipflow login --server <url>`.",
      0
    );
  }

  const text = await response.text();
  let data;

  try {
    data = text ? JSON.parse(text) : {};
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

  return data;
}

const enc = encodeURIComponent;

/**
 * Create a new release. Accepts a repository URL (legacy form, project
 * "default") or { project, ref, mode }.
 */
export async function createRelease(repoUrlOrOptions) {
  return request(
    "POST",
    "/deploy",
    typeof repoUrlOrOptions === "string" ? { repoUrl: repoUrlOrOptions } : repoUrlOrOptions
  );
}

/**
 * Get the current state of a release.
 */
export async function getReleaseStatus(releaseId) {
  return request("GET", `/releases/${enc(releaseId)}`);
}

export async function getAllReleases(project) {
  return request("GET", `/releases${project ? `?project=${enc(project)}` : ""}`);
}

export async function getReleaseLogs(releaseId) {
  return request("GET", `/releases/${enc(releaseId)}/logs`);
}

export async function rollbackRelease(releaseId) {
  return request("POST", `/rollback/${enc(releaseId)}`, undefined, { timeoutMs: 600_000 });
}

export const cancelRelease = (releaseId) => request("POST", `/releases/${enc(releaseId)}/cancel`);
export const whoami = () => request("GET", "/whoami");
export const ready = () => request("GET", "/ready");
export const health = () => request("GET", "/health");
export const listProjects = () => request("GET", "/projects");
export const getProject = (name) => request("GET", `/projects/${enc(name)}`);
export const putProject = (name, config) => request("PUT", `/projects/${enc(name)}`, { config });
export const listSecrets = (project) => request("GET", `/projects/${enc(project)}/secrets`);
export const setSecret = (project, name, value) =>
  request("PUT", `/projects/${enc(project)}/secrets/${enc(name)}`, { value });
export const deleteSecret = (project, name) =>
  request("DELETE", `/projects/${enc(project)}/secrets/${enc(name)}`);
export const checkProjectTarget = (project) =>
  request("POST", `/projects/${enc(project)}/check`, undefined, { timeoutMs: 120_000 });
