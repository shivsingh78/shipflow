import path from "path";
import dotenv from "dotenv";

// Unit tests set SHIPFLOW_NO_DOTENV=1 (test/unit/setup.js) so a developer's
// .env (real database, cloud credentials) is never loaded into tests.
if (process.env.SHIPFLOW_NO_DOTENV !== "1") {
  dotenv.config({ quiet: true });
}

function intFromEnv(name: string, fallback: number): number {
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

// Non-negative integer; 0 disables the feature it controls.
function intOrZero(name: string, fallback: number): number {
  const raw = process.env[name];

  if (raw === undefined || raw === "") {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  return value;
}

function listFromEnv(name: string, fallback: string[]): string[] {
  const raw = process.env[name];

  if (!raw) {
    return fallback;
  }

  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export const config = {
  apiPort: intFromEnv("PORT", 8000),
  sitePort: intFromEnv("SITE_PORT", 8080),

  apiToken: process.env.SHIPFLOW_API_TOKEN || "",

  // Name of this ShipFlow installation (scopes sandbox labels, heartbeats).
  instance: process.env.SHIPFLOW_INSTANCE || "shipflow",

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
  // Docker network for sandboxes. Use an `internal` network plus
  // SHIPFLOW_EGRESS_PROXY so dependency installs can only reach the
  // registry allowlist; the default bridge network is unrestricted.
  sandboxNetwork: process.env.SHIPFLOW_SANDBOX_NETWORK || "bridge",
  egressProxy: process.env.SHIPFLOW_EGRESS_PROXY || "",
  sandboxMemory: process.env.SHIPFLOW_SANDBOX_MEMORY || "1g",
  sandboxCpus: process.env.SHIPFLOW_SANDBOX_CPUS || "1",
  sandboxPidsLimit: intFromEnv("SHIPFLOW_SANDBOX_PIDS", 512),

  cloneTimeoutMs: intFromEnv("SHIPFLOW_CLONE_TIMEOUT_MS", 120_000),
  installTimeoutMs: intFromEnv("SHIPFLOW_INSTALL_TIMEOUT_MS", 600_000),
  buildTimeoutMs: intFromEnv("SHIPFLOW_BUILD_TIMEOUT_MS", 600_000),
  testTimeoutMs: intFromEnv("SHIPFLOW_TEST_TIMEOUT_MS", 300_000),

  // Container image builds (node and dockerfile strategies). OFF by default:
  // `docker build` runs repository-controlled Dockerfile RUN steps through the
  // host Docker daemon, and BuildKit cannot attach to the sandbox's restricted
  // network, so this is weaker isolation than the build sandbox. Enable only
  // for repositories you trust.
  imageBuilds: process.env.SHIPFLOW_IMAGE_BUILDS === "enabled",
  imageBuildTimeoutMs: intFromEnv("SHIPFLOW_IMAGE_BUILD_TIMEOUT_MS", 900_000),
  maxImageBytes: intFromEnv("SHIPFLOW_MAX_IMAGE_BYTES", 1024 * 1024 * 1024),

  // Cost and disk controls.
  keepReleases: intOrZero("SHIPFLOW_KEEP_RELEASES", 10),
  logRetentionDays: intOrZero("SHIPFLOW_LOG_RETENTION_DAYS", 90),
  minFreeDiskMb: intOrZero("SHIPFLOW_MIN_FREE_DISK_MB", 1024),

  // 32-byte key (64 hex chars) that encrypts project secrets at rest.
  secretsKey: process.env.SHIPFLOW_SECRETS_KEY || "",

  // GitHub webhook shared secret; webhooks are disabled when empty.
  githubWebhookSecret: process.env.SHIPFLOW_GITHUB_WEBHOOK_SECRET || "",

  // Optional: serve this project at the site server's root for unknown hosts.
  siteDefaultProject: process.env.SHIPFLOW_SITE_DEFAULT_PROJECT || "",

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

  // Where artifacts are stored: "s3" (needs S3_BUCKET_NAME) or "local"
  // (a directory on this host). Defaults to s3 when a bucket is configured.
  artifactStore:
    process.env.SHIPFLOW_ARTIFACT_STORE ||
    (process.env.S3_BUCKET_NAME ? "s3" : "local"),
  artifactDir:
    process.env.SHIPFLOW_ARTIFACT_DIR || path.join(process.cwd(), "artifacts"),

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

export type Config = typeof config;
