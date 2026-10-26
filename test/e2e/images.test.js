// End-to-end: the container image pipeline against a real Docker daemon.
// Node API (no Dockerfile) -> generated Dockerfile -> image build on the worker
// -> "docker" target on a separate Docker host (the "dockerhost" service:
// Docker-in-Docker + sshd) -> candidate check -> switch -> live check -> second
// release -> rollback -> failure cases. No cloud, no mocked docker/ssh.
// Runs after targets.test.js; tests share state in order. Needs internet:
// base images (node:22-alpine) and the proxy image (nginx:1.27-alpine) are
// pulled from Docker Hub on first use.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { fileURLToPath } from "url";

const API = process.env.SHIPFLOW_API_URL;
const TOKEN = process.env.SHIPFLOW_API_TOKEN;
const CLI = fileURLToPath(new URL("../../cli/dist/index.js", import.meta.url));
const HOST_KEY = fs.readFileSync("/dhkeys/host_key.pub", "utf8").trim();
const TIMEOUT = { timeout: 10 * 60 * 1000 };
const repo = (fixture) => `http://fixtures:9000/shipflow/${fixture}.git`;
const BASE = "http://dockerhost:8090";
const SECRET_VALUE = "s3cr3t-value-for-e2e-9f8e7d6c";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "images-e2e-"));
const sshKey = path.join(work, "id");
const knownHosts = path.join(work, "known_hosts");
fs.copyFileSync("/dhkeys/deploy_key", sshKey);
fs.chmodSync(sshKey, 0o600);
fs.writeFileSync(knownHosts, `dockerhost ${HOST_KEY}\n`);

function run(file, args, { cwd } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, env: { ...process.env }, timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) =>
      resolve({ code: error ? error.code : 0, stdout, stderr, all: stdout + stderr })
    );
  });
}

const cli = (args, options) => run(process.execPath, [CLI, ...args], options);

/** Run a command line on the Docker host, over ssh as the deploy user. */
const onHost = (command) =>
  run("ssh", [
    "-i", sshKey,
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${knownHosts}`,
    "-o", "LogLevel=ERROR",
    "deploy@dockerhost",
    command,
  ]);

async function api(pathname) {
  const response = await fetch(`${API}${pathname}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return { status: response.status, body: await response.json() };
}

async function body(pathname = "/") {
  const response = await fetch(`${BASE}${pathname}`, { signal: AbortSignal.timeout(10_000) });
  return { status: response.status, text: await response.text() };
}

function writeConfig(dir, { name, repository, secrets = true }) {
  const lines = [
    "version: 1",
    "project:",
    `  name: ${name}`,
    `  repository: ${repository}`,
    "deployment:",
    "  target: docker",
    "  docker:",
    "    host: dockerhost",
    "    user: deploy",
    `    hostKey: ${HOST_KEY}`,
    "    publishPort: 8090",
    `    url: ${BASE}/`,
    "runtime:",
    "  port: 3000",
    "  env:",
    "    GREETING: hello-from-env",
  ];

  if (secrets) lines.push("  secrets:", "    - API_TOKEN");

  fs.writeFileSync(path.join(dir, "shipflow.yml"), `${lines.join("\n")}\n`);
}

const releaseIdOf = (output) => output.match(/^Release: (\w{8})$/m)?.[1];
const logsOf = async (releaseId) => (await api(`/releases/${releaseId}/logs`)).body.logs;
const messagesOf = (logs) => logs.map((l) => l.message).join("\n");

/** Names of the release containers of the project on the host: { name, running }. */
async function containers(project) {
  const result = await onHost(
    `docker ps -a --filter label=shipflow.project=${project} --filter label=shipflow.role=release --format '{{.Names}}|{{.State}}'`
  );
  assert.equal(result.code, 0, result.all);
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, state] = line.split("|");
      return { name, running: state === "running" };
    });
}

const dir = path.join(work, "api-demo");
fs.mkdirSync(dir);
const ids = {};

test("setup: secrets are stored, doctor reaches the real Docker host", TIMEOUT, async () => {
  writeConfig(dir, { name: "api-demo", repository: repo("api-v1") });

  const key = await cli(["secrets", "set", "SSH_PRIVATE_KEY", "--from-file", "/dhkeys/deploy_key"], { cwd: dir });
  assert.equal(key.code, 0, key.all);

  const secretFile = path.join(work, "api-token");
  fs.writeFileSync(secretFile, SECRET_VALUE);
  const token = await cli(["secrets", "set", "API_TOKEN", "--from-file", secretFile], { cwd: dir });
  assert.equal(token.code, 0, token.all);
  assert.doesNotMatch(token.all, new RegExp(SECRET_VALUE));

  const doctor = await cli(["doctor", "--json"], { cwd: dir });
  const report = JSON.parse(doctor.stdout);
  const check = (name) => report.checks.find((c) => c.name === name);

  assert.equal(check("target: ssh connection")?.ok, true, doctor.stdout);
  assert.equal(check("target: docker daemon")?.ok, true, doctor.stdout);
  assert.equal(check("target: docker permission")?.ok, true, doctor.stdout);
});

test("node API without a Dockerfile: image built, loaded on the Docker host, served through the proxy", TIMEOUT, async () => {
  const deploy = await cli(["deploy"], { cwd: dir });
  ids.v1 = releaseIdOf(deploy.stdout);

  assert.equal(deploy.code, 0, deploy.all);

  const { release } = (await api(`/releases/${ids.v1}`)).body;
  assert.equal(release.status, "SUCCESS");
  assert.equal(release.build_strategy, "node");
  assert.equal(release.artifact_type, "image");
  assert.match(release.artifact.digest, /^sha256:[a-f0-9]{64}$/);
  ids.v1Digest = release.artifact.digest;

  const page = await body("/");
  assert.equal(page.status, 200);
  assert.equal(page.text, "api v1");
  assert.equal((await body("/greeting")).text, "hello-from-env");
  assert.equal((await body("/has-secret")).text, "yes");

  const logs = messagesOf(await logsOf(ids.v1));
  assert.match(logs, /Generated Dockerfile/);
  assert.match(logs, /Candidate verified/);
  assert.doesNotMatch(logs, new RegExp(SECRET_VALUE));

  const state = await containers("api-demo");
  assert.deepEqual(state.map((c) => c.running), [true]);
  assert.equal(state[0].name, `shipflow-api-demo-${ids.v1}`);
});

test("secret values are not on the container command line, in docker inspect or in logs", TIMEOUT, async () => {
  const inspect = await onHost(`docker inspect shipflow-api-demo-${ids.v1}`);
  assert.equal(inspect.code, 0, inspect.all);
  const [info] = JSON.parse(inspect.stdout);

  // Delivered through an env file: the variable exists in the container
  // environment (expected), the command line and host files do not carry it.
  assert.deepEqual(info.Config.Cmd.join(" ").includes(SECRET_VALUE), false);
  assert.equal(info.Image, ids.v1Digest);
  assert.deepEqual(info.HostConfig.CapDrop, ["ALL"]);

  const processes = await onHost("ps -eo args");
  assert.doesNotMatch(processes.stdout, new RegExp(SECRET_VALUE));

  const leftovers = await onHost("ls -A ~/.shipflow/api-demo/private");
  assert.equal(leftovers.stdout.trim(), "", "env files are removed after docker run");

  for (const id of [ids.v1]) {
    assert.doesNotMatch(messagesOf(await logsOf(id)), new RegExp(SECRET_VALUE));
  }
});

test("v2 replaces v1 and the previous container is stopped", TIMEOUT, async () => {
  writeConfig(dir, { name: "api-demo", repository: repo("api-v2") });
  const deploy = await cli(["deploy"], { cwd: dir });
  ids.v2 = releaseIdOf(deploy.stdout);

  assert.equal(deploy.code, 0, deploy.all);
  assert.equal((await body("/")).text, "api v2");

  const state = await containers("api-demo");
  const byName = Object.fromEntries(state.map((c) => [c.name, c.running]));

  assert.equal(byName[`shipflow-api-demo-${ids.v2}`], true);
  assert.equal(byName[`shipflow-api-demo-${ids.v1}`], false, "v1 is kept but stopped");
});

test("rollback restores v1 from the stored image without rebuilding", TIMEOUT, async () => {
  const before = (await logsOf(ids.v1)).filter((l) => l.stage === "BUILD").length;
  assert.ok(before > 0, "v1 has BUILD logs from its own build");

  const rollback = await cli(["rollback", ids.v1]);
  assert.equal(rollback.code, 0, rollback.all);
  assert.match(rollback.stdout, new RegExp(`${ids.v2} → ${ids.v1}`));

  assert.equal((await body("/")).text, "api v1");

  const logs = await logsOf(ids.v1);
  assert.equal(logs.filter((l) => l.stage === "BUILD").length, before, "no new BUILD logs");
  assert.ok(logs.some((l) => l.stage === "ROLLBACK"), "rollback is logged under the release");
  assert.doesNotMatch(messagesOf(logs), new RegExp(SECRET_VALUE));

  const state = Object.fromEntries((await containers("api-demo")).map((c) => [c.name, c.running]));
  assert.equal(state[`shipflow-api-demo-${ids.v1}`], true);
  assert.equal(state[`shipflow-api-demo-${ids.v2}`], false);

  // Roll forward again (image still present on the host: reused, not reloaded).
  const forward = await cli(["rollback", ids.v2]);
  assert.equal(forward.code, 0, forward.all);
  assert.equal((await body("/")).text, "api v2");
  assert.match(messagesOf(await logsOf(ids.v2)), /reused image/);
});

test("a crashing release fails before activation; the live release keeps serving and no candidate lingers", TIMEOUT, async () => {
  writeConfig(dir, { name: "api-demo", repository: repo("api-crash") });
  const deploy = await cli(["deploy"], { cwd: dir });

  assert.equal(deploy.code, 1, deploy.all);
  assert.match(deploy.stderr, /Stage: (VERIFY|DEPLOY|ACTIVATE)/);
  ids.crash = releaseIdOf(deploy.stdout);

  const { release } = (await api(`/releases/${ids.crash}`)).body;
  assert.equal(release.status, "FAILED");
  assert.equal((await body("/")).text, "api v2", "previous release still live");

  const names = (await containers("api-demo")).map((c) => c.name);
  assert.ok(!names.includes(`shipflow-api-demo-${ids.crash}`), `candidate removed, have ${names.join(", ")}`);

  const logs = messagesOf(await logsOf(ids.crash));
  assert.doesNotMatch(logs, new RegExp(SECRET_VALUE));

  const project = (await api("/projects/api-demo")).body;
  assert.equal(project.activeReleaseId, ids.v2);
});

test("a missing runtime secret is refused before anything is built or started", TIMEOUT, async () => {
  const missing = path.join(work, "no-secret");
  fs.mkdirSync(missing);
  writeConfig(missing, { name: "api-demo", repository: repo("api-v1") });
  fs.writeFileSync(path.join(missing, "shipflow.yml"), fs.readFileSync(path.join(missing, "shipflow.yml"), "utf8").replace("API_TOKEN", "NOT_SET_ANYWHERE"));

  const deploy = await cli(["deploy"], { cwd: missing });
  assert.equal(deploy.code, 2, deploy.all);
  assert.match(deploy.stderr, /Missing secret\(s\) on the server: NOT_SET_ANYWHERE/);
  assert.equal((await body("/")).text, "api v2");
});

test("dockerfile strategy: the repository's own Dockerfile deploys too", TIMEOUT, async () => {
  const other = path.join(work, "dockerfile-app");
  fs.mkdirSync(other);
  writeConfig(other, { name: "dockerfile-app", repository: repo("api-dockerfile"), secrets: false });
  // A second project on the same host needs its own proxy port.
  fs.writeFileSync(
    path.join(other, "shipflow.yml"),
    fs.readFileSync(path.join(other, "shipflow.yml"), "utf8").replace("publishPort: 8090", "publishPort: 8091").replace(`${BASE}/`, "http://dockerhost:8091/")
  );
  assert.equal((await cli(["secrets", "set", "SSH_PRIVATE_KEY", "--from-file", "/dhkeys/deploy_key"], { cwd: other })).code, 0);

  const deploy = await cli(["deploy"], { cwd: other });
  const releaseId = releaseIdOf(deploy.stdout);

  assert.equal(deploy.code, 0, deploy.all);

  const { release } = (await api(`/releases/${releaseId}`)).body;
  assert.equal(release.build_strategy, "dockerfile");
  assert.equal(release.artifact_type, "image");
  assert.match(release.artifact.digest, /^sha256:[a-f0-9]{64}$/);

  const response = await fetch("http://dockerhost:8091/", { signal: AbortSignal.timeout(10_000) });
  assert.equal(await response.text(), "api dockerfile");

  // The first project is unaffected.
  assert.equal((await body("/")).text, "api v2");
});
