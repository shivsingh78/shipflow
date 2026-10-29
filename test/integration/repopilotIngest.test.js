// Ingest + manifest through the real orchestrator, PostgreSQL and ShipFlow's
// real local artifact store. GitHub is the in-memory fake (no network).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createRepoPilotStore } from "../../dist/src/repopilot/store.js";
import { createOrchestrator } from "../../dist/src/repopilot/orchestrator.js";
import { createGithubClient } from "../../dist/src/repopilot/github.js";
import { createIngestHandler, createManifestHandler, loadManifest } from "../../dist/src/repopilot/stagesIngest.js";
import { createEvidenceStore, evidenceKey } from "../../dist/src/repopilot/evidence.js";
import { loadRepoPilotConfig } from "../../dist/src/repopilot/config.js";
import { createLocalStore } from "../../dist/src/artifactStore.js";
import { createFakeGithub } from "../helpers/fakeGithub.js";
import { REPO, fakeQueue, openDatabase, resetDatabase, skipPg } from "./helpers.js";

const SHA = "a".repeat(40);
const FILES = { "package.json": JSON.stringify({ name: "demo", scripts: { test: "node --test" } }), "package-lock.json": "{}", "src/index.js": "export const a = 1;\n", "test/a.test.js": "// t\n" };
const OWNER = "instance";
const USER = "user:operator";

let pool;
let store;
let root;
let evidence;

before(async () => {
  if (skipPg) return;
  pool = await openDatabase();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rp-artifacts-"));
  evidence = createEvidenceStore(createLocalStore(root));
});

after(async () => {
  await pool?.end();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  if (skipPg) return;
  await resetDatabase(pool);
  store = createRepoPilotStore(pool, { retryBaseMs: 5 });
});

function pipeline({ spec = {}, token = "ghp_testtokenvalue0123456789abcdef", config = loadRepoPilotConfig({}) } = {}) {
  const fake = createFakeGithub({ owner: REPO.owner, name: REPO.name, branches: { main: SHA }, commits: { [SHA]: FILES }, ...spec });
  const github = token ? createGithubClient({ token, fetch: fake.fetch, timeoutMs: 1000 }) : null;
  const deps = { store, github, evidence, config };
  const queue = fakeQueue();
  const orchestrator = createOrchestrator({ store, enqueue: queue.enqueue, workerId: "t", handlers: { ingest: createIngestHandler(deps), manifest: createManifestHandler(deps), analyze: async () => ({}) } });

  return { fake, orchestrator, queue, deps };
}

const newRun = async () => (await store.createRun({ owner: OWNER, actor: USER, repo: REPO })).run;

test("ingest and manifest pin the commit and store a verified manifest in the real artifact store", { skip: skipPg }, async () => {
  const run = await newRun();
  const { orchestrator } = pipeline();

  assert.equal((await orchestrator.processJob({ runId: run.id, stage: "ingest", attempt: 1 })).status, "completed");
  assert.equal((await orchestrator.processJob({ runId: run.id, stage: "manifest", attempt: 1 })).status, "completed");

  const after = await store.getRun(OWNER, run.id);
  assert.equal(after.state, "analyzing");
  assert.equal(after.commitSha, SHA);
  assert.equal(after.defaultBranch, "main");

  const [artifact] = await store.listArtifacts(OWNER, run.id);
  assert.equal(artifact.kind, "manifest");
  assert.equal(artifact.objectKey, evidenceKey({ runId: run.id, kind: "manifest" }));
  assert.ok(fs.existsSync(path.join(root, artifact.objectKey)));
  assert.equal(fs.statSync(path.join(root, artifact.objectKey)).size, artifact.bytes);

  const manifest = await loadManifest({ store, evidence }, after);
  assert.equal(manifest.verifiable.ok, true);
  assert.deepEqual(manifest.files.map((f) => f.path), ["package.json", "src/index.js", "test/a.test.js"]);
  assert.ok(!JSON.stringify(manifest).includes("export const a"), "no source content is stored in the manifest");

  // Tampering with the stored object is detected.
  fs.writeFileSync(path.join(root, artifact.objectKey), JSON.stringify({ version: 1, commitSha: SHA, evil: true }));
  await assert.rejects(() => loadManifest({ store, evidence }, after), (e) => e.code === "evidence_tampered");
});

test("the evidence adapter bounds reads and reports missing objects", { skip: skipPg }, async () => {
  const key = evidenceKey({ runId: 99, kind: "findings" });

  await evidence.put(key, Buffer.from("x".repeat(100)), "text/plain");
  assert.equal((await evidence.get(key, 1000)).length, 100);
  await assert.rejects(() => evidence.get(key, 10), RangeError);
  assert.equal(await evidence.get(evidenceKey({ runId: 99, kind: "outcome" }), 1000), null);
  await assert.rejects(() => evidence.put(key, Buffer.alloc(3 * 1024 * 1024), "text/plain"), RangeError);
  await assert.rejects(() => evidence.get("../../etc/passwd", 10));
  await evidence.remove([key]);
  assert.equal(await evidence.get(key, 1000), null);
});

test("an inaccessible repository fails the run immediately with an actionable code", { skip: skipPg }, async () => {
  const run = await newRun();
  const { orchestrator, queue, fake } = pipeline();
  fake.fail.set("/repos/acme/widgets", { status: 404 });

  assert.deepEqual(await orchestrator.processJob({ runId: run.id, stage: "ingest", attempt: 1 }), { status: "failed", code: "repository_not_accessible" });
  assert.equal(queue.jobs.length, 0);

  const failed = await store.getRun(OWNER, run.id);
  assert.equal(failed.state, "failed");
  assert.equal(failed.commitSha, null, "a failed ingest never claims a revision");
  assert.equal((await store.listArtifacts(OWNER, run.id)).length, 0);
});

test("GitHub rate limiting and outages retry within the budget, then fail", { skip: skipPg }, async () => {
  const run = await newRun();
  const { orchestrator, fake } = pipeline();
  fake.fail.set("/repos/acme/widgets", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1893456000" } });

  assert.equal((await orchestrator.processJob({ runId: run.id, stage: "ingest", attempt: 1 })).status, "retry_scheduled");
  assert.equal((await orchestrator.processJob({ runId: run.id, stage: "ingest", attempt: 2 })).status, "retry_scheduled");

  // Recovered before the last attempt.
  fake.fail.clear();
  assert.equal((await orchestrator.processJob({ runId: run.id, stage: "ingest", attempt: 3 })).status, "completed");
  assert.equal((await store.getRun(OWNER, run.id)).commitSha, SHA);

  const stages = await store.listStages(OWNER, run.id);
  assert.deepEqual(stages.map((s) => [s.attempt, s.state, s.errorCode]), [[1, "failed", "github_rate_limited"], [2, "failed", "github_rate_limited"], [3, "succeeded", null]]);
});

test("a missing token, a private repository and a revoked token fail clearly and without retries", { skip: skipPg }, async () => {
  for (const [options, code] of [[{ token: null }, "github_not_configured"], [{ spec: { private: true } }, "private_repository_not_allowed"]]) {
    await resetDatabase(pool);
    const run = await newRun();
    const { orchestrator, queue } = pipeline(options);

    assert.deepEqual(await orchestrator.processJob({ runId: run.id, stage: "ingest", attempt: 1 }), { status: "failed", code }, code);
    assert.equal(queue.jobs.length, 0);
  }

  await resetDatabase(pool);
  const run = await newRun();
  const { orchestrator, fake } = pipeline();
  fake.fail.set("/repos/acme/widgets", { status: 401 });
  assert.deepEqual(await orchestrator.processJob({ runId: run.id, stage: "ingest", attempt: 1 }), { status: "failed", code: "github_auth_failed" });
});

test("a repository with nothing to analyse fails at the manifest stage, not later", { skip: skipPg }, async () => {
  const run = await newRun();
  const { orchestrator } = pipeline({ spec: { commits: { [SHA]: { "README.md": "# docs\n" } } } });

  await orchestrator.processJob({ runId: run.id, stage: "ingest", attempt: 1 });
  assert.deepEqual(await orchestrator.processJob({ runId: run.id, stage: "manifest", attempt: 1 }), { status: "failed", code: "no_supported_files" });
  assert.equal((await store.getRun(OWNER, run.id)).state, "failed");
});

test("run logs describe progress without source code or tokens", { skip: skipPg }, async () => {
  const run = await newRun();
  const { orchestrator } = pipeline();

  await orchestrator.processJob({ runId: run.id, stage: "ingest", attempt: 1 });
  await orchestrator.processJob({ runId: run.id, stage: "manifest", attempt: 1 });

  const text = (await store.listLogs(OWNER, run.id)).map((l) => l.message).join("\n");

  assert.match(text, /Resolved "main" to aaaaaaaaaaaa/);
  assert.match(text, /Manifest: 3 files kept/);
  assert.doesNotMatch(text, /export const|ghp_/);
});
