import http from "http";
import https from "https";
import crypto from "crypto";

import { config } from "./config.js";

/**
 * One HTTP GET with a timeout, no redirects, and a bounded body (1 MiB).
 * Supports a Host override, which fetch() does not allow.
 */
export function httpGet(url, { headers = {}, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === "https:" ? https : http;

    const req = client.get(target, { headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      let size = 0;

      res.on("data", (chunk) => {
        size += chunk.length;
        if (size <= 1024 * 1024) chunks.push(chunk);
      });
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        })
      );
      res.on("error", reject);
    });

    req.on("timeout", () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)));
    req.on("error", (error) =>
      reject(new Error(`Health check request to ${url} failed: ${error.code || error.message}`))
    );
  });
}

export const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

async function check(url, releaseId, headers = {}) {
  const response = await httpGet(url, { headers });
  const contentType = response.headers["content-type"] || "";
  const servedRelease = response.headers["x-shipflow-release"];

  if (response.status !== 200) {
    throw new Error(`Health check ${url} returned HTTP ${response.status}`);
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
 * HTTP check of the live ShipFlow-served site after activation. `hostname`
 * selects a host-routed project on the site server.
 */
export async function verifyActive({ releaseId, hostname, attempts = 3 }) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await check(
        `${config.internalSiteUrl}/`,
        releaseId,
        hostname ? { Host: hostname } : {}
      );
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  throw lastError;
}
