// End-to-end scenarios against a running ShipFlow stack (see run.sh).
// Tests run in order and share state: later ones depend on earlier releases.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "child_process";
import { fileURLToPath } from "url";

const API = process.env.SHIPFLOW_API_URL;
const SITE = process.env.SHIPFLOW_SITE_URL;
const TOKEN = process.env.SHIPFLOW_API_TOKEN;
const CLI = fileURLToPath(new URL("../../cli/dist/index.js", import.meta.url));

const repo = (fixture) => `http://fixtures:9000/shipflow/${fixture}.git`;
const PIPELINE_TIMEOUT = { timeout: 5 * 60 * 1000 };

function cli(...args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env }, timeout: 10 * 60 * 1000 },
      (error, stdout, stderr) =>
        resolve({ code: error ? error.code : 0, stdout, stderr, all: stdout + stderr })
    );
  });
}

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${TOKEN}`, ...options.headers },
  });
  return { status: response.status, body: await response.json() };
}

async function site(path = "/") {
  const response = await fetch(`${SITE}${path}`);
  return {
    status: response.status,
    contentType: response.headers.get("content-type") || "",
    release: response.headers.get("x-shipflow-release"),
    text: await response.text(),
  };
}

async function deploy(fixture) {
  const result = await cli("deploy", repo(fixture));
  const releaseId = result.stdout.match(/^Release: (\w{8})$/m)?.[1];

  assert.ok(releaseId, `no release id in output:\n${result.all}`);

  const { body } = await api(`/releases/${releaseId}`);
  return { ...result, releaseId, release: body.release };
}

async function logsOf(releaseId) {
  return (await api(`/releases/${releaseId}/logs`)).body;
}

const ids = {};

test("probe: repository code sees no secrets, worker files or internal services", PIPELINE_TIMEOUT, async () => {
  const result = await deploy("probe");

  // check.js inside the probe fails the TEST stage if anything leaked.
  assert.equal(result.code, 0, result.all);
  assert.equal(result.release.test_status, "PASSED");

  const preview = await fetch(`${API}/preview/${result.releaseId}/probe.json`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const [install, build] = await preview.json();

  for (const phase of [install, build]) {
    assert.equal(phase.uid, 1000, "runs as non-root");
    assert.deepEqual(phase.leakedEnv, []);
    assert.deepEqual(phase.readablePaths, []);
    assert.deepEqual(phase.reachableInternal, []);
    assert.deepEqual(phase.reachableGateway, [], `host gateway ports (${phase.gateway})`);
    assert.equal(phase.metadataDirect, false, "cloud metadata IP");
    assert.equal(phase.internetDirect, false, "no direct internet");
  }

  // During install the only way out is the egress proxy, which allows the
  // registry over 443 and refuses everything else.
  assert.match(install.proxyResults["registry.npmjs.org:443"], / 200 /);
  for (const target of ["169.254.169.254:80", "api:8000", "postgres:5432", "example.com:443", "registry.npmjs.org:80"]) {
    assert.match(install.proxyResults[target], / 403 /, target);
  }

  // After install the sandbox has no network at all, proxy included.
  assert.doesNotMatch(build.proxyResults["registry.npmjs.org:443"], / 200 /, "build has no network");
});

test("npm site: queued, built, tested, uploaded and served", PIPELINE_TIMEOUT, async () => {
  const result = await deploy("site-v1");
  ids.v1 = result.releaseId;

  assert.equal(result.code, 0, result.all);
  assert.match(result.stdout, /✅ Deployment successful/);
  assert.equal(result.release.status, "SUCCESS");
  assert.equal(result.release.current_stage, "ACTIVATE");
  assert.equal(result.release.test_status, "PASSED");
  assert.match(result.release.commit_sha, /^[0-9a-f]{40}$/);
  assert.equal(result.release.artifact_path, `releases/${ids.v1}/build`);
  assert.equal(result.release.is_active, true);

  // Every stage ran, in order, and was recorded in PostgreSQL. (The CLI polls
  // every 2s, so a fast release may not print every transition.)
  const { logs } = await logsOf(ids.v1);
  const stages = [...new Set(logs.map((log) => log.stage))];
  assert.deepEqual(stages, ["PREPARE", "BUILD", "TEST", "DEPLOY", "VERIFY", "ACTIVATE"]);
  assert.ok(logs.some((log) => log.message.includes("reproducible install")));
  assert.ok(logs.some((log) => log.message.includes("fixture tests passed")));

  const index = await site("/");
  assert.equal(index.status, 200);
  assert.match(index.contentType, /^text\/html/);
  assert.equal(index.release, ids.v1);
  assert.match(index.text, /ShipFlow fixture v1/);

  const script = await site("/assets/app.js");
  assert.equal(script.status, 200);
  assert.match(script.contentType, /javascript/);

  const style = await site("/assets/style.css");
  assert.match(style.contentType, /^text\/css/);
});

test("pnpm project builds with a frozen lockfile", PIPELINE_TIMEOUT, async () => {
  const result = await deploy("site-pnpm");

  assert.equal(result.code, 0, result.all);
  const { logs } = await logsOf(result.releaseId);
  assert.ok(logs.some((log) => log.message.startsWith("Package manager: pnpm (lockfile found")));
  assert.match((await site("/")).text, /ShipFlow fixture pnpm/);
});

test("yarn project builds with a frozen lockfile", PIPELINE_TIMEOUT, async () => {
  const result = await deploy("site-yarn");

  assert.equal(result.code, 0, result.all);
  const { logs } = await logsOf(result.releaseId);
  assert.ok(logs.some((log) => log.message.startsWith("Package manager: yarn (lockfile found")));
  assert.match((await site("/")).text, /ShipFlow fixture yarn/);
});

test("project without tests deploys with tests SKIPPED, not PASSED", PIPELINE_TIMEOUT, async () => {
  const result = await deploy("no-tests");

  assert.equal(result.code, 0, result.all);
  assert.equal(result.release.test_status, "SKIPPED");

  const { logs } = await logsOf(result.releaseId);
  assert.ok(logs.some((log) => log.level === "WARN" && log.message.includes("Tests SKIPPED")));
});

test("site v2 replaces the live site", PIPELINE_TIMEOUT, async () => {
  const result = await deploy("site-v2");
  ids.v2 = result.releaseId;

  assert.equal(result.code, 0, result.all);

  const index = await site("/");
  assert.equal(index.release, ids.v2);
  assert.match(index.text, /ShipFlow fixture v2/);
});

test("build failure is reported and the live site is unchanged", PIPELINE_TIMEOUT, async () => {
  const result = await deploy("build-fail");
  ids.buildFail = result.releaseId;

  assert.equal(result.code, 1);
  assert.match(result.stderr, /❌ Deployment failed/);
  assert.match(result.stderr, /Stage: BUILD/);
  assert.equal(result.release.status, "FAILED");
  assert.match(result.release.error_message, /Build failed with exit code 1/);

  const { logs, notifications } = await logsOf(ids.buildFail);
  assert.ok(logs.some((log) => log.level === "ERROR" && log.message.includes("SF_BUILD_FAIL_MARKER")));
  assert.equal(notifications.at(-1).type, "RELEASE_FAILED");

  const index = await site("/");
  assert.equal(index.release, ids.v2);
});

test("test failure is reported and the live site is unchanged", PIPELINE_TIMEOUT, async () => {
  const result = await deploy("test-fail");

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Stage: TEST/);
  assert.match(result.release.error_message, /Tests failed with exit code 1/);

  const { logs } = await logsOf(result.releaseId);
  assert.ok(logs.some((log) => log.message.includes("SF_TEST_FAIL_MARKER")));

  assert.equal((await site("/")).release, ids.v2);
});

test("broken artifact fails before activation and the live site is unchanged", PIPELINE_TIMEOUT, async () => {
  const result = await deploy("missing-asset");

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Stage: DEPLOY/);
  assert.match(result.release.error_message, /assets\/missing.js/);
  assert.equal((await site("/")).release, ids.v2);
});

test("logs and notifications are available through the CLI", async () => {
  const success = await cli("logs", ids.v2);
  assert.equal(success.code, 0, success.all);
  assert.match(success.stdout, /\[ACTIVATE\] \[INFO\] Live site serves/);
  assert.match(success.stdout, /RELEASE_SUCCESS/);

  const failure = await cli("logs", ids.buildFail);
  assert.match(failure.stdout, /SF_BUILD_FAIL_MARKER/);
  assert.match(failure.stdout, /RELEASE_FAILED/);

  const status = await cli("status", ids.v2);
  assert.match(status.stdout, /Status:\s+SUCCESS/);
  assert.match(status.stdout, /\(ACTIVE\)/);
});

test("rollback restores the earlier version on the live site", async () => {
  const result = await cli("rollback", ids.v1);

  assert.equal(result.code, 0, result.all);
  assert.match(result.stdout, new RegExp(`${ids.v2} → ${ids.v1}`));

  const index = await site("/");
  assert.equal(index.release, ids.v1);
  assert.match(index.text, /ShipFlow fixture v1/);

  const releases = await cli("releases");
  assert.match(releases.stdout, new RegExp(`${ids.v1}.*← active`));

  const { logs, notifications } = await logsOf(ids.v1);
  assert.ok(logs.some((log) => log.stage === "ROLLBACK"));
  assert.equal(notifications.at(-1).type, "ROLLBACK_SUCCESS");
});

test("rollback rejects failed, unknown, and already-active targets", async () => {
  const failed = await cli("rollback", ids.buildFail);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /cannot be a rollback target/);

  const unknown = await cli("rollback", "Zzzzzzz9");
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /not found \(HTTP 404\)/);

  const active = await cli("rollback", ids.v1);
  assert.equal(active.code, 1);
  assert.match(active.stderr, /already active \(HTTP 409\)/);

  assert.equal((await site("/")).release, ids.v1);
});

test("API enforces auth, repository allowlist and ID validation", async () => {
  assert.equal((await fetch(`${API}/releases`)).status, 401);

  const disallowed = await api("/deploy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoUrl: "https://github.com/random/repo" }),
  });
  assert.equal(disallowed.status, 400);

  assert.equal((await api("/releases/not-valid!")).status, 400);
  assert.equal((await api("/releases/Zzzzzzz9")).status, 404);
  assert.equal((await api("/releases/Zzzzzzz9/logs")).status, 404);
});
