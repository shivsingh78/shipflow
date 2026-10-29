// Analysis end to end through the real orchestrator, PostgreSQL, sealed
// credentials and artifact store. GitHub and Anthropic are in-memory fakes:
// no network and no paid request is ever made.
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
import { createEvidenceStore } from "../../dist/src/repopilot/evidence.js";
import { loadRepoPilotConfig } from "../../dist/src/repopilot/config.js";
import { generateCredentialKeyPair, sealCredential } from "../../dist/src/repopilot/credentials.js";
import { ANALYSIS_TOOL } from "../../dist/src/repopilot/analysis.js";
import { createLocalStore } from "../../dist/src/artifactStore.js";
import { createFakeGithub } from "../helpers/fakeGithub.js";
import { REPO, SHA, fakeQueue, finding, openDatabase, resetDatabase, skipPg } from "./helpers.js";

const API_KEY = "sk-ant-api03-integrationKeyValue0123456789abcdef";
const GH_TOKEN = "ghp_integrationTokenValue0123456789abcdef";
const KEYS = generateCredentialKeyPair();
const OWNER = "instance";
const USER = "user:operator";
const FILES = { "package.json": JSON.stringify({ name: "demo", scripts: { test: "node --test" } }), "package-lock.json": "{}", "src/index.js": "const a = JSON.parse(x);\nexport default a;\nfunction f() {}\n", "src/util.js": "export const b = 2;\n" };

let pool;
let store;
let root;
let evidence;

before(async () => {
  if (skipPg) return;
  pool = await openDatabase();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rp-analyze-"));
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
const message = (input) => ({ model: "claude-test", stop_reason: "tool_use", content: [{ type: "tool_use", name: ANALYSIS_TOOL.name, input }], usage: { input_tokens: 900, output_tokens: 150 } });

function setup({ responses, env = {} }) {
  const fakeGh = createFakeGithub({ owner: REPO.owner, name: REPO.name, branches: { main: SHA }, commits: { [SHA]: FILES } });
  const calls = [];
  const aiFetch = async (url, init) => { calls.push({ url, init }); const next = responses[Math.min(calls.length - 1, responses.length - 1)]; return typeof next === "function" ? next() : next; };
  const config = loadRepoPilotConfig(env);
  const deps = { store, github: createGithubClient({ token: GH_TOKEN, fetch: fakeGh.fetch, timeoutMs: 1000 }), evidence, config };
  const queue = fakeQueue();
  const orchestrator = createOrchestrator({
    store, enqueue: queue.enqueue, workerId: "t",
    handlers: { ingest: createIngestHandler(deps), manifest: createManifestHandler(deps), analyze: createAnalyzeHandler({ ...deps, ai: { credentialPrivateKey: KEYS.privateKeyPem, fetch: aiFetch, timeoutMs: 1000 } }) },
  });

  return { orchestrator, calls, queue };
}

const withKey = (owner = OWNER) => store.putCredential({ owner, actor: USER, provider: "anthropic", ciphertext: sealCredential(KEYS.publicKeyPem, API_KEY), fingerprint: "0123456789abcdef" });
const newRun = async (owner = OWNER) => (await store.createRun({ owner, actor: USER, repo: REPO })).run;
const drive = async (orchestrator, runId, stages = ["ingest", "manifest", "analyze"]) => { const out = []; for (const stage of stages) out.push(await orchestrator.processJob({ runId, stage, attempt: 1 })); return out; };

test("a run goes from queued to awaiting_patch with ranked, grounded suggestions", { skip: skipPg }, async () => {
  await withKey();
  const run = await newRun();
  const { orchestrator, calls } = setup({ responses: [reply(200, message({ findings: [
    finding({ title: "Low thing", severity: "low", lineStart: 3, lineEnd: 3, file: "src/index.js", category: "maintainability" }),
    finding({ title: "Crash on bad JSON", severity: "high", file: "src/index.js", lineStart: 1, lineEnd: 1 }),
    finding({ title: "Invented", file: "src/nope.js" }),
    finding({ title: "Past the end", file: "src/index.js", lineStart: 50, lineEnd: 60 }),
  ] }))] });

  assert.deepEqual((await drive(orchestrator, run.id)).map((r) => r.status), ["completed", "completed", "completed"]);

  const after = await store.getRun(OWNER, run.id);
  assert.equal(after.state, "awaiting_patch");
  assert.equal(after.aiRequests, 1);
  assert.equal(after.aiInputTokens, 900);
  assert.equal(after.aiOutputTokens, 150);

  const findings = await store.listFindings(OWNER, run.id);
  assert.deepEqual(findings.map((f) => [f.rank, f.title, f.severity]), [[1, "Crash on bad JSON", "high"], [2, "Low thing", "low"]]);
  assert.equal(calls.length, 1);

  const report = (await store.listArtifacts(OWNER, run.id)).find((a) => a.kind === "findings");
  const stored = JSON.parse((await evidence.get(report.objectKey, 1_000_000)).toString());
  assert.deepEqual(stored.dropped.map((d) => d.reason).sort(), ["file_not_in_context", "lines_out_of_range"]);
  assert.equal(stored.usage.inputTokens, 900, "token counters survive evidence redaction");
});

test("the customer's key and the GitHub token appear nowhere in the database, logs or stored evidence", { skip: skipPg }, async () => {
  await withKey();
  const run = await newRun();
  const { orchestrator, calls } = setup({ responses: [reply(200, message({ findings: [finding({ file: "src/index.js" })] }))] });

  await drive(orchestrator, run.id);

  const tables = ["rp_runs", "rp_stages", "rp_findings", "rp_logs", "rp_artifacts", "rp_audit_events", "rp_credentials"];
  let dump = "";

  for (const table of tables) dump += JSON.stringify((await pool.query(`SELECT * FROM ${table}`)).rows);

  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

  for (const file of walk(root)) dump += fs.readFileSync(file, "utf-8");

  assert.ok(dump.length > 1000);
  assert.ok(!dump.includes(API_KEY) && !dump.includes("integrationKeyValue"), "provider key leaked");
  assert.ok(!dump.includes(GH_TOKEN) && !dump.includes("integrationTokenValue"), "GitHub token leaked");
  assert.equal(calls[0].init.headers["x-api-key"], API_KEY, "…yet the provider call did use the customer's key");
});

test("a run whose owner has no stored key fails before any provider request, and is not billed", { skip: skipPg }, async () => {
  await withKey("someone-else");
  const run = await newRun();
  const { orchestrator, calls } = setup({ responses: [reply(200, message({ findings: [] }))] });
  const results = await drive(orchestrator, run.id);

  assert.deepEqual(results[2], { status: "failed", code: "ai_credentials_missing" });
  assert.equal(calls.length, 0);
  assert.equal((await store.getRun(OWNER, run.id)).aiRequests, 0);
});

test("a malformed answer is retried within the budget; a second one exhausts it and fails the run", { skip: skipPg }, async () => {
  await withKey();
  const run = await newRun();
  const { orchestrator, calls } = setup({ env: { REPOPILOT_MAX_AI_REQUESTS: "2" }, responses: [reply(200, message({ findings: [finding({ severity: "urgent" })] })), reply(200, message({ findings: [finding({ severity: "urgent" })] })), reply(200, message({ findings: [finding()] }))] });

  await drive(orchestrator, run.id, ["ingest", "manifest"]);

  assert.deepEqual(await orchestrator.processJob({ runId: run.id, stage: "analyze", attempt: 1 }), { status: "retry_scheduled", attempt: 2, delayMs: 5 });
  assert.deepEqual(await orchestrator.processJob({ runId: run.id, stage: "analyze", attempt: 2 }), { status: "retry_scheduled", attempt: 3, delayMs: 10 });
  assert.deepEqual(await orchestrator.processJob({ runId: run.id, stage: "analyze", attempt: 3 }), { status: "failed", code: "ai_budget_exceeded" });

  assert.equal(calls.length, 2, "the cap stopped the third request from being sent");
  assert.equal((await store.getRun(OWNER, run.id)).aiRequests, 2);
  assert.equal((await store.getRun(OWNER, run.id)).state, "failed");
});

test("a model claiming verification or approval is rejected and recorded as such", { skip: skipPg }, async () => {
  await withKey();
  const run = await newRun();
  const { orchestrator } = setup({ responses: [reply(200, message({ findings: [finding()], verified: true, testsPassed: true }))] });

  await drive(orchestrator, run.id, ["ingest", "manifest"]);
  await orchestrator.processJob({ runId: run.id, stage: "analyze", attempt: 1 });

  const stage = (await store.listStages(OWNER, run.id)).find((s) => s.stage === "analyze");
  assert.equal(stage.errorCode, "ai_forbidden_field");
  assert.equal((await store.listFindings(OWNER, run.id)).length, 0, "nothing from a rejected answer is kept");
});

test("a provider authentication failure fails fast with the fix in the message", { skip: skipPg }, async () => {
  await withKey();
  const run = await newRun();
  const { orchestrator } = setup({ responses: [reply(401, { error: "invalid x-api-key" })] });

  await drive(orchestrator, run.id, ["ingest", "manifest"]);

  assert.deepEqual(await orchestrator.processJob({ runId: run.id, stage: "analyze", attempt: 1 }), { status: "failed", code: "ai_auth" });
  assert.match((await store.getRun(OWNER, run.id)).failureDetail, /key was rejected/);
  assert.equal((await store.getRun(OWNER, run.id)).aiInputTokens, 0, "a rejected request is not billed");
});

test("cancelling during the provider call aborts it and cancels the run", { skip: skipPg }, async () => {
  await withKey();
  const run = await newRun();
  const { orchestrator } = setup({ responses: [() => new Promise((resolve) => setTimeout(() => resolve(reply(200, message({ findings: [finding()] }))), 250))] });

  await drive(orchestrator, run.id, ["ingest", "manifest"]);

  const job = orchestrator.processJob({ runId: run.id, stage: "analyze", attempt: 1 });
  await new Promise((resolve) => setTimeout(resolve, 60));
  await store.requestCancel(OWNER, run.id, USER);

  assert.equal((await job).status, "cancelled");
  assert.equal((await store.getRun(OWNER, run.id)).state, "cancelled");
  assert.equal((await store.listFindings(OWNER, run.id)).length, 0);
});

test("concurrent workers cannot overspend a run's request limit", { skip: skipPg }, async () => {
  const run = await newRun();
  const limits = { maxRequests: 3, maxInputTokens: 1_000_000, maxOutputTokens: 1_000_000 };
  const results = await Promise.all(Array.from({ length: 12 }, () => store.reserveAiRequest(run.id, limits)));

  assert.equal(results.filter(Boolean).length, 3);
  assert.equal((await store.getRun(OWNER, run.id)).aiRequests, 3);

  await store.recordAiUsage(run.id, { inputTokens: 2_000_000, outputTokens: 0 });
  assert.equal(await store.reserveAiRequest(run.id, { ...limits, maxRequests: 99 }), false, "the token cap blocks further requests");
  await assert.rejects(() => store.recordAiUsage(run.id, { inputTokens: -1, outputTokens: 0 }), (e) => e.code === "invalid_input");
});
