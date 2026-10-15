// Runs the real build and test stages against fixture projects using the
// unisolated "none" sandbox (no Docker needed). Checks environment
// filtering, failure reporting and test classification.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";

import { materializeFixture } from "../fixtures/repos.js";

process.env.SHIPFLOW_SANDBOX = "none";
process.env.AWS_SECRET_ACCESS_KEY = "unit-test-aws-secret";
process.env.DB_PASSWORD = "unit-test-db-password";
process.env.SHIPFLOW_API_TOKEN = "unit-test-api-token";

const { createSandbox } = await import("../../src/sandbox.js");
const { buildRelease } = await import("../../src/build.js");
const { testRelease } = await import("../../src/test.js");
const { createBuildEnvironment } = await import("../../src/buildEnv.js");

let root;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sf-local-"));
});

async function setup(fixture) {
  const workspacePath = await materializeFixture(fixture, path.join(root, fixture));
  const sandbox = await createSandbox({ releaseId: "Unit0001", workspacePath });
  return { workspacePath, sandbox };
}

test("build environment contains no worker secrets", async () => {
  const env = await createBuildEnvironment("Unit0001");

  for (const key of Object.keys(env)) {
    assert.doesNotMatch(key, /AWS|DB_|SHIPFLOW|REDIS|S3_/);
  }

  assert.equal(env.CI, "true");
  assert.ok(env.PATH);
});

test("npm project installs, builds and passes tests", async () => {
  const { workspacePath, sandbox } = await setup("site-v1");
  const logs = [];

  const built = await buildRelease({
    releaseId: "Unit0001",
    workspacePath,
    sandbox,
    log: async (m) => logs.push(m),
  });

  assert.equal(built.packageManager.name, "npm");
  assert.ok(logs.some((m) => m.includes("reproducible install")));
  assert.ok(logs.some((m) => m.includes("built v1")));

  const tested = await testRelease({
    releaseId: "Unit0001",
    workspacePath,
    sandbox,
    packageJson: built.packageJson,
    packageManager: built.packageManager,
  });

  assert.equal(tested.testStatus, "PASSED");

  const out = path.join(root, "site-v1-out");
  assert.equal(await sandbox.copyOut("dist", out), true);
  assert.match(await fs.readFile(path.join(out, "index.html"), "utf8"), /fixture v1/);

  await sandbox.destroy();
});

test("probe sees no secrets in the build environment", async () => {
  const { workspacePath, sandbox } = await setup("probe");
  await buildRelease({ releaseId: "Unit0001", workspacePath, sandbox });

  for (const phase of ["install", "build"]) {
    const probe = JSON.parse(
      await fs.readFile(path.join(workspacePath, `.probe-${phase}.json`), "utf8")
    );
    assert.deepEqual(probe.leakedEnv, [], phase);
  }

  await sandbox.destroy();
});

test("build failure keeps the build output", async () => {
  const { workspacePath, sandbox } = await setup("build-fail");

  await assert.rejects(
    buildRelease({ releaseId: "Unit0001", workspacePath, sandbox }),
    (error) => {
      assert.match(error.message, /Build failed with exit code 1/);
      assert.match(error.result.output, /SF_BUILD_FAIL_MARKER/);
      return true;
    }
  );

  await sandbox.destroy();
});

test("missing build script fails clearly", async () => {
  const { workspacePath, sandbox } = await setup("no-build");

  await assert.rejects(
    buildRelease({ releaseId: "Unit0001", workspacePath, sandbox }),
    /No "build" script/
  );

  await sandbox.destroy();
});

test("test failure keeps the test output", async () => {
  const { workspacePath, sandbox } = await setup("test-fail");
  const built = await buildRelease({ releaseId: "Unit0001", workspacePath, sandbox });

  await assert.rejects(
    testRelease({
      releaseId: "Unit0001",
      workspacePath,
      sandbox,
      packageJson: built.packageJson,
      packageManager: built.packageManager,
    }),
    (error) => {
      assert.match(error.message, /Tests failed with exit code 1/);
      assert.match(error.result.output, /SF_TEST_FAIL_MARKER/);
      return true;
    }
  );

  await sandbox.destroy();
});

test("missing test script is reported as SKIPPED, not PASSED", async () => {
  const { workspacePath, sandbox } = await setup("no-tests");
  const built = await buildRelease({ releaseId: "Unit0001", workspacePath, sandbox });
  const logs = [];

  const tested = await testRelease({
    releaseId: "Unit0001",
    workspacePath,
    sandbox,
    packageJson: built.packageJson,
    packageManager: built.packageManager,
    log: async (message, level) => logs.push([level, message]),
  });

  assert.equal(tested.testStatus, "SKIPPED");
  assert.deepEqual(logs[0][0], "WARN");

  await sandbox.destroy();
});
