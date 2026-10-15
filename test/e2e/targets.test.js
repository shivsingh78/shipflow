// End-to-end: deployment targets and project features, driven through the
// real CLI against a real SSH server + nginx ("vps" service).
// Runs after e2e.test.js; tests share state in order.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { fileURLToPath } from "url";

const API = process.env.SHIPFLOW_API_URL;
const SITE = process.env.SHIPFLOW_SITE_URL;
const TOKEN = process.env.SHIPFLOW_API_TOKEN;
const CLI = fileURLToPath(new URL("../../cli/index.js", import.meta.url));
const HOST_KEY = fs.readFileSync("/keys/host_key.pub", "utf8").trim();
// A syntactically valid key that is NOT the server's.
const WRONG_HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
const TIMEOUT = { timeout: 5 * 60 * 1000 };
const repo = (fixture) => `http://fixtures:9000/shipflow/${fixture}.git`;

function cli(args, { cwd } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd, env: { ...process.env }, timeout: 10 * 60 * 1000 }, (error, stdout, stderr) =>
      resolve({ code: error ? error.code : 0, stdout, stderr, all: stdout + stderr })
    );
  });
}

async function api(pathname, options = {}) {
  const response = await fetch(`${API}${pathname}`, {
    ...options,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...options.headers },
  });
  return { status: response.status, body: await response.json() };
}

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    http
      .get({ hostname: target.hostname, port: target.port, path: target.pathname, headers }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode, body, release: res.headers["x-shipflow-release"] }));
      })
      .on("error", reject);
  });
}

function projectDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  return dir;
}

function writeConfig(dir, config) {
  const lines = [
    "version: 1",
    "project:",
    `  name: ${config.name}`,
    `  repository: ${config.repository}`,
    "deployment:",
    `  target: ${config.target}`,
  ];

  if (config.target === "ssh") {
    lines.push(
      "  ssh:",
      "    host: vps",
      "    user: deploy",
      `    path: ${config.path}`,
      `    hostKey: ${config.hostKey ?? HOST_KEY}`,
      `    url: ${config.url}`
    );
  } else if (config.hostname) {
    lines.push("  shipflow:", `    hostname: ${config.hostname}`);
  }

  if (config.verifyPath) {
    lines.push("verification:", `  path: ${config.verifyPath}`);
  }

  fs.writeFileSync(path.join(dir, "shipflow.yml"), `${lines.join("\n")}\n`);
}

const releaseIdOf = (output) => output.match(/^Release: (\w{8})$/m)?.[1];

const ids = {};
const vpsDir = projectDir("vps-site");

test("init writes an ssh project; deploy refuses until the secret exists", TIMEOUT, async () => {
  const init = await cli(
    [
      "init", "--yes",
      "--name", "vps-site",
      "--repo", repo("site-v1"),
      "--target", "ssh",
      "--ssh-host", "vps",
      "--ssh-user", "deploy",
      "--ssh-path", "/srv/site",
      "--ssh-host-key", HOST_KEY,
      "--url", "http://vps:8081/",
    ],
    { cwd: vpsDir }
  );
  assert.equal(init.code, 0, init.all);

  const deploy = await cli(["deploy"], { cwd: vpsDir });
  assert.equal(deploy.code, 2, deploy.all);
  assert.match(deploy.stderr, /Missing secret\(s\) on the server: SSH_PRIVATE_KEY/);
});

test("secrets are stored server-side and doctor checks the real server", TIMEOUT, async () => {
  const set = await cli(["secrets", "set", "SSH_PRIVATE_KEY", "--from-file", "/keys/deploy_key"], { cwd: vpsDir });
  assert.equal(set.code, 0, set.all);
  assert.doesNotMatch(set.all, /PRIVATE KEY/);

  const doctor = await cli(["doctor", "--json"], { cwd: vpsDir });
  const report = JSON.parse(doctor.stdout);
  const check = (name) => report.checks.find((c) => c.name === name);

  assert.equal(check("target: ssh connection")?.ok, true, doctor.stdout);
  assert.equal(check("target: /srv/site writable")?.ok, true, doctor.stdout);
  assert.equal(check("target: mv -T")?.ok, true, doctor.stdout);
  assert.equal(check("server: workers")?.ok, true, doctor.stdout);
  assert.match(check("server: workers").detail, /restricted network/);
});

test("ssh target: v1 is uploaded, checksum-verified, switched and served by nginx", TIMEOUT, async () => {
  const deploy = await cli(["deploy"], { cwd: vpsDir });
  ids.v1 = releaseIdOf(deploy.stdout);

  assert.equal(deploy.code, 0, deploy.all);
  assert.match(deploy.stdout, /URL: http:\/\/vps:8081\//);

  const page = await get("http://vps:8081/");
  assert.equal(page.status, 200);
  assert.match(page.body, /ShipFlow fixture v1/);

  const { body } = await api(`/releases/${ids.v1}/logs`);
  const messages = body.logs.map((l) => l.message).join("\n");
  assert.match(messages, /verified by SHA-256/);
  assert.match(messages, /with this release's index.html/);
  assert.doesNotMatch(messages, /PRIVATE KEY/);
});

test("ssh target: v2 replaces v1, a failed build changes nothing, rollback restores v1", TIMEOUT, async () => {
  writeConfig(vpsDir, { name: "vps-site", repository: repo("site-v2"), target: "ssh", path: "/srv/site", url: "http://vps:8081/" });
  const v2 = await cli(["deploy"], { cwd: vpsDir });
  ids.v2 = releaseIdOf(v2.stdout);
  assert.equal(v2.code, 0, v2.all);
  assert.match((await get("http://vps:8081/")).body, /ShipFlow fixture v2/);

  writeConfig(vpsDir, { name: "vps-site", repository: repo("build-fail"), target: "ssh", path: "/srv/site", url: "http://vps:8081/" });
  const broken = await cli(["deploy"], { cwd: vpsDir });
  assert.equal(broken.code, 1);
  assert.match(broken.stderr, /Stage: BUILD/);
  assert.match((await get("http://vps:8081/")).body, /ShipFlow fixture v2/, "server untouched");

  const rollback = await cli(["rollback", ids.v1]);
  assert.equal(rollback.code, 0, rollback.all);
  assert.match(rollback.stdout, new RegExp(`${ids.v2} → ${ids.v1}`));
  assert.match((await get("http://vps:8081/")).body, /ShipFlow fixture v1/);
});

test("ssh target: a wrong host key is refused before anything changes", TIMEOUT, async () => {
  const dir = projectDir("vps-badkey");
  writeConfig(dir, { name: "vps-badkey", repository: repo("site-v2"), target: "ssh", path: "/srv/site", url: "http://vps:8081/", hostKey: WRONG_HOST_KEY });
  // `secrets set` next to shipflow.yml registers the project first.
  const secret = await cli(["secrets", "set", "SSH_PRIVATE_KEY", "--from-file", "/keys/deploy_key"], { cwd: dir });
  assert.equal(secret.code, 0, secret.all);
  const deploy = await cli(["deploy"], { cwd: dir });

  assert.equal(deploy.code, 1);
  assert.match(deploy.stderr, /Stage: DEPLOY/);
  assert.match(deploy.stderr, /does not match deployment.ssh.hostKey/);
  assert.match((await get("http://vps:8081/")).body, /ShipFlow fixture v1/);
});

test("ssh target: a failed live check switches the server back", TIMEOUT, async () => {
  const dir = projectDir("vps-site2");
  writeConfig(dir, { name: "vps-site2", repository: repo("site-v1"), target: "ssh", path: "/srv/site2", url: "http://vps:8082/" });
  assert.equal((await cli(["secrets", "set", "SSH_PRIVATE_KEY", "--from-file", "/keys/deploy_key"], { cwd: dir })).code, 0);

  const first = await cli(["deploy"], { cwd: dir });
  assert.equal(first.code, 0, first.all);
  assert.match((await get("http://vps:8082/")).body, /ShipFlow fixture v1/);

  // v2 with a health-check path that returns 404 after the switch.
  writeConfig(dir, { name: "vps-site2", repository: repo("site-v2"), target: "ssh", path: "/srv/site2", url: "http://vps:8082/", verifyPath: "/missing.html" });
  const second = await cli(["deploy"], { cwd: dir });

  assert.equal(second.code, 1);
  assert.match(second.stderr, /Stage: ACTIVATE/);
  assert.match(second.stderr, /restored previous release/);
  assert.match((await get("http://vps:8082/")).body, /ShipFlow fixture v1/);
});

test("ssh target: a FIRST deployment that fails its live check is taken offline, not left serving", TIMEOUT, async () => {
  const dir = projectDir("vps-first");
  writeConfig(dir, { name: "vps-first", repository: repo("site-v1"), target: "ssh", path: "/srv/site3", url: "http://vps:8083/", verifyPath: "/missing.html" });
  assert.equal((await cli(["secrets", "set", "SSH_PRIVATE_KEY", "--from-file", "/keys/deploy_key"], { cwd: dir })).code, 0);

  const first = await cli(["deploy"], { cwd: dir });
  const releaseId = releaseIdOf(first.stdout);

  assert.equal(first.code, 1, first.all);
  assert.match(first.stderr, /Stage: ACTIVATE/);
  assert.match(first.stderr, /taken offline and is not served/);
  assert.doesNotMatch(first.stderr, /restored previous release/);

  // Not served by the server, and not recorded as live.
  assert.equal((await get("http://vps:8083/")).status, 404);
  const { body } = await api("/projects/vps-first");
  assert.equal(body.activeReleaseId, null);
  const status = (await api(`/releases/${releaseId}`)).body.release;
  assert.equal(status.status, "FAILED");
  assert.equal(status.is_active, false);

  // A corrected configuration deploys normally afterwards.
  writeConfig(dir, { name: "vps-first", repository: repo("site-v1"), target: "ssh", path: "/srv/site3", url: "http://vps:8083/" });
  const second = await cli(["deploy"], { cwd: dir });
  assert.equal(second.code, 0, second.all);
  assert.match((await get("http://vps:8083/")).body, /ShipFlow fixture v1/);
});

test("shipflow target: projects are routed by hostname with separate live releases", TIMEOUT, async () => {
  const dir = projectDir("routed");
  writeConfig(dir, { name: "routed", repository: repo("site-v2"), target: "shipflow", hostname: "routed.test" });
  const deploy = await cli(["deploy"], { cwd: dir });
  assert.equal(deploy.code, 0, deploy.all);

  const routed = await get(`${SITE}/`, { Host: "routed.test" });
  assert.match(routed.body, /ShipFlow fixture v2/);
  assert.equal(routed.release, releaseIdOf(deploy.stdout));

  // The default site (from e2e.test.js, rolled back to v1) is unaffected.
  const fallback = await get(`${SITE}/`);
  assert.match(fallback.body, /ShipFlow fixture v1/);
});

test("check mode builds and tests a branch but never deploys", TIMEOUT, async () => {
  const { status, body } = await api("/deploy", { method: "POST", body: JSON.stringify({ project: "vps-site", mode: "check" }) });
  assert.equal(status, 202);

  let release;
  for (let i = 0; i < 120; i++) {
    release = (await api(`/releases/${body.release.release_id}`)).body.release;
    if (["SUCCESS", "FAILED", "CANCELLED"].includes(release.status)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  // vps-site's configuration currently points at the failing build.
  assert.equal(release.mode, "check");
  assert.equal(release.status, "FAILED");
  assert.equal(release.current_stage, "BUILD");
  assert.equal(release.artifact_path, null);
  assert.match((await get("http://vps:8081/")).body, /ShipFlow fixture v1/);
});

test("cancel stops a running build; nothing is deployed", TIMEOUT, async () => {
  const dir = projectDir("slow");
  writeConfig(dir, { name: "slow-site", repository: repo("slow-build"), target: "shipflow", hostname: "slow.test" });

  const queued = await cli(["deploy", "--no-wait", "--json"], { cwd: dir });
  assert.equal(queued.code, 0, queued.all);
  const releaseId = JSON.parse(queued.stdout).release.release_id;

  for (let i = 0; i < 60; i++) {
    const { release } = (await api(`/releases/${releaseId}`)).body;
    if (release.current_stage === "BUILD") break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  const cancel = await cli(["cancel", releaseId]);
  assert.equal(cancel.code, 0, cancel.all);

  let release;
  for (let i = 0; i < 60; i++) {
    release = (await api(`/releases/${releaseId}`)).body.release;
    if (["SUCCESS", "FAILED", "CANCELLED"].includes(release.status)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  assert.equal(release.status, "CANCELLED");
  assert.equal(release.error_message, "Cancelled by user");
  assert.equal(release.artifact_path, null);
  assert.equal((await get(`${SITE}/`, { Host: "slow.test" })).status, 404);
});

test("webhook requires a valid signature and ignores duplicate deliveries", async () => {
  const secret = process.env.SHIPFLOW_WEBHOOK_SECRET;
  const send = (body, { delivery = crypto.randomUUID(), event = "push", signature } = {}) =>
    fetch(`${API}/webhooks/github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": event,
        "X-GitHub-Delivery": delivery,
        "X-Hub-Signature-256": signature ?? `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`,
      },
      body,
    });

  assert.equal((await send("{}", { signature: "sha256=bad" })).status, 401);
  assert.equal((await (await send('{"zen":"x"}', { event: "ping" })).json()).message, "pong");

  const payload = JSON.stringify({ ref: "refs/heads/main", after: "a".repeat(40), repository: { full_name: "someone/elsewhere" } });
  assert.equal((await send(payload, { delivery: "dup-1" })).status, 403, "repository not allowlisted");
  assert.equal((await (await send(payload, { delivery: "dup-1" })).json()).duplicate, true);
});
