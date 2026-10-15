import { config } from "./config.js";

async function check(url, releaseId, headers = {}) {
  let response;

  try {
    response = await fetch(url, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new Error(
      `Health check request to ${url} failed: ${error.cause?.code || error.message}`
    );
  }

  await response.body?.cancel();

  const contentType = response.headers.get("content-type") || "";
  const servedRelease = response.headers.get("x-shipflow-release");

  if (response.status !== 200) {
    throw new Error(
      `Health check ${url} returned HTTP ${response.status}`
    );
  }

  if (!contentType.startsWith("text/html")) {
    throw new Error(
      `Health check ${url} returned content type "${contentType}", expected text/html`
    );
  }

  if (servedRelease !== releaseId) {
    throw new Error(
      `Health check ${url} served release ${servedRelease ?? "(none)"}, expected ${releaseId}`
    );
  }

  return {
    url,
    statusCode: response.status,
    contentType,
  };
}

/**
 * HTTP check of the uploaded candidate through the real serving code,
 * before it is made active.
 */
export async function verifyCandidate({ releaseId }) {
  return check(
    `${config.internalApiUrl}/preview/${releaseId}/`,
    releaseId,
    { Authorization: `Bearer ${config.apiToken}` }
  );
}

/**
 * HTTP check of the live site after activation.
 */
export async function verifyActive({ releaseId, attempts = 3 }) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await check(`${config.internalSiteUrl}/`, releaseId);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  throw lastError;
}
