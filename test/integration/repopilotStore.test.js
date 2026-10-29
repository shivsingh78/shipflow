// REAL PostgreSQL. Skipped (and reported as skipped) without REPOPILOT_TEST_PG.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { createRepoPilotStore, RepoPilotError } from "../../dist/src/repopilot/store.js";
import { createOrchestrator, StageError } from "../../dist/src/repopilot/orchestrator.js";
import { patchDigest } from "../../dist/src/repopilot/patch.js";
import { SHA, REPO, addTestDiff, fakeQueue, finding, modifyDiff, openDatabase, proposal, resetDatabase, skipPg } from "./helpers.js";

const OWNER = "instance";
const OTHER = "someone-else";
const USER = "user:alice";

let pool;
let store;

before(async () => {
  if (skipPg) return;
  pool = await openDatabase();
});

after(async () => {
  await pool?.end();
});

beforeEach(async () => {
  if (skipPg) return;
  await resetDatabase(pool);
  store = createRepoPilotStore(pool, { maxActiveRuns: 3, retryBaseMs: 10 });
});

const newRun = async (key) => (await store.createRun({ owner: OWNER, actor: USER, repo: REPO, idempotencyKey: key })).run;

function orchestrate(handlers, queue = fakeQueue()) {
  const orchestrator = createOrchestrator({ store, enqueue: queue.enqueue, handlers, workerId: "test-1", heartbeatMs: 50, cancelPollMs: 20 });

  return { orchestrator, queue };
}

/** Drive a run to `ready_for_review` with a valid patch and given verification runs. */
async function reviewableRun({ baseline, patched, control } = {}) {
  const run = await newRun();
  const { orchestrator } = orchestrate({
    ingest: async () => ({ persist: (tx) => tx.setRunFacts({ commitSha: SHA, defaultBranch: "main" }) }),
    manifest: async () => ({}),
    analyze: async () => ({ persist: (tx) => tx.insertFindings([finding()]) }),
  });

  await orchestrator.processJob({ runId: run.id, stage: "ingest", attempt: 1 });
  await orchestrator.processJob({ runId: run.id, stage: "manifest", attempt: 1 });
  await orchestrator.processJob({ runId: run.id, stage: "analyze", attempt: 1 });

  const [found] = await store.listFindings(OWNER, run.id);
  let patchId;
  const patchRun = orchestrate({
    patch: async () => ({
      persist: async (tx) => {
        const { patch, validation } = await tx.insertPatch(found.id, proposal());
        patchId = patch.id;

        return validation.ok ? {} : { rejected: true };
      },
    }),
  });

  await patchRun.orchestrator.processJob({ runId: run.id, stage: "patch", attempt: 1, findingId: found.id });
  assert.equal((await store.getRun(OWNER, run.id)).state, "verifying");

  const exited = (code) => ({ kind: "exited", exitCode: code, durationMs: 5 });
  const arms = { baseline: baseline ?? [exited(0), exited(0)], patched: patched ?? [exited(0), exited(0)], control: control ?? [exited(1), exited(1)] };

  for (const [arm, runs] of Object.entries(arms)) {
    for (const [index, record] of runs.entries()) {
      await store.recordVerification({ runId: run.id, patchId, arm, attempt: index + 1, run: record, testCommand: "npm test", environmentProfile: { runtime: "test" } });
    }
  }

  const verify = orchestrate({ verify: async () => ({ persist: (tx) => tx.computeOutcome(patchId) }) });

  await verify.orchestrator.processJob({ runId: run.id, stage: "verify", attempt: 1 });

  return { run, patchId, found };
}

// ------------------------------------------------------------------- runs

test("creating a run is audited, idempotent per key, and quota-limited", { skip: skipPg }, async () => {
  const first = await store.createRun({ owner: OWNER, actor: USER, repo: REPO, idempotencyKey: "k1" });
  const again = await store.createRun({ owner: OWNER, actor: USER, repo: REPO, idempotencyKey: "k1" });

  assert.equal(first.created, true);
  assert.equal(again.created, false);
  assert.equal(again.run.id, first.run.id);
  assert.equal(first.run.state, "queued");

  await store.createRun({ owner: OWNER, actor: USER, repo: REPO });
  await store.createRun({ owner: OWNER, actor: USER, repo: REPO });
  await assert.rejects(() => store.createRun({ owner: OWNER, actor: USER, repo: REPO }), (e) => e instanceof RepoPilotError && e.code === "quota");

  // Another owner has their own quota.
  assert.ok((await store.createRun({ owner: OTHER, actor: USER, repo: REPO })).created);

  const audit = await store.listAudit(OWNER, first.run.id);
  assert.deepEqual(audit.map((e) => e.event), ["run_created"]);
  assert.equal(audit[0].actor, USER);
});

test("concurrent creates cannot exceed the active-run quota", { skip: skipPg }, async () => {
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => store.createRun({ owner: OWNER, actor: USER, repo: REPO })));

  assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
  assert.equal(results.filter((r) => r.status === "rejected" && r.reason.code === "quota").length, 5);
});

test("only a user can create runs; there is no model or anonymous actor", { skip: skipPg }, async () => {
  for (const actor of ["system", "worker:w1", "model", "user:", "user:a b", "", "Alice"]) {
    await assert.rejects(() => store.createRun({ owner: OWNER, actor, repo: REPO }), (e) => e instanceof RepoPilotError && e.code === "invalid_actor", actor);
  }
});

test("runs are invisible to other owners across every read and cancel", { skip: skipPg }, async () => {
  const run = await newRun();

  assert.equal(await store.getRun(OTHER, run.id), null);
  assert.deepEqual(await store.listRuns(OTHER), []);
  assert.deepEqual(await store.listStages(OTHER, run.id), []);
  assert.deepEqual(await store.listFindings(OTHER, run.id), []);
  assert.deepEqual(await store.listPatches(OTHER, run.id), []);
  assert.deepEqual(await store.listAudit(OTHER, run.id), []);
  assert.deepEqual(await store.listLogs(OTHER, run.id), []);
  assert.equal(await store.getPullRequest(OTHER, run.id), null);
  await assert.rejects(() => store.requestCancel(OTHER, run.id, "user:mallory"), (e) => e.code === "not_found");
  await assert.rejects(() => store.authorizePullRequest({ owner: OTHER, runId: run.id, actor: "user:mallory", request: {} }), Error);
  assert.equal((await store.getRun(OWNER, run.id)).state, "queued");
});

test("repository authorisation is per owner, case-insensitive and audited", { skip: skipPg }, async () => {
  assert.equal(await store.isRepositoryAuthorized(OWNER, { owner: "acme", name: "widgets" }), false);
  await store.authorizeRepository(OWNER, USER, REPO);
  assert.equal(await store.isRepositoryAuthorized(OWNER, { owner: "ACME", name: "Widgets" }), true);
  assert.equal(await store.isRepositoryAuthorized(OTHER, { owner: "acme", name: "widgets" }), false);
  await assert.rejects(() => store.authorizeRepository(OWNER, "system", REPO), (e) => e.code === "invalid_actor");
  assert.equal(await store.revokeRepository(OWNER, USER, REPO), true);
  assert.equal(await store.isRepositoryAuthorized(OWNER, REPO), false);
  assert.equal((await store.verifyAuditChain(`owner:${OWNER}`)).ok, true);
});

// ------------------------------------------------------ stage orchestration

test("a run advances ingest -> manifest -> analyze atomically and queues follow-ups", { skip: skipPg }, async () => {
  const run = await newRun();
  const { orchestrator, queue } = orchestrate({
    ingest: async () => ({ persist: (tx) => tx.setRunFacts({ commitSha: SHA, defaultBranch: "main" }) }),
    manifest: async () => ({}),
    analyze: async () => ({ persist: (tx) => tx.insertFindings([finding(), finding({ title: "Second", file: "lib/x.js" }), finding()]) }),
  });

  assert.deepEqual(await orchestrator.processJob({ runId: run.id, stage: "ingest", attempt: 1 }), { status: "completed", runState: "ingesting" });
  assert.deepEqual(queue.jobs.at(-1).job, { runId: run.id, stage: "manifest", attempt: 1 });
  assert.deepEqual(await orchestrator.processJob({ runId: run.id, stage: "manifest", attempt: 1 }), { status: "completed", runState: "analyzing" });
  assert.deepEqual(await orchestrator.processJob({ runId: run.id, stage: "analyze", attempt: 1 }), { status: "completed", runState: "awaiting_patch" });

  const after = await store.getRun(OWNER, run.id);
  assert.equal(after.commitSha, SHA);
  assert.equal(after.defaultBranch, "main");
  // The duplicate finding was dropped by fingerprint and ranks are contiguous.
  assert.deepEqual((await store.listFindings(OWNER, run.id)).map((f) => f.rank), [1, 2]);
  assert.equal(queue.jobs.length, 2, "analyze queues nothing: a human picks a finding");
  assert.equal((await store.verifyAuditChain(`run:${run.id}`)).ok, true);
});

test("a stage's results and the state change commit together or not at all", { skip: skipPg }, async () => {
  const run = await newRun();
  const { orchestrator } = orchestrate({
    ingest: async () => ({
      persist: async (tx) => {
        await tx.setRunFacts({ commitSha: SHA });
        throw new StageError("boom", "persist failed after writing facts", false);
      },
    }),
  });

  const result = await orchestrator.processJob({ runId: run.id, stage: "ingest", attempt: 1 });
  assert.equal(result.status, "failed");

  const after = await store.getRun(OWNER, run.id);
  assert.equal(after.commitSha, null, "the partial write was rolled back");
  assert.equal(after.state, "failed");
  assert.equal(after.failureCode, "boom");
});

test("a duplicate delivery of the same attempt runs the handler once", { skip: skipPg }, async () => {
  const run = await newRun();
  let calls = 0;
  const { orchestrator } = orchestrate({
    ingest: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 100));
    },
  });

  const results = await Promise.all(Array.from({ length: 6 }, () => orchestrator.processJob({ runId: run.id, stage: "ingest", attempt: 1 })));

  assert.equal(calls, 1);
  assert.equal(results.filter((r) => r.status === "completed").length, 1);
  assert.ok(results.filter((r) => r.status === "skipped").every((r) => ["duplicate", "out_of_order"].includes(r.reason)));

  // A late redelivery after completion is also a no-op.
  assert.equal((await orchestrator.processJob({ runId: run.id, stage: "ingest", attempt: 1 })).status, "skipped");
  assert.equal(calls, 1);
});

test("stages cannot run out of order or against the wrong run state", { skip: skipPg }, async () => {
  const run = await newRun();
  const { orchestrator } = orchestrate({ analyze: async () => ({}), verify: async () => ({}), pr: async () => ({}) });

  for (const stage of ["analyze", "verify", "pr"]) {
    assert.deepEqual(await orchestrator.processJob({ runId: run.id, stage, attempt: 1 }), { status: "skipped", reason: "wrong_state" }, stage);
  }

  assert.deepEqual(await orchestrator.processJob({ runId: run.id, stage: "ingest", attempt: 3 }), { status: "skipped", reason: "out_of_order" });
  assert.equal((await store.getRun(OWNER, run.id)).state, "queued");
});

test("malformed or secret-carrying job payloads are rejected before any work", { skip: skipPg }, async () => {
  const { orchestrator } = orchestrate({ ingest: async () => assert.fail("must not run") });

  for (const payload of [null, {}, { runId: 1, stage: "ingest" }, { runId: -1, stage: "ingest", attempt: 1 }, { runId: 1, stage: "deploy", attempt: 1 }, { runId: 1, stage: "ingest", attempt: 1, githubToken: "ghp_x" }, "x"]) {
    assert.deepEqual(await orchestrator.processJob(payload), { status: "invalid_job" });
  }
});

test("retryable failures retry with growing backoff until the budget is spent, then fail the run", { skip: skipPg }, async () => {
  const run = await newRun();
  const { orchestrator, queue } = orchestrate({
    ingest: async () => {
      throw new StageError("rate_limited", "GitHub said slow down", true);
    },
  });

  const first = await orchestrator.processJob({ runId: run.id, stage: "ingest", attempt: 1 });
  assert.deepEqual(first, { status: "retry_scheduled", attempt: 2, delayMs: 10 });
  assert.deepEqual(queue.jobs.at(-1), { job: { runId: run.id, stage: "ingest", attempt: 2 }, delayMs: 10 });

  const second = await orchestrator.processJob({ runId: run.id, stage: "ingest", attempt: 2 });
  assert.deepEqual(second, { status: "retry_scheduled", attempt: 3, delayMs: 20 });

  // attempt 3 is the last allowed for ingest
  const third = await orchestrator.processJob({ runId: run.id, stage: "ingest", attempt: 3 });
  assert.deepEqual(third, { status: "failed", code: "rate_limited" });
  assert.equal((await store.getRun(OWNER, run.id)).state, "failed");

  // Nothing further can run.
  assert.deepEqual(await orchestrator.processJob({ runId: run.id, stage: "ingest", attempt: 4 }), { status: "skipped", reason: "run_finished" });
  const stages = await store.listStages(OWNER, run.id);
  assert.deepEqual(stages.map((s) => [s.attempt, s.state]), [[1, "failed"], [2, "failed"], [3, "failed"]]);
});

test("non-retryable failures fail the run immediately, with the detail redacted", { skip: skipPg }, async () => {
  const run = await newRun();
  const { orchestrator, queue } = orchestrate({
    ingest: async () => {
      throw new StageError("not_found", "clone of https://x:ghp_abcdefghijklmnopqrstuvwxyz123456@github.com/a/b failed with token ghp_abcdefghijklmnopqrstuvwxyz123456", false);
    },
  });

  assert.deepEqual(await orchestrator.processJob({ runId: run.id, stage: "ingest", attempt: 1 }), { status: "failed", code: "not_found" });
  assert.equal(queue.jobs.length, 0);

  const after = await store.getRun(OWNER, run.id);
  assert.doesNotMatch(after.failureDetail, /ghp_/);
  const stage = (await store.listStages(OWNER, run.id))[0];
  assert.doesNotMatch(stage.errorDetail, /ghp_/);
});

test("a missing handler fails the stage clearly instead of faking success", { skip: skipPg }, async () => {
  const run = await newRun();
  const { orchestrator } = orchestrate({});

  assert.deepEqual(await orchestrator.processJob({ runId: run.id, stage: "ingest", attempt: 1 }), { status: "failed", code: "stage_unavailable" });
  assert.equal((await store.getRun(OWNER, run.id)).failureCode, "stage_unavailable");
});

// ------------------------------------------------------------ cancellation

test("cancelling an idle run ends it immediately; a finished run cannot be cancelled", { skip: skipPg }, async () => {
  const run = await newRun();
  const { cancelledNow, run: cancelled } = await store.requestCancel(OWNER, run.id, USER);

  assert.equal(cancelledNow, true);
  assert.equal(cancelled.state, "cancelled");
  assert.ok(cancelled.finishedAt);
  await assert.rejects(() => store.requestCancel(OWNER, run.id, USER), (e) => e.code === "conflict");

  const { orchestrator } = orchestrate({ ingest: async () => assert.fail("must not run") });

  assert.deepEqual(await orchestrator.processJob({ runId: run.id, stage: "ingest", attempt: 1 }), { status: "skipped", reason: "run_finished" });
});

test("cancelling a working run stops it at the checkpoint and discards the stage's results", { skip: skipPg }, async () => {
  const run = await newRun();
  let observedAbort = false;
  const { orchestrator, queue } = orchestrate({
    ingest: async ({ signal }) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      const requested = await store.requestCancel(OWNER, run.id, USER);
      assert.equal(requested.cancelledNow, false);
      assert.equal(requested.run.cancelRequested, true);
      await new Promise((resolve) => setTimeout(resolve, 150));
      observedAbort = signal.aborted;

      return { persist: (tx) => tx.setRunFacts({ commitSha: SHA }) };
    },
  });

  const result = await orchestrator.processJob({ runId: run.id, stage: "ingest", attempt: 1 });

  assert.equal(result.status, "cancelled");
  assert.equal(observedAbort, true, "the handler's signal was aborted");
  assert.equal((await store.getRun(OWNER, run.id)).state, "cancelled");
  assert.equal((await store.getRun(OWNER, run.id)).commitSha, null);
  assert.equal(queue.jobs.length, 0, "no follow-up stage is queued");
});

// ---------------------------------------------------------------- recovery

test("a stage whose worker vanished is failed as interrupted and retried within budget", { skip: skipPg }, async () => {
  const run = await newRun();

  await store.beginStage({ runId: run.id, stage: "ingest", attempt: 1, worker: "worker:dead" });
  await pool.query("UPDATE rp_stages SET heartbeat_at = now() - interval '10 minutes'");

  const { orchestrator, queue } = orchestrate({});
  const summary = await orchestrator.recover({ staleAfterMs: 60_000, idleForMs: 60_000 });

  assert.deepEqual(summary, { interrupted: 1, requeued: 1 });
  assert.deepEqual(queue.jobs.at(-1).job, { runId: run.id, stage: "ingest", attempt: 2 });
  assert.equal((await store.listStages(OWNER, run.id))[0].errorCode, "interrupted");

  // A healthy, recent heartbeat is left alone.
  await store.beginStage({ runId: run.id, stage: "ingest", attempt: 2, worker: "worker:alive" });
  assert.deepEqual(await orchestrator.recover({ staleAfterMs: 60_000, idleForMs: 60_000 }), { interrupted: 0, requeued: 0 });
});

test("recovery stops retrying once the attempt budget is gone and fails the run", { skip: skipPg }, async () => {
  const run = await newRun();

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await store.beginStage({ runId: run.id, stage: "ingest", attempt, worker: "worker:dead" });
    await pool.query("UPDATE rp_stages SET heartbeat_at = now() - interval '10 minutes'");
    const recovered = await store.recoverStaleStages(60_000);
    assert.equal(recovered[0].result.kind, attempt < 3 ? "retry" : "failed");
  }

  assert.equal((await store.getRun(OWNER, run.id)).state, "failed");
  assert.equal((await store.getRun(OWNER, run.id)).failureCode, "interrupted");
});

test("a committed state change whose follow-up was never queued is re-queued", { skip: skipPg }, async () => {
  const queued = await newRun();
  const { orchestrator, queue } = orchestrate({});

  await pool.query("UPDATE rp_runs SET updated_at = now() - interval '10 minutes'");
  const summary = await orchestrator.recover({ staleAfterMs: 60_000, idleForMs: 60_000 });

  assert.equal(summary.requeued, 1);
  assert.deepEqual(queue.jobs.at(-1).job, { runId: queued.id, stage: "ingest", attempt: 1 });

  // Runs waiting for a human are never auto-advanced.
  await pool.query("UPDATE rp_runs SET state = 'awaiting_patch', updated_at = now() - interval '10 minutes'");
  assert.deepEqual(await orchestrator.recover({ staleAfterMs: 60_000, idleForMs: 60_000 }), { interrupted: 0, requeued: 0 });
});

// ------------------------------------------------- patches and verification

test("a policy-valid patch is stored immutably with its digest and our validator's verdict", { skip: skipPg }, async () => {
  const { patchId, found } = await reviewableRun();
  const [patch] = await store.listPatches(OWNER, 1);

  assert.equal(patch.id, patchId);
  assert.equal(patch.findingId, found.id);
  assert.equal(patch.baseCommit, SHA);
  assert.equal(patch.validationOk, true);
  assert.equal(patch.diffSha256, patchDigest(modifyDiff(), addTestDiff()));

  for (const sql of ["UPDATE rp_patches SET diff = 'x'", "UPDATE rp_patches SET test_diff = 'x'", "UPDATE rp_patches SET diff_sha256 = repeat('0', 64)", "UPDATE rp_patches SET base_commit = repeat('b', 40)"]) {
    await assert.rejects(() => pool.query(sql), (e) => e.code === "23000", sql);
  }
});

test("a rejected patch is preserved with its issues and the run returns to patch selection", { skip: skipPg }, async () => {
  const run = await newRun();
  const base = orchestrate({
    ingest: async () => ({ persist: (tx) => tx.setRunFacts({ commitSha: SHA, defaultBranch: "main" }) }),
    manifest: async () => ({}),
    analyze: async () => ({ persist: (tx) => tx.insertFindings([finding()]) }),
  });

  for (const stage of ["ingest", "manifest", "analyze"]) await base.orchestrator.processJob({ runId: run.id, stage, attempt: 1 });

  const [found] = await store.listFindings(OWNER, run.id);
  const bad = proposal({ diff: modifyDiff("package.json") });
  const { orchestrator, queue } = orchestrate({
    patch: async () => ({
      persist: async (tx) => {
        const { validation } = await tx.insertPatch(found.id, bad);

        return validation.ok ? {} : { rejected: true };
      },
    }),
  });

  const result = await orchestrator.processJob({ runId: run.id, stage: "patch", attempt: 1, findingId: found.id });

  assert.deepEqual(result, { status: "completed", runState: "awaiting_patch" });
  assert.equal(queue.jobs.length, 0, "an invalid patch is never verified");

  const [patch] = await store.listPatches(OWNER, run.id);
  assert.equal(patch.validationOk, false);
  assert.equal(patch.diff, bad.diff, "the original bytes are kept");
  assert.ok(patch.validation.issues.some((i) => i.code === "forbidden_path"));
  assert.equal(await store.latestValidPatch(run.id), null);
});

test("verification records only come from sandbox-shaped runs and only while verifying", { skip: skipPg }, async () => {
  const { run, patchId } = await reviewableRun();

  // run is ready_for_review now
  await assert.rejects(
    () => store.recordVerification({ runId: run.id, patchId, arm: "baseline", attempt: 9, run: { kind: "exited", exitCode: 0, durationMs: 1 }, testCommand: "npm test", environmentProfile: {} }),
    (e) => e.code === "conflict"
  );

  const fresh = await newRun();

  for (const forged of [{ kind: "exited", exitCode: 0, durationMs: 1, verified: true }, { kind: "passed" }, "pass", null, { outcome: "improved" }]) {
    await assert.rejects(() => store.recordVerification({ runId: fresh.id, patchId, arm: "patched", attempt: 1, run: forged, testCommand: "x", environmentProfile: {} }), undefined, JSON.stringify(forged));
  }
});

test("verification attempts are recorded once and the outcome is derived from them", { skip: skipPg }, async () => {
  const { run, patchId } = await reviewableRun();
  const [outcome] = await store.listOutcomes(OWNER, run.id);

  assert.equal(outcome.patchId, patchId);
  assert.equal(outcome.outcome, "improved");
  assert.deepEqual(outcome.reasons, []);

  const rows = await store.listVerifications(OWNER, run.id);
  assert.equal(rows.length, 6);
  assert.ok(rows.every((r) => r.commitSha === SHA && r.diffSha256 === patchDigest(modifyDiff(), addTestDiff()) && r.testCommand === "npm test"));
  assert.equal(await store.verifyAuditChain(`run:${run.id}`).then((r) => r.ok), true);
});

test("outcomes follow the classifier: regressions, flakiness, and timeouts are not 'improved'", { skip: skipPg }, async () => {
  const exited = (code) => ({ kind: "exited", exitCode: code, durationMs: 5 });
  const cases = [
    [{ patched: [exited(1), exited(1)] }, "regressed"],
    [{ patched: [exited(0), exited(1)] }, "inconclusive"],
    [{ patched: [{ kind: "timeout", durationMs: 9 }, exited(0)] }, "inconclusive"],
    [{ control: [exited(0), exited(0)] }, "inconclusive"],
  ];

  for (const [arms, expected] of cases) {
    await resetDatabase(pool);
    const { run } = await reviewableRun(arms);
    assert.equal((await store.listOutcomes(OWNER, run.id))[0].outcome, expected, JSON.stringify(arms));
  }
});

// ------------------------------------------------------------ authorisation

const authRequest = (patchId, overrides = {}) => ({
  patchId,
  diffSha256: patchDigest(modifyDiff(), addTestDiff()),
  baseCommitSha: SHA,
  outcome: "improved",
  confirm: true,
  ...overrides,
});

test("a user can authorise a PR bound to the exact reviewed patch, base and outcome", { skip: skipPg }, async () => {
  const { run, patchId } = await reviewableRun();
  const { run: after, pullRequest } = await store.authorizePullRequest({ owner: OWNER, runId: run.id, actor: USER, request: authRequest(patchId) });

  assert.equal(after.state, "pr_authorized");
  assert.equal(pullRequest.state, "authorized");
  assert.equal(pullRequest.authorizedBy, USER);
  assert.equal(pullRequest.authorizedDiffSha256, patchDigest(modifyDiff(), addTestDiff()));
  assert.match(pullRequest.branchName, /^repopilot\/run-\d+-patch-\d+-[0-9a-f]{8}$/);
  assert.equal(pullRequest.baseBranch, "main");

  const audit = (await store.listAudit(OWNER, run.id)).find((e) => e.event === "pr_authorized");
  assert.equal(audit.actor, USER);
  assert.equal(audit.detail.diffSha256, pullRequest.authorizedDiffSha256);
});

test("authorisation is rejected for any mismatch, a non-user, or an unreviewable state", { skip: skipPg }, async () => {
  const { run, patchId } = await reviewableRun();
  const attempt = (request, actor = USER, owner = OWNER) => store.authorizePullRequest({ owner, runId: run.id, actor, request });

  await assert.rejects(() => attempt(authRequest(patchId, { diffSha256: "0".repeat(64) })), (e) => e.code === "authorization_mismatch");
  await assert.rejects(() => attempt(authRequest(patchId, { baseCommitSha: "b".repeat(40) })), (e) => e.code === "authorization_mismatch");
  await assert.rejects(() => attempt(authRequest(patchId, { outcome: "unchanged" })), (e) => e.code === "authorization_mismatch");
  await assert.rejects(() => attempt(authRequest(patchId, { confirm: false })), Error);
  await assert.rejects(() => attempt(authRequest(patchId, { merge: true })), Error);
  await assert.rejects(() => attempt(authRequest(patchId + 99)), (e) => e.code === "not_found");
  await assert.rejects(() => attempt(authRequest(patchId), "system"), (e) => e.code === "invalid_actor");
  await assert.rejects(() => attempt(authRequest(patchId), "worker:w1"), (e) => e.code === "invalid_actor");
  await assert.rejects(() => attempt(authRequest(patchId), USER, OTHER), (e) => e.code === "not_found");

  assert.equal((await store.getRun(OWNER, run.id)).state, "ready_for_review", "no failed attempt changed anything");
  assert.equal(await store.getPullRequest(OWNER, run.id), null);
});

test("a regressed patch can never be authorised", { skip: skipPg }, async () => {
  const exited = (code) => ({ kind: "exited", exitCode: code, durationMs: 5 });
  const { run, patchId } = await reviewableRun({ patched: [exited(1), exited(1)] });

  await assert.rejects(
    () => store.authorizePullRequest({ owner: OWNER, runId: run.id, actor: USER, request: authRequest(patchId, { outcome: "regressed" }) }),
    (e) => e.code === "conflict"
  );
});

test("two simultaneous authorisations produce exactly one pull-request record", { skip: skipPg }, async () => {
  const { run, patchId } = await reviewableRun();
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => store.authorizePullRequest({ owner: OWNER, runId: run.id, actor: USER, request: authRequest(patchId) })));

  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM rp_pull_requests")).rows[0].n, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM rp_audit_events WHERE event = 'pr_authorized'")).rows[0].n, 1);
});

test("pull-request state only moves along guarded transitions", { skip: skipPg }, async () => {
  const { run, patchId } = await reviewableRun();

  await store.authorizePullRequest({ owner: OWNER, runId: run.id, actor: USER, request: authRequest(patchId) });

  const creating = await store.updatePullRequest({ runId: run.id, from: ["authorized"], to: "creating", actor: "worker:w1" });
  assert.equal(creating.state, "creating");
  assert.equal(await store.updatePullRequest({ runId: run.id, from: ["authorized"], to: "creating", actor: "worker:w2" }), null, "a second worker loses the race");

  const opened = await store.updatePullRequest({ runId: run.id, from: ["creating"], to: "opened", actor: "worker:w1", prNumber: 7, prUrl: "https://github.com/acme/widgets/pull/7", headSha: "c".repeat(40) });
  assert.equal(opened.prUrl, "https://github.com/acme/widgets/pull/7");
  assert.equal(await store.updatePullRequest({ runId: run.id, from: ["authorized", "creating"], to: "failed", actor: "worker:w1" }), null, "an opened PR cannot be marked failed");
});

// ------------------------------------------------------------------- audit

test("the audit log is append-only and its hash chain detects tampering", { skip: skipPg }, async () => {
  const run = await newRun();
  await store.requestCancel(OWNER, run.id, USER);
  const chain = `run:${run.id}`;

  assert.deepEqual(await store.verifyAuditChain(chain), { ok: true, events: 2, brokenAtId: null });
  await assert.rejects(() => pool.query("UPDATE rp_audit_events SET actor = 'user:evil'"), (e) => e.code === "23000");
  await assert.rejects(() => pool.query("DELETE FROM rp_audit_events"), (e) => e.code === "23000");

  // Only someone with table-owner rights can bypass the trigger; the chain still notices.
  await pool.query("ALTER TABLE rp_audit_events DISABLE TRIGGER rp_audit_immutable");
  await pool.query("UPDATE rp_audit_events SET actor = 'user:evil' WHERE id = (SELECT min(id) FROM rp_audit_events)");
  await pool.query("ALTER TABLE rp_audit_events ENABLE TRIGGER rp_audit_immutable");

  const broken = await store.verifyAuditChain(chain);
  assert.equal(broken.ok, false);
  assert.ok(broken.brokenAtId > 0);
});

test("audit details never contain credentials", { skip: skipPg }, async () => {
  const run = await newRun();

  await store.withTx((tx) => store.appendAudit(tx, {
    runId: run.id, owner: OWNER, actor: USER, event: "probe",
    detail: { apiKey: "sk-ant-abcdefghijklmnopqrstuvwxyz", note: "token ghp_abcdefghijklmnopqrstuvwxyz123456 used", nested: { password: "hunter2", ok: "fine" } },
  }));

  const probe = (await store.listAudit(OWNER, run.id)).find((e) => e.event === "probe");
  const text = JSON.stringify(probe.detail);

  assert.doesNotMatch(text, /sk-ant|ghp_|hunter2/);
  assert.match(text, /fine/);
});

test("run actions never accept a model-looking actor in the audit trail", { skip: skipPg }, async () => {
  const run = await newRun();

  await assert.rejects(() => store.withTx((tx) => store.appendAudit(tx, { runId: run.id, owner: OWNER, actor: "model:claude", event: "x" })), (e) => e.code === "invalid_actor");
});

// ------------------------------------------------------------ credentials

test("credentials expose metadata only and are audited without the secret", { skip: skipPg }, async () => {
  const sealed = "c2VhbGVkLWNpcGhlcnRleHQtbm90LWEtcmVhbC1rZXk=";

  await store.putCredential({ owner: OWNER, actor: USER, provider: "anthropic", ciphertext: sealed, fingerprint: "0123456789abcdef" });

  const listed = await store.listCredentials(OWNER);
  assert.deepEqual(Object.keys(listed[0]).sort(), ["fingerprint", "provider", "updatedAt"]);
  assert.equal(await store.readCredentialCiphertext(OWNER, "anthropic"), sealed);
  assert.equal(await store.readCredentialCiphertext(OTHER, "anthropic"), null);
  await assert.rejects(() => store.putCredential({ owner: OWNER, actor: "system", provider: "anthropic", ciphertext: sealed, fingerprint: "0123456789abcdef" }), (e) => e.code === "invalid_actor");
  await assert.rejects(() => store.putCredential({ owner: OWNER, actor: USER, provider: "x".repeat(30), ciphertext: sealed, fingerprint: "0123456789abcdef" }), (e) => e.code === "invalid_input");

  const events = await pool.query("SELECT detail FROM rp_audit_events WHERE event = 'credential_set'");
  assert.doesNotMatch(JSON.stringify(events.rows), new RegExp(sealed));
  assert.equal(await store.deleteCredential(OWNER, USER, "anthropic"), true);
});

// --------------------------------------------------------------- retention

test("evidence pruning removes logs and artifact rows of old finished runs but never audit, patches or outcomes", { skip: skipPg }, async () => {
  const { run } = await reviewableRun();

  await store.appendLog(run.id, "ingest", "INFO", "hello");
  await pool.query("INSERT INTO rp_artifacts (run_id, kind, object_key, bytes, sha256) VALUES ($1, 'manifest', 'repopilot/1/manifest.json', 10, repeat('a', 64))", [run.id]);

  assert.deepEqual(await store.pruneEvidence(30), { logRows: 0, artifactKeys: [] }, "unfinished runs are not pruned");

  await store.requestCancel(OWNER, run.id, USER);
  await pool.query("UPDATE rp_runs SET finished_at = now() - interval '40 days'");

  const pruned = await store.pruneEvidence(30);
  assert.equal(pruned.logRows, 1);
  assert.deepEqual(pruned.artifactKeys, ["repopilot/1/manifest.json"]);
  assert.equal((await store.listPatches(OWNER, run.id)).length, 1);
  assert.equal((await store.listOutcomes(OWNER, run.id)).length, 1);
  assert.ok((await store.listAudit(OWNER, run.id)).length > 0);
  await assert.rejects(() => store.pruneEvidence(0), (e) => e.code === "invalid_input");
});

test("run logs are redacted and bounded per run", { skip: skipPg }, async () => {
  const small = createRepoPilotStore(pool, { maxLogRows: 3 });
  const run = await newRun();

  for (let i = 0; i < 6; i += 1) await small.appendLog(run.id, "ingest", "INFO", `line ${i} Authorization: Bearer abcdefghijklmnop1234`);

  const logs = await small.listLogs(OWNER, run.id);
  assert.equal(logs.length, 3);
  assert.ok(logs.every((l) => !/abcdefghijklmnop1234/.test(l.message)));
});

test("database constraints reject impossible rows even if application checks are bypassed", { skip: skipPg }, async () => {
  const run = await newRun();
  const bad = [
    ["UPDATE rp_runs SET state = 'merged' WHERE id = $1", 23514],
    ["UPDATE rp_runs SET state = 'failed' WHERE id = $1", 23514],
    ["UPDATE rp_runs SET commit_sha = 'main' WHERE id = $1", 23514],
    ["INSERT INTO rp_stages (run_id, stage, attempt, idempotency_key) VALUES ($1, 'deploy', 1, 'k')", 23514],
    ["INSERT INTO rp_stages (run_id, stage, attempt, idempotency_key) VALUES ($1, 'ingest', 0, 'k')", 23514],
  ];

  for (const [sql, code] of bad) {
    await assert.rejects(() => pool.query(sql, [run.id]), (e) => e.code === String(code), sql);
  }
});
