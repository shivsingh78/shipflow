// Pull-request stage through the real orchestrator + PostgreSQL, against an
// in-memory GitHub. Asserts both what it does and what it must never do.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { createRepoPilotStore } from "../../dist/src/repopilot/store.js";
import { createVerifyHandler } from "../../dist/src/repopilot/stagesVerify.js";
import { createPrHandler } from "../../dist/src/repopilot/stagesPr.js";
import { createGithubClient } from "../../dist/src/repopilot/github.js";
import { loadRepoPilotConfig } from "../../dist/src/repopilot/config.js";
import { createSandboxRunner } from "../../dist/src/repopilot/verifySandbox.js";
import { patchDigest } from "../../dist/src/repopilot/patch.js";
import { createFakeGithub } from "../helpers/fakeGithub.js";
import { REPO, SHA, openDatabase, resetDatabase, skipPg } from "./helpers.js";
import { GH_TOKEN, GOOD_DIFF, GOOD_TEST, INDEX, OWNER, PKG, USER, exited, fakeSandbox, makeEvidence, verifyingRun } from "./pipeline.js";

let pool;
let store;
let ev;

before(async () => {
  if (skipPg) return;
  pool = await openDatabase();
  ev = makeEvidence();
});

after(async () => {
  await pool?.end();
  ev?.cleanup();
});

beforeEach(async () => {
  if (skipPg) return;
  await resetDatabase(pool);
  store = createRepoPilotStore(pool, { retryBaseMs: 5 });
});

const FILES = { "package.json": PKG, "package-lock.json": "{}", "src/index.js": INDEX };

/** Run to ready_for_review, authorise, and return a PR-capable orchestrator pointed at `prGh`. */
async function authorised({ sandbox, prSpec = {}, config = loadRepoPilotConfig({}), mutate } = {}) {
  const runner = sandbox ?? fakeSandbox({ script: (i) => exited(i.arm === "control" ? 1 : 0) }).runner;
  const fx = await verifyingRun({ store, evidence: ev.evidence, files: FILES, config, extraHandlers: () => ({ verify: createVerifyHandler({ store, evidence: ev.evidence, config, sandbox: runner }) }) });

  await fx.orchestrator.processJob({ runId: fx.run.id, stage: "verify", attempt: 1 });

  const outcome = (await store.listOutcomes(OWNER, fx.run.id))[0].outcome;
  const request = { patchId: fx.patch.id, diffSha256: patchDigest(GOOD_DIFF, GOOD_TEST), baseCommitSha: SHA, outcome, confirm: true };
  const { pullRequest } = await store.authorizePullRequest({ owner: OWNER, runId: fx.run.id, actor: USER, request });

  await mutate?.(fx);

  const gh = createFakeGithub({ owner: REPO.owner, name: REPO.name, defaultBranch: "main", branches: { main: SHA }, commits: { [SHA]: FILES }, ...prSpec });
  const github = createGithubClient({ token: GH_TOKEN, fetch: gh.fetch, timeoutMs: 1000 });
  const { createOrchestrator } = await import("../../dist/src/repopilot/orchestrator.js");
  const orchestrator = createOrchestrator({ store, enqueue: async () => {}, workerId: "pr-1", handlers: { pr: createPrHandler({ store, github, evidence: ev.evidence, config }) } });

  return { ...fx, gh, pullRequest, orchestrator, request, runPr: () => orchestrator.processJob({ runId: fx.run.id, stage: "pr", attempt: 1 }) };
}

test("an authorised patch becomes a branch from the ANALYSED commit and a draft PR, never merged", { skip: skipPg }, async () => {
  const fx = await authorised();
  const result = await fx.runPr();

  assert.deepEqual(result, { status: "completed", runState: "pr_opened" });

  const pr = await store.getPullRequest(OWNER, fx.run.id);
  assert.equal(pr.state, "opened");
  assert.equal(pr.prNumber, 1);
  assert.equal(pr.prUrl, "https://github.com/acme/widgets/pull/1");
  assert.match(pr.headSha, /^[0-9a-f]{40}$/);

  // GitHub side
  const [pull] = fx.gh.pulls;
  assert.equal(pull.draft, true);
  assert.equal(pull.body.base, "main");
  assert.match(pull.body.head, /^repopilot\/run-\d+-patch-\d+-[0-9a-f]{8}$/);
  assert.equal(pull.body.head, fx.pullRequest.branchName);
  assert.match(pull.body.body, /RepoPilot never merges/);
  assert.match(pull.body.body, /\*\*Outcome: improved\*\*/);
  assert.match(pull.body.body, new RegExp(`sha256:${patchDigest(GOOD_DIFF, GOOD_TEST)}`));

  const [commit] = [...fx.gh.madeCommits.values()];
  assert.deepEqual(commit.parents, [SHA], "based on the analysed commit");

  const tree = [...fx.gh.trees.values()][0];
  assert.deepEqual(tree.tree.map((e) => e.path).sort(), ["src/index.js", "test/new.test.js"]);
  assert.ok(tree.tree.every((e) => e.mode === "100644" && e.type === "blob"));
  assert.equal(fx.gh.blobs.size >= 2, true);

  assert.equal((await store.getRun(OWNER, fx.run.id)).state, "pr_opened");
  assert.ok((await store.listAudit(OWNER, fx.run.id)).some((e) => e.event === "pr_opened"));
});

test("RepoPilot only ever writes to its own branch and has no merge or default-branch push", { skip: skipPg }, async () => {
  const fx = await authorised();

  await fx.runPr();

  const writes = fx.gh.writes.map((w) => `${w.method} ${w.path.replace(/^\/repos\/acme\/widgets/, "")}`);

  assert.ok(writes.every((w) => /^(POST) \/(git\/(blobs|trees|commits|refs)|pulls)$/.test(w)), writes.join("\n"));
  assert.ok(!writes.some((w) => /merge|PUT|PATCH|DELETE/i.test(w)));

  const ref = fx.gh.writes.find((w) => w.path.endsWith("/git/refs")).body;
  assert.match(ref.ref, /^refs\/heads\/repopilot\//);
  assert.notEqual(ref.ref, "refs/heads/main");
  assert.equal(fx.gh.refs.get("main"), SHA, "the default branch was not touched");
  assert.ok(fx.gh.requests.every((r) => r.redirect === "error" && r.host === "api.github.com"));
});

test("the PR can be non-draft only when the operator explicitly configures it", { skip: skipPg }, async () => {
  const fx = await authorised({ config: loadRepoPilotConfig({ REPOPILOT_PR_DRAFT: "false" }) });

  await fx.runPr();
  assert.equal(fx.gh.pulls[0].draft, false);
});

test("an inconclusive outcome is shown plainly in the PR instead of being dressed up", { skip: skipPg }, async () => {
  const fx = await authorised({ sandbox: createSandboxRunner("off") });

  assert.equal((await fx.runPr()).status, "completed");
  assert.match(fx.gh.pulls[0].body.body, /\*\*Outcome: inconclusive\*\*/);
  assert.match(fx.gh.pulls[0].body.body, /No sandbox verification was run for this patch/);
});

test("a duplicate job cannot open a second PR", { skip: skipPg }, async () => {
  const fx = await authorised();

  assert.equal((await fx.runPr()).status, "completed");
  assert.deepEqual(await fx.runPr(), { status: "skipped", reason: "run_finished" });
  assert.equal(fx.gh.pulls.length, 1);
  assert.equal(fx.gh.writes.filter((w) => w.path.endsWith("/pulls")).length, 1);
});

test("concurrent PR jobs create exactly one branch and one PR", { skip: skipPg }, async () => {
  const fx = await authorised();
  const results = await Promise.all([fx.runPr(), fx.runPr(), fx.runPr(), fx.runPr()]);

  assert.equal(results.filter((r) => r.status === "completed").length, 1);
  assert.equal(fx.gh.pulls.length, 1);
  assert.equal(fx.gh.writes.filter((w) => w.path.endsWith("/git/refs")).length, 1);
});

test("an existing PR for the authorised branch is adopted, not duplicated", { skip: skipPg }, async () => {
  const first = await authorised();

  await first.runPr();

  // A second authorisation record for the same branch, as after a crash that lost the DB update.
  await pool.query("UPDATE rp_pull_requests SET state = 'authorized', pr_number = NULL, pr_url = NULL, head_sha = NULL");
  await pool.query("UPDATE rp_runs SET state = 'pr_authorized', finished_at = NULL");
  await pool.query("DELETE FROM rp_stages WHERE stage = 'pr'");

  const writesBefore = first.gh.writes.length;
  const retry = await first.runPr();

  assert.equal(retry.status, "completed");
  assert.equal(first.gh.writes.length, writesBefore, "nothing new was written to GitHub");
  assert.equal(first.gh.pulls.length, 1);
  assert.equal((await store.getPullRequest(OWNER, first.run.id)).prNumber, 1);
});

test("authorisation is re-validated at the moment of creation", { skip: skipPg }, async () => {
  const cases = [
    ["the patch bytes were altered", async (fx) => { await pool.query("ALTER TABLE rp_patches DISABLE TRIGGER rp_patch_immutable"); await pool.query("UPDATE rp_patches SET diff = diff || E'\\n' WHERE id = $1", [fx.patch.id]); await pool.query("ALTER TABLE rp_patches ENABLE TRIGGER rp_patch_immutable"); }, "authorization_mismatch"],
    ["the outcome changed", async (fx) => { await pool.query("UPDATE rp_outcomes SET outcome = 'regressed' WHERE patch_id = $1", [fx.patch.id]); }, "authorization_mismatch"],
    ["the authorised digest was swapped", async () => { await pool.query("UPDATE rp_pull_requests SET authorized_diff_sha256 = repeat('0', 64)"); }, "authorization_mismatch"],
    ["the branch name is outside repopilot/", async () => { await pool.query("UPDATE rp_pull_requests SET branch_name = 'main'"); }, "authorization_mismatch"],
    ["the base branch recorded differs", async () => { await pool.query("UPDATE rp_pull_requests SET base_branch = 'release'"); }, "authorization_mismatch"],
  ];

  for (const [label, mutate, code] of cases) {
    await resetDatabase(pool);
    const fx = await authorised({ mutate });

    assert.deepEqual(await fx.runPr(), { status: "failed", code }, label);
    assert.equal(fx.gh.writes.length, 0, `${label}: nothing may be written to GitHub`);
    assert.equal((await store.getPullRequest(OWNER, fx.run.id)).state, "failed", label);
    assert.equal((await store.getRun(OWNER, fx.run.id)).state, "failed", label);
  }
});

test("a base branch that moved onto the patched files stops the PR; unrelated movement only warns", { skip: skipPg }, async () => {
  const moved = "d".repeat(40);
  const conflict = await authorised({ prSpec: { branches: { main: moved }, commits: { [SHA]: FILES, [moved]: FILES }, moved: { sha: moved, aheadBy: 3, files: ["src/index.js"] } } });

  assert.deepEqual(await conflict.runPr(), { status: "failed", code: "base_moved_conflict" });
  assert.equal(conflict.gh.writes.length, 0);
  assert.match((await store.getRun(OWNER, conflict.run.id)).failureDetail, /Run a new analysis/);

  await resetDatabase(pool);
  const harmless = await authorised({ prSpec: { branches: { main: moved }, commits: { [SHA]: FILES, [moved]: FILES }, moved: { sha: moved, aheadBy: 3, files: ["README.md"] } } });

  assert.equal((await harmless.runPr()).status, "completed");
  assert.match(harmless.gh.pulls[0].body.body, /`main` has moved 3 commit\(s\) since analysis/);
  assert.deepEqual([...harmless.gh.madeCommits.values()][0].parents, [SHA], "still based on the analysed commit");
});

test("a pre-existing branch with different content is never overwritten or adopted", { skip: skipPg }, async () => {
  const fx = await authorised();

  fx.gh.refs.set(fx.pullRequest.branchName, "e".repeat(40));

  assert.deepEqual(await fx.runPr(), { status: "failed", code: "branch_conflict" });
  assert.equal(fx.gh.pulls.length, 0);
  assert.equal(fx.gh.refs.get(fx.pullRequest.branchName), "e".repeat(40));
});

test("GitHub failures give actionable errors, mark the PR failed, and are not retried", { skip: skipPg }, async () => {
  for (const [needle, status, code] of [["/git/refs", 403, "github_forbidden"], ["/pulls", 422, "invalid_ref"], ["/git/blobs", 401, "github_auth_failed"], ["/git/commits", 502, "github_unavailable"]]) {
    await resetDatabase(pool);
    const fx = await authorised();

    fx.gh.fail.set(needle, { status });
    const result = await fx.runPr();

    assert.deepEqual(result, { status: "failed", code }, needle);
    assert.equal((await store.getPullRequest(OWNER, fx.run.id)).errorCode, code);
    assert.equal(fx.gh.pulls.length, 0, needle);
    assert.equal((await store.listStages(OWNER, fx.run.id)).filter((s) => s.stage === "pr").length, 1, "never retried automatically");
  }
});

test("without a GitHub token no pull request is attempted and the fix is named", { skip: skipPg }, async () => {
  const fx = await authorised();
  const { createOrchestrator } = await import("../../dist/src/repopilot/orchestrator.js");
  const orchestrator = createOrchestrator({ store, enqueue: async () => {}, workerId: "pr-2", handlers: { pr: createPrHandler({ store, github: null, evidence: ev.evidence, config: loadRepoPilotConfig({}) }) } });

  assert.deepEqual(await orchestrator.processJob({ runId: fx.run.id, stage: "pr", attempt: 1 }), { status: "failed", code: "github_not_configured" });
  assert.match((await store.getRun(OWNER, fx.run.id)).failureDetail, /REPOPILOT_GITHUB_TOKEN/);
});

test("the GitHub token and AI key never appear in the PR, its commit, or the stored records", { skip: skipPg }, async () => {
  const fx = await authorised();

  await fx.runPr();

  const everything = JSON.stringify([fx.gh.writes, fx.gh.pulls, [...fx.gh.madeCommits.values()]]) + JSON.stringify((await pool.query("SELECT * FROM rp_pull_requests")).rows) + JSON.stringify((await pool.query("SELECT * FROM rp_audit_events")).rows);

  assert.ok(!everything.includes(GH_TOKEN) && !everything.includes("integrationKeyValue"));
});

test("a run that was never authorised cannot reach the PR stage", { skip: skipPg }, async () => {
  const fx = await verifyingRun({ store, evidence: ev.evidence, files: FILES });
  const gh = createFakeGithub({ owner: "acme", name: "widgets", branches: { main: SHA }, commits: { [SHA]: FILES } });
  const { createOrchestrator } = await import("../../dist/src/repopilot/orchestrator.js");
  const orchestrator = createOrchestrator({ store, enqueue: async () => {}, workerId: "pr-3", handlers: { pr: createPrHandler({ store, github: createGithubClient({ token: GH_TOKEN, fetch: gh.fetch }), evidence: ev.evidence, config: loadRepoPilotConfig({}) }) } });

  assert.deepEqual(await orchestrator.processJob({ runId: fx.run.id, stage: "pr", attempt: 1 }), { status: "skipped", reason: "wrong_state" });
  assert.equal(gh.writes.length, 0);
});
