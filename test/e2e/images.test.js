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

// ---------------------------------------------------------------------------
// Docker-target reliability (revert after a failed live check, per-request DNS
// in the proxy, redaction that cannot corrupt parsed output). Real Docker, real
// nginx, real ssh; nothing mocked.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `check` returns a truthy value; returns it, or throws with the last observation. */
async function eventually(check, { timeoutMs = 45_000, intervalMs = 1500, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;

  for (;;) {
    try {
      last = await check();
      if (last) return last;
    } catch (error) {
      last = error;
    }

    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}; last: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
    await sleep(intervalMs);
  }
}

/** A project directory with its own proxy port; the SSH key secret is stored for it. */
async function projectDir(name, { port, secrets = false }) {
  const projectDirectory = path.join(work, name);
  fs.mkdirSync(projectDirectory, { recursive: true });
  writeConfig(projectDirectory, { name, repository: repo("api-v1"), secrets });

  const config = path.join(projectDirectory, "shipflow.yml");
  fs.writeFileSync(
    config,
    fs.readFileSync(config, "utf8").replace("publishPort: 8090", `publishPort: ${port}`).replace(`${BASE}/`, `http://dockerhost:${port}/`)
  );
  assert.equal((await cli(["secrets", "set", "SSH_PRIVATE_KEY", "--from-file", "/dhkeys/deploy_key"], { cwd: projectDirectory })).code, 0);

  return {
    dir: projectDirectory,
    base: `http://dockerhost:${port}`,
    repoFor(fixture) {
      fs.writeFileSync(config, fs.readFileSync(config, "utf8").replace(/repository: .*/, `repository: ${repo(fixture)}`));
    },
  };
}

const fetchText = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  return { status: response.status, text: await response.text(), headers: response.headers };
};

test("failed live check: the previous release is restored and serves again (it was left running during the check)", TIMEOUT, async () => {
  writeConfig(dir, { name: "api-demo", repository: repo("api-livefail") });
  const deploy = await cli(["deploy"], { cwd: dir });
  ids.liveFail1 = releaseIdOf(deploy.stdout);

  assert.equal(deploy.code, 1, deploy.all);

  const { release } = (await api(`/releases/${ids.liveFail1}`)).body;
  assert.equal(release.status, "FAILED");
  assert.match(release.error_message, /Live check failed after activation/);
  assert.match(release.error_message, new RegExp(`restored previous release ${ids.v2}; its live check passed`));

  assert.equal((await body("/")).text, "api v2", "the original release serves traffic again");
  assert.equal((await api("/projects/api-demo")).body.activeReleaseId, ids.v2);

  const state = Object.fromEntries((await containers("api-demo")).map((c) => [c.name, c.running]));
  assert.equal(state[`shipflow-api-demo-${ids.v2}`], true);
  assert.equal(state[`shipflow-api-demo-${ids.liveFail1}`] ?? false, false, "the failed release does not keep running");
  assert.doesNotMatch(messagesOf(await logsOf(ids.liveFail1)), new RegExp(SECRET_VALUE));
});

test("failed live check while the previous container is stopped: it is restarted, health-checked, and serves again", TIMEOUT, async () => {
  const previous = `shipflow-api-demo-${ids.v2}`;
  assert.equal((await onHost(`docker stop ${previous}`)).code, 0);

  writeConfig(dir, { name: "api-demo", repository: repo("api-livefail") });
  const deploy = await cli(["deploy"], { cwd: dir });
  ids.liveFail2 = releaseIdOf(deploy.stdout);

  assert.equal(deploy.code, 1, deploy.all);

  const { release } = (await api(`/releases/${ids.liveFail2}`)).body;
  assert.match(release.error_message, new RegExp(`restored previous release ${ids.v2}; its live check passed`));

  const page = await eventually(async () => {
    const response = await body("/");
    return response.text === "api v2" ? response : null;
  }, { what: "the restored v2 to serve" });
  assert.equal(page.status, 200);

  const state = Object.fromEntries((await containers("api-demo")).map((c) => [c.name, c.running]));
  assert.equal(state[previous], true, "the stopped container was started again");
  assert.match(messagesOf(await logsOf(ids.liveFail2)), /Container .* is stopped; starting it and checking its health/);
  assert.equal((await api("/projects/api-demo")).body.activeReleaseId, ids.v2);
});

test("first deployment failing its live check is taken offline: clean 503, no container, no live release", TIMEOUT, async () => {
  const first = await projectDir("api-first", { port: 8092 });
  first.repoFor("api-livefail");

  const deploy = await cli(["deploy"], { cwd: first.dir });
  const releaseId = releaseIdOf(deploy.stdout);

  assert.equal(deploy.code, 1, deploy.all);

  const { release } = (await api(`/releases/${releaseId}`)).body;
  assert.match(release.error_message, /no earlier release existed, so \w{8} was taken offline/);

  const page = await fetchText(`${first.base}/`);
  assert.equal(page.status, 503);
  assert.match(page.text, /No active release/);
  assert.deepEqual(await containers("api-first"), [], "the failed candidate was removed");
  assert.equal((await api("/projects/api-first")).body.activeReleaseId ?? null, null);
});

test("proxy DNS: a live container restarted with a different IP is served again, and an absent upstream is a clean 503", TIMEOUT, async () => {
  const live = `shipflow-api-demo-${ids.v2}`;
  const network = "shipflow-api-demo";
  const ipOf = async (name) =>
    (await onHost(`docker inspect -f '{{(index .NetworkSettings.Networks "${network}").IPAddress}}' ${name}`)).stdout.trim();

  // The generated config is valid for the real nginx and uses the embedded resolver.
  const proxy = `${network}-proxy`;
  assert.equal((await onHost(`docker exec ${proxy} nginx -t`)).code, 0);
  const conf = (await onHost("cat ~/.shipflow/api-demo/conf/default.conf")).stdout;
  assert.match(conf, /resolver 127\.0\.0\.11 valid=5s/);
  assert.match(conf, /proxy_pass http:\/\/\$shipflow_upstream;/);
  assert.equal((await body("/")).text, "api v2");

  // The activation handshake: a per-config unguessable path answered by the running nginx.
  const token = /# shipflow-handshake: ([a-f0-9]{16})/.exec(conf)?.[1];
  assert.ok(token, "the generated config carries a handshake token");
  assert.equal((await onHost(`docker exec ${proxy} wget -q -O - http://127.0.0.1/__shipflow_${token}`)).stdout.trim(), ids.v2);
  assert.notEqual((await fetchText(`${BASE}/__shipflow_release`)).text, ids.v2, "no fixed path reveals the release");

  // Recreate the upstream with a different address: free the IP, let another
  // container take it, then start the release again.
  const oldIp = await ipOf(live);
  assert.match(oldIp, /^\d+\.\d+\.\d+\.\d+$/);
  assert.equal((await onHost(`docker stop ${live}`)).code, 0);

  const image = (await onHost(`docker inspect -f '{{.Config.Image}}' ${live}`)).stdout.trim();
  const squatters = [];

  try {
    for (let i = 0; i < 4; i += 1) {
      const name = `ip-squatter-${i}`;
      const started = await onHost(`docker run -d --name ${name} --network ${network} --entrypoint sleep ${image} 600`);
      assert.equal(started.code, 0, started.all);
      squatters.push(name);
      if ((await ipOf(name)) === oldIp) break;
    }

    // Absent upstream: nginx stays up and answers 503 with Retry-After.
    const absent = await eventually(async () => {
      const response = await fetchText(`${BASE}/`);
      return response.status === 503 ? response : null;
    }, { what: "a 503 while the upstream is stopped" });
    assert.match(absent.text, /Release temporarily unavailable/);
    assert.equal(absent.headers.get("retry-after"), "5");

    // ...and the proxy itself survives a restart with the upstream missing
    // (a name resolved only at start-up would make nginx refuse to start).
    assert.equal((await onHost(`docker restart ${proxy}`)).code, 0);
    const restarted = await eventually(async () => {
      const response = await fetchText(`${BASE}/`).catch(() => null);
      return response?.status === 503 ? response : null;
    }, { what: "the restarted proxy to answer 503" });
    assert.match(restarted.text, /Release temporarily unavailable/);
    const state = (await onHost(`docker inspect -f '{{.State.Running}}|{{.State.Restarting}}' ${proxy}`)).stdout.trim();
    assert.equal(state, "true|false", "the proxy is up, not crash-looping");

    // Start the release again: it gets a different IP than the one the proxy first knew.
    assert.equal((await onHost(`docker start ${live}`)).code, 0);
    const newIp = await ipOf(live);
    assert.notEqual(newIp, oldIp, "precondition: the recreated upstream has a new address");

    const served = await eventually(async () => {
      const response = await fetchText(`${BASE}/`).catch(() => null);
      return response?.status === 200 && response.text === "api v2" ? response : null;
    }, { timeoutMs: 60_000, what: "the proxy to follow the new IP" });
    assert.equal(served.text, "api v2");
  } finally {
    for (const name of squatters) await onHost(`docker rm -f ${name}`);
    await onHost(`docker start ${live}`);
  }
});

test("a runtime secret that is a substring of docker output cannot corrupt parsing (redaction is for reports only)", TIMEOUT, async () => {
  const redact = await projectDir("api-redact", { port: 8093, secrets: true });
  const secretFile = path.join(work, "redact-token");
  // Fragments of what the target parses: "true" (inspect), "sha256" (image IDs), "shipflow" (container names).
  fs.writeFileSync(secretFile, "true");
  assert.equal((await cli(["secrets", "set", "API_TOKEN", "--from-file", secretFile], { cwd: redact.dir })).code, 0);

  const deploy = await cli(["deploy"], { cwd: redact.dir });
  assert.equal(deploy.code, 0, deploy.all);
  assert.equal((await fetchText(`${redact.base}/`)).text, "api v1");

  redact.repoFor("api-v2");
  const second = await cli(["deploy"], { cwd: redact.dir });
  assert.equal(second.code, 0, second.all);
  assert.equal((await fetchText(`${redact.base}/`)).text, "api v2");

  const state = await containers("api-redact");
  assert.equal(state.filter((c) => c.running).length, 1, "exactly one release runs; older ones were stopped, not lost");
});
