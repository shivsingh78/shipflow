// Patch stage through the real orchestrator + PostgreSQL. GitHub and the AI
// provider are in-memory fakes.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createRepoPilotStore } from "../../dist/src/repopilot/store.js";
import { createOrchestrator } from "../../dist/src/repopilot/orchestrator.js";
import { createGithubClient } from "../../dist/src/repopilot/github.js";
import { createIngestHandler, createManifestHandler } from "../../dist/src/repopilot/stagesIngest.js";
import { createAnalyzeHandler } from "../../dist/src/repopilot/stagesAnalyze.js";
import { createPatchHandler } from "../../dist/src/repopilot/stagesPatch.js";
import { createEvidenceStore } from "../../dist/src/repopilot/evidence.js";
import { loadRepoPilotConfig } from "../../dist/src/repopilot/config.js";
import { generateCredentialKeyPair, sealCredential } from "../../dist/src/repopilot/credentials.js";
import { patchDigest } from "../../dist/src/repopilot/patch.js";
import { createLocalStore } from "../../dist/src/artifactStore.js";
import { createFakeGithub } from "../helpers/fakeGithub.js";
import { REPO, SHA, fakeQueue, finding, openDatabase, resetDatabase, skipPg } from "./helpers.js";

const API_KEY = "sk-ant-api03-integrationKeyValue0123456789abcdef";
const KEYS = generateCredentialKeyPair();
const OWNER = "instance";
const USER = "user:operator";
const INDEX = "const a = JSON.parse(x);\nexport default a;\nfunction f() {}\n";
const FILES = { "package.json": JSON.stringify({ name: "demo", scripts: { test: "node --test" } }), "package-lock.json": "{}", "src/index.js": INDEX };
const GOOD_DIFF = ["diff --git a/src/index.js b/src/index.js", "index 1111111..2222222 100644", "--- a/src/index.js", "+++ b/src/index.js", "@@ -1,2 +1,2 @@", "-const a = JSON.parse(x);", "+const a = (() => { try { return JSON.parse(x); } catch { return null; } })();", " export default a;", ""].join("\n");
const GOOD_TEST = ["diff --git a/test/new.test.js b/test/new.test.js", "new file mode 100644", "index 0000000..1111111", "--- /dev/null", "+++ b/test/new.test.js", "@@ -0,0 +1,2 @@", "+import test from 'node:test';", "+test('handles bad json', () => {});", ""].join("\n");

let pool;
let store;
let root;
let evidence;

before(async () => {
  if (skipPg) return;
  pool = await openDatabase();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rp-patch-"));
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

const reply = (status, json) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(json) });
const tool = (name, input) => reply(200, { model: "claude-test", stop_reason: "tool_use", content: [{ type: "tool_use", name, input }], usage: { input_tokens: 800, output_tokens: 200 } });
const proposal = (o = {}) => ({ title: "Guard JSON.parse", explanation: "Wrap it.", diff: GOOD_DIFF, testDiff: GOOD_TEST, ...o });

async function awaitingPatch(patchAnswers) {
  await store.putCredential({ owner: OWNER, actor: USER, provider: "anthropic", ciphertext: sealCredential(KEYS.publicKeyPem, API_KEY), fingerprint: "0123456789abcdef" });

  const run = (await store.createRun({ owner: OWNER, actor: USER, repo: REPO })).run;
  const gh = createFakeGithub({ owner: REPO.owner, name: REPO.name, branches: { main: SHA }, commits: { [SHA]: FILES } });
  const github = createGithubClient({ token: "ghp_integrationTokenValue0123456789abcdef", fetch: gh.fetch, timeoutMs: 1000 });
  let patchCalls = 0;
  const aiFetch = async (_url, init) => {
    const body = JSON.parse(init.body);

    if (body.tool_choice.name === "report_findings") return tool("report_findings", { findings: [finding({ file: "src/index.js", lineStart: 1, lineEnd: 1 })] });

    const answer = patchAnswers[Math.min(patchCalls, patchAnswers.length - 1)];
    patchCalls += 1;

    return typeof answer === "function" ? answer() : answer;
  };
  const deps = { store, github, evidence, config: loadRepoPilotConfig({}) };
  const ai = { credentialPrivateKey: KEYS.privateKeyPem, fetch: aiFetch, timeoutMs: 1000 };
  const queue = fakeQueue();
  const orchestrator = createOrchestrator({ store, enqueue: queue.enqueue, workerId: "t", handlers: { ingest: createIngestHandler(deps), manifest: createManifestHandler(deps), analyze: createAnalyzeHandler({ ...deps, ai }), patch: createPatchHandler({ ...deps, ai }) } });

  for (const stage of ["ingest", "manifest", "analyze"]) await orchestrator.processJob({ runId: run.id, stage, attempt: 1 });

  const [found] = await store.listFindings(OWNER, run.id);
  queue.jobs.length = 0;

  return { run, found, orchestrator, queue, patchCalls: () => patchCalls };
}

test("a valid patch is bound to the commit and finding, stored with evidence, and moves to verification", { skip: skipPg }, async () => {
  const { run, found, orchestrator, queue } = await awaitingPatch([tool("propose_patch", proposal())]);
  const result = await orchestrator.processJob({ runId: run.id, stage: "patch", attempt: 1, findingId: found.id });

  assert.deepEqual(result, { status: "completed", runState: "verifying" });
  assert.deepEqual(queue.jobs.map((j) => j.job), [{ runId: run.id, stage: "verify", attempt: 1 }]);

  const [patch] = await store.listPatches(OWNER, run.id);
  assert.equal(patch.baseCommit, SHA);
  assert.equal(patch.findingId, found.id);
  assert.equal(patch.validationOk, true);
  assert.equal(patch.diffSha256, patchDigest(GOOD_DIFF, GOOD_TEST));
  assert.equal(patch.validation.apply.ok, true);
  assert.equal(patch.diff, GOOD_DIFF);

  const kinds = (await store.listArtifacts(OWNER, run.id)).map((a) => a.kind);
  assert.deepEqual(kinds.filter((k) => k.startsWith("patch")).sort(), ["patch", "patch_validation"]);
  assert.equal((await store.getRun(OWNER, run.id)).aiRequests, 2, "one analysis request and one patch request");
  assert.equal((await store.listVerifications(OWNER, run.id)).length, 0, "a patch is never marked verified by generation");
  assert.equal((await store.listOutcomes(OWNER, run.id)).length, 0);
});

test("a rejected proposal is preserved with its reasons and the run returns to patch selection", { skip: skipPg }, async () => {
  const badDiff = GOOD_DIFF.replaceAll("src/index.js", "package.json");
  const { run, found, orchestrator, queue } = await awaitingPatch([tool("propose_patch", proposal({ diff: badDiff }))]);
  const result = await orchestrator.processJob({ runId: run.id, stage: "patch", attempt: 1, findingId: found.id });

  assert.deepEqual(result, { status: "completed", runState: "awaiting_patch" });
  assert.equal(queue.jobs.length, 0, "nothing is verified");

  const [patch] = await store.listPatches(OWNER, run.id);
  assert.equal(patch.validationOk, false);
  assert.equal(patch.diff, badDiff);
  assert.ok(patch.validation.issues.some((i) => i.code === "forbidden_path"));
  assert.equal(patch.validation.apply.issues[0].code, "not_applied");
  assert.equal(await store.latestValidPatch(run.id), null);
  assert.equal((await store.listStages(OWNER, run.id)).filter((s) => s.stage === "patch").length, 1);
});

test("an unappliable diff is rejected with the apply error", { skip: skipPg }, async () => {
  const stale = GOOD_DIFF.replace("-const a = JSON.parse(x);", "-const a = JSON.parse(zzz);");
  const { run, found, orchestrator } = await awaitingPatch([tool("propose_patch", proposal({ diff: stale }))]);

  assert.deepEqual(await orchestrator.processJob({ runId: run.id, stage: "patch", attempt: 1, findingId: found.id }), { status: "completed", runState: "awaiting_patch" });

  const [patch] = await store.listPatches(OWNER, run.id);
  assert.equal(patch.validation.ok, true);
  assert.equal(patch.validation.apply.issues[0].code, "context_mismatch");
  assert.equal(patch.validationOk, false);
});

test("a retry or recovery of a patch job reuses the recorded finding", { skip: skipPg }, async () => {
  const { run, found, orchestrator, queue, patchCalls } = await awaitingPatch([reply(500, {}), tool("propose_patch", proposal())]);

  assert.equal((await orchestrator.processJob({ runId: run.id, stage: "patch", attempt: 1, findingId: found.id })).status, "retry_scheduled");
  assert.deepEqual(queue.jobs.at(-1).job, { runId: run.id, stage: "patch", attempt: 2, findingId: found.id }, "the retry carries the finding");

  // Simulate a recovered job that lost its payload.
  assert.deepEqual(await orchestrator.processJob({ runId: run.id, stage: "patch", attempt: 2 }), { status: "completed", runState: "verifying" });
  assert.equal(patchCalls(), 2);
  assert.equal((await store.listPatches(OWNER, run.id))[0].findingId, found.id);
});

test("patch attempts are bounded per run, and identical re-proposals collapse to one record", { skip: skipPg }, async () => {
  const bad = (name) => GOOD_DIFF.replaceAll("src/index.js", name);
  const { run, found, orchestrator } = await awaitingPatch([tool("propose_patch", proposal({ diff: bad("package.json") })), tool("propose_patch", proposal({ diff: bad("package-lock.json") })), tool("propose_patch", proposal({ diff: bad("package.json") }))]);

  for (const attempt of [1, 2, 3]) {
    assert.deepEqual(await orchestrator.processJob({ runId: run.id, stage: "patch", attempt, findingId: found.id }), { status: "completed", runState: "awaiting_patch" });
  }

  assert.deepEqual(await orchestrator.processJob({ runId: run.id, stage: "patch", attempt: 4, findingId: found.id }), { status: "skipped", reason: "attempts_exhausted" });
  assert.equal((await store.listPatches(OWNER, run.id)).length, 2, "attempt 3 re-sent attempt 1's exact bytes: same digest, same record");
});

test("a finding from another run cannot be patched", { skip: skipPg }, async () => {
  const a = await awaitingPatch([tool("propose_patch", proposal())]);
  const other = (await store.createRun({ owner: OWNER, actor: USER, repo: REPO })).run;

  await pool.query("UPDATE rp_runs SET state = 'awaiting_patch', commit_sha = $2, default_branch = 'main' WHERE id = $1", [other.id, SHA]);

  const result = await a.orchestrator.processJob({ runId: other.id, stage: "patch", attempt: 1, findingId: a.found.id });
  assert.deepEqual(result, { status: "failed", code: "finding_missing" });
});
