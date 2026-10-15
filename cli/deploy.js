const API_URL = (
  process.env.SHIPFLOW_API_URL ||
  "http://localhost:8000"
).replace(/\/+$/, "");

const API_TOKEN = process.env.SHIPFLOW_API_TOKEN;

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * Call the ShipFlow API and turn every failure into a readable ApiError.
 */
async function request(method, path, body) {
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
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    const reason =
      error.name === "TimeoutError"
        ? "request timed out"
        : error.cause?.code || error.cause?.message || error.message;

    throw new ApiError(
      `Cannot reach ShipFlow API at ${API_URL} (${reason}). ` +
        "Is it running? Set SHIPFLOW_API_URL to use a different address.",
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
        ? ". Check that SHIPFLOW_API_TOKEN matches the server."
        : ". Set SHIPFLOW_API_TOKEN to the token configured on the server.";
    }

    throw new ApiError(
      `${message} (HTTP ${response.status})`,
      response.status
    );
  }

  return data;
}

/**
 * Create a new release.
 */
export async function createRelease(repoUrl) {
  return request("POST", "/deploy", { repoUrl });
}

/**
 * Get the current state of a release.
 */
export async function getReleaseStatus(releaseId) {
  return request(
    "GET",
    `/releases/${encodeURIComponent(releaseId)}`
  );
}

export async function getAllReleases() {
  return request("GET", "/releases");
}

export async function getReleaseLogs(releaseId) {
  return request(
    "GET",
    `/releases/${encodeURIComponent(releaseId)}/logs`
  );
}

export async function rollbackRelease(releaseId) {
  return request(
    "POST",
    `/rollback/${encodeURIComponent(releaseId)}`
  );
}
