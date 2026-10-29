// Shared setup for RepoPilot integration tests. These talk to a REAL
// PostgreSQL and Redis and are skipped (reported as skipped, never passed)
// unless both are configured:
//
//   REPOPILOT_TEST_PG=postgres://user:pass@127.0.0.1:55432/shipflow_test
//   REPOPILOT_TEST_REDIS=127.0.0.1:56379
//
// The database name must end in "test": the suite truncates every rp_* table.
import fs from "node:fs";
import pg from "pg";

export const PG_URL = process.env.REPOPILOT_TEST_PG || "";
export const REDIS_ADDR = process.env.REPOPILOT_TEST_REDIS || "";

export const skipPg = PG_URL ? false : "REPOPILOT_TEST_PG is not set (real PostgreSQL required)";
export const skipRedis = PG_URL && REDIS_ADDR ? false : "REPOPILOT_TEST_PG / REPOPILOT_TEST_REDIS not set (real PostgreSQL and Redis required)";

export async function openDatabase() {
  const name = new URL(PG_URL).pathname.replace(/^\//, "");

  if (!/test$/.test(name)) {
    throw new Error(`Refusing to run: database "${name}" does not end in "test"`);
  }

  const pool = new pg.Pool({ connectionString: PG_URL, max: 10 });
  const schema = fs.readFileSync(new URL("../../db/schema.sql", import.meta.url), "utf8");

  await pool.query(schema);

  return pool;
}

export async function resetDatabase(pool) {
  // TRUNCATE needs exclusive locks; a heartbeat query still draining from the
  // previous test can deadlock with it, so retry (test harness only).
  for (let attempt = 1; ; attempt += 1) {
    try {
      await pool.query(
        "TRUNCATE rp_audit_events, rp_logs, rp_artifacts, rp_pull_requests, rp_outcomes, rp_verifications, rp_patches, rp_findings, rp_stages, rp_runs, rp_repositories, rp_credentials RESTART IDENTITY CASCADE"
      );
      return;
    } catch (error) {
      if (error.code !== "40P01" || attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

export const REPO = { owner: "acme", name: "widgets", url: "https://github.com/acme/widgets" };
export const SHA = "a".repeat(40);

export const finding = (overrides = {}) => ({
  title: "Unchecked JSON.parse",
  category: "error-handling",
  severity: "medium",
  evidenceKind: "observed",
  impact: "Crash on malformed input.",
  remediation: "Catch and report.",
  file: "src/config.js",
  lineStart: 10,
  lineEnd: 12,
  evidence: "JSON.parse(input) can throw.",
  confidence: 0.7,
  ...overrides,
});

export const modifyDiff = (path = "src/config.js") =>
  [`diff --git a/${path} b/${path}`, "index 1111111..2222222 100644", `--- a/${path}`, `+++ b/${path}`, "@@ -1,3 +1,3 @@", " const a = 1;", "-const b = 2;", "+const b = 3;", " const c = 4;", ""].join("\n");

export const addTestDiff = (path = "test/config.test.js") =>
  [`diff --git a/${path} b/${path}`, "new file mode 100644", "index 0000000..3333333", "--- /dev/null", `+++ b/${path}`, "@@ -0,0 +1,2 @@", "+import test from 'node:test';", "+test('x', () => {});", ""].join("\n");

export const proposal = (overrides = {}) => ({
  title: "Guard JSON.parse",
  explanation: "Wrap the parse call.",
  diff: modifyDiff(),
  testDiff: addTestDiff(),
  ...overrides,
});

/** Records enqueued jobs instead of using Redis. */
export function fakeQueue() {
  const jobs = [];
  const enqueue = async (job, options = {}) => {
    jobs.push({ job, delayMs: options.delayMs ?? 0 });
  };

  return { jobs, enqueue };
}

/** Minimal dependencies for createApiApp; RepoPilot routes use none of them. */
export function apiShell(token) {
  const never = async () => { throw new Error("not used by RepoPilot tests"); };

  return {
    config: { apiToken: token, instance: "test", allowedRepoPrefixes: ["https://github.com/"], maxQueuedReleases: 5 },
    releases: { createRelease: never, getRelease: never, getAllReleases: async () => [], updateRelease: never, requestCancel: never, transitionRelease: never },
    logs: { getReleaseLogs: async () => [] },
    notifications: { getReleaseNotifications: async () => [] },
    queue: { getJobCounts: async () => ({}), add: never, getJob: async () => undefined },
    activation: { getActiveReleaseId: async () => null },
    rollback: { rollbackRelease: never },
    storage: { getObject: never, isNotFoundError: () => false, describe: () => "test" },
    secrets: { enabled: false },
    healthCheck: async () => true,
    readiness: async () => [],
    generateId: () => "TestId01",
    validateProjectConfig: (x) => x,
    requiredSecrets: () => [],
    checkTarget: async () => [],
  };
}
