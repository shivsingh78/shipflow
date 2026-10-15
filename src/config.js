import path from "path";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

function intFromEnv(name, fallback) {
  const raw = process.env[name];

  if (raw === undefined || raw === "") {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

function listFromEnv(name, fallback) {
  const raw = process.env[name];

  if (!raw) {
    return fallback;
  }

  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function stripTrailingSlash(url) {
  return url.replace(/\/+$/, "");
}

export const config = {
  apiPort: intFromEnv("PORT", 8000),
  sitePort: intFromEnv("SITE_PORT", 8080),

  apiToken: process.env.SHIPFLOW_API_TOKEN || "",

  // Only repositories whose URL starts with one of these prefixes
  // can be deployed.
  allowedRepoPrefixes: listFromEnv(
    "SHIPFLOW_ALLOWED_REPO_PREFIXES",
    ["https://github.com/"]
  ),

  maxQueuedReleases: intFromEnv("SHIPFLOW_MAX_QUEUED", 5),
  workerConcurrency: intFromEnv("SHIPFLOW_WORKER_CONCURRENCY", 1),
  requireTests: process.env.SHIPFLOW_REQUIRE_TESTS === "true",

  // "docker" runs repository code in a throwaway container.
  // "none" runs it directly on the worker and is for local development only.
  sandbox: process.env.SHIPFLOW_SANDBOX || "docker",
  sandboxImage: process.env.SHIPFLOW_SANDBOX_IMAGE || "node:22-alpine",
  sandboxMemory: process.env.SHIPFLOW_SANDBOX_MEMORY || "1g",
  sandboxCpus: process.env.SHIPFLOW_SANDBOX_CPUS || "1",
  sandboxPidsLimit: intFromEnv("SHIPFLOW_SANDBOX_PIDS", 512),

  cloneTimeoutMs: intFromEnv("SHIPFLOW_CLONE_TIMEOUT_MS", 120_000),
  installTimeoutMs: intFromEnv("SHIPFLOW_INSTALL_TIMEOUT_MS", 600_000),
  buildTimeoutMs: intFromEnv("SHIPFLOW_BUILD_TIMEOUT_MS", 600_000),
  testTimeoutMs: intFromEnv("SHIPFLOW_TEST_TIMEOUT_MS", 300_000),

  maxArtifactFiles: intFromEnv("SHIPFLOW_MAX_ARTIFACT_FILES", 5000),
  maxArtifactBytes: intFromEnv(
    "SHIPFLOW_MAX_ARTIFACT_BYTES",
    200 * 1024 * 1024
  ),

  workspaceRoot:
    process.env.SHIPFLOW_WORKSPACE_ROOT ||
    path.join(process.cwd(), "output"),

  // Where the worker reaches the API / site for health checks.
  internalApiUrl: stripTrailingSlash(
    process.env.INTERNAL_API_URL || "http://127.0.0.1:8000"
  ),
  internalSiteUrl: stripTrailingSlash(
    process.env.INTERNAL_SITE_URL || "http://127.0.0.1:8080"
  ),

  // URL shown to users for the active deployment.
  publicSiteUrl:
    process.env.PUBLIC_SITE_URL || "http://localhost:8080/",

  s3: {
    bucket: process.env.S3_BUCKET_NAME,
    region: process.env.AWS_REGION || "us-east-1",
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    // AWS_SECRET_KEY is the name older ShipFlow .env files used.
    secretAccessKey:
      process.env.AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_KEY,
  },
};
