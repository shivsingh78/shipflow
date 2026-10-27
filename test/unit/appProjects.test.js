// API routes for projects, secrets, project deploys and cancellation,
// run against in-memory fakes (no database, queue or storage).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { createApiApp } from "../../dist/src/app.js";
import { validateProjectConfig, requiredSecrets } from "../../cli/dist/lib/projectConfig.js";

const TOKEN = "unit-test-token-0123456789abcdef";
const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";

const sshConfig = (name = "vps-site") => ({
  version: 1,
  project: { name, repository: "https://github.com/shiv/site" },
  deployment: {
    target: "ssh",
    ssh: { host: "vps.example.com", user: "deploy", path: "/srv/site", hostKey: HOST_KEY, url: "https://site.example.com" },
  },
});

let server;
let url;
const state = { projects: new Map(), secrets: new Map(), releases: new Map(), queue: [], removedJobs: [] };

before(async () => {
  let counter = 0;

  const app = createApiApp({
    config: { apiToken: TOKEN, allowedRepoPrefixes: ["https://github.com/shiv/"], maxQueuedReleases: 5, instance: "test" },
    releases: {
      createRelease: async (r) => {
        const row = { release_id: r.releaseId, repo_url: r.repoUrl, status: r.status, current_stage: r.currentStage, project: r.project, mode: r.mode, ref: r.ref, trigger: r.trigger, target: r.target, config: r.config };
        state.releases.set(r.releaseId, row);
        return row;
      },
      getRelease: async (id) => state.releases.get(id),
      getAllReleases: async () => [...state.releases.values()],
      updateRelease: async () => {},
      requestCancel: async (id) => {
        const row = state.releases.get(id);
        if (!row || !["QUEUED", "RUNNING"].includes(row.status)) return undefined;
        row.cancel_requested = true;
        return row;
      },
      transitionRelease: async (id, from, to) => {
        const row = state.releases.get(id);
        if (!row || !from.includes(row.status)) return undefined;
        row.status = to;
        return row;
      },
    },
    projects: {
      upsertProject: async (config) => {
        const row = { name: config.project.name, repo_url: config.project.repository, target: config.deployment.target, config };
        state.projects.set(row.name, row);
        return row;
      },
      getProject: async (name) => state.projects.get(name),
      listProjects: async () => [...state.projects.values()],
    },
    logs: { getReleaseLogs: async () => [] },
    notifications: { getReleaseNotifications: async () => [] },
    queue: {
      add: async (name, data) => state.queue.push(data),
      getJobCounts: async () => ({ waiting: 0 }),
      getJob: async (id) => ({ remove: async () => state.removedJobs.push(id) }),
    },
    activation: { getActiveReleaseId: async () => null },
    rollback: { rollbackRelease: async () => ({}) },
    storage: { getObject: async () => { throw new Error("none"); }, isNotFoundError: () => true, describe: () => "local:/tmp" },
    secrets: {
      enabled: true,
      list: async (project) => [...state.secrets.keys()].filter((k) => k.startsWith(`${project}/`)).map((k) => ({ name: k.split("/")[1] })),
      set: async (project, name, value) => state.secrets.set(`${project}/${name}`, value),
      remove: async (project, name) => state.secrets.delete(`${project}/${name}`),
    },
    healthCheck: async () => {},
    readiness: async () => [{ name: "postgres", ok: true, detail: "ok" }],
    generateId: () => `Rel${String(++counter).padStart(5, "0")}`,
    validateProjectConfig,
    requiredSecrets,
    targets: () => [{ name: "ssh" }],
    checkTarget: async () => [{ name: "ssh connection", ok: true, detail: "ok" }],
  });

  server = app.listen(0);
  url = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const call = (method, path, body) =>
  fetch(`${url}${path}`, { method, headers: auth, body: body === undefined ? undefined : JSON.stringify(body) });

test("registering a project validates the configuration and lists missing secrets", async () => {
  const bad = await call("PUT", "/projects/vps-site", { config: { ...sshConfig(), extra: 1 } });
  assert.equal(bad.status, 400);
  const badBody = await bad.json();
  assert.ok(badBody.errors.some((e) => e.path === "(root).extra"));

  const mismatch = await call("PUT", "/projects/other", { config: sshConfig() });
  assert.equal(mismatch.status, 400);

  const notAllowed = await call("PUT", "/projects/vps-site", {
    config: { ...sshConfig(), project: { name: "vps-site", repository: "https://github.com/evil/site" } },
  });
  assert.equal(notAllowed.status, 400);

  const ok = await call("PUT", "/projects/vps-site", { config: sshConfig() });
  const body = await ok.json();
  assert.equal(ok.status, 200);
  assert.deepEqual(body.missingSecrets, ["SSH_PRIVATE_KEY"]);
});

test("deploying a project without its secret is refused before queueing", async () => {
  const before = state.queue.length;
  const response = await call("POST", "/deploy", { project: "vps-site" });

  assert.equal(response.status, 409);
  assert.match((await response.json()).message, /SSH_PRIVATE_KEY/);
  assert.equal(state.queue.length, before);
});

test("deploys record where they came from: the dashboard is labelled, anything else is the CLI", async () => {
  state.releases.clear();
  const rows = () => [...state.releases.values()];

  await call("PUT", "/projects/vps-site/secrets/SSH_PRIVATE_KEY", { value: "k" });
  assert.equal((await call("POST", "/deploy", { project: "vps-site", trigger: "dashboard" })).status, 202);
  assert.equal((await call("POST", "/deploy", { project: "vps-site", trigger: "<script>" })).status, 202);
  assert.equal((await call("POST", "/deploy", { project: "vps-site" })).status, 202);
  assert.deepEqual(rows().map((r) => r.trigger), ["dashboard", "cli", "cli"]);
});

test("secrets are stored but never returned", async () => {
  const set = await call("PUT", "/projects/vps-site/secrets/SSH_PRIVATE_KEY", { value: "PRIVATE-KEY-VALUE" });
  const setBody = await set.text();
  assert.equal(set.status, 200);
  assert.doesNotMatch(setBody, /PRIVATE-KEY-VALUE/);

  const list = await (await call("GET", "/projects/vps-site/secrets")).text();
  assert.match(list, /SSH_PRIVATE_KEY/);
  assert.doesNotMatch(list, /PRIVATE-KEY-VALUE/);

  const project = await (await call("GET", "/projects/vps-site")).text();
  assert.doesNotMatch(project, /PRIVATE-KEY-VALUE/);

  assert.equal((await call("PUT", "/projects/nope/secrets/X", { value: "v" })).status, 404);
});

test("a project deploy snapshots its config and queues only the release ID", async () => {
  const response = await call("POST", "/deploy", { project: "vps-site", ref: "main" });
  const { release } = await response.json();

  assert.equal(response.status, 202);
  assert.equal(release.project, "vps-site");
  assert.equal(release.target, "ssh");
  assert.equal(release.ref, "main");
  assert.equal(release.config.deployment.ssh.host, "vps.example.com");
  assert.deepEqual(state.queue.at(-1), { releaseId: release.release_id });

  assert.equal((await call("POST", "/deploy", { project: "Bad Name" })).status, 400);
  assert.equal((await call("POST", "/deploy", { project: "unknown" })).status, 404);
});

test("cancelling a queued release removes its job; finished releases cannot be cancelled", async () => {
  const { release } = await (await call("POST", "/deploy", { project: "vps-site" })).json();

  const cancelled = await call("POST", `/releases/${release.release_id}/cancel`);
  assert.equal((await cancelled.json()).status, "CANCELLED");
  assert.ok(state.removedJobs.includes(release.release_id));

  const again = await call("POST", `/releases/${release.release_id}/cancel`);
  assert.equal(again.status, 409);

  assert.equal((await call("POST", "/releases/Zzzzzzz9/cancel")).status, 404);
});

test("readiness, whoami and target checks require the token", async () => {
  assert.equal((await fetch(`${url}/ready`)).status, 401);
  assert.equal((await call("GET", "/ready")).status, 200);
  assert.equal((await (await call("GET", "/whoami")).json()).instance, "test");
  assert.equal((await (await call("POST", "/projects/vps-site/check")).json()).success, true);
});
