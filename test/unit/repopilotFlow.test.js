import { test } from "node:test";
import assert from "node:assert/strict";

import { STAGE_FLOW, latestAttempt, nextStageToQueue, retryDelayMs } from "../../dist/src/repopilot/flow.js";
import { MAX_STAGE_ATTEMPTS, STAGES, canTransitionRun } from "../../dist/src/repopilot/states.js";
import { StageJobSchema, bullEnqueue, stageJobId } from "../../dist/src/repopilot/queue.js";

test("every stage flow is a legal path through the run state machine", () => {
  for (const stage of STAGES) {
    const flow = STAGE_FLOW[stage];

    if (flow.from !== flow.working) assert.ok(canTransitionRun(flow.from, flow.working, "system"), `${stage}: from -> working`);
    if (flow.working !== flow.success) assert.ok(canTransitionRun(flow.working, flow.success, "system"), `${stage}: working -> success`);
    if (flow.rejected && flow.rejected !== flow.working) assert.ok(canTransitionRun(flow.working, flow.rejected, "system"), `${stage}: working -> rejected`);
  }
});

test("only the pull-request stage ends in pr_opened, and it starts from a user authorisation", () => {
  assert.equal(STAGE_FLOW.pr.from, "pr_authorized");
  assert.equal(STAGE_FLOW.pr.success, "pr_opened");

  for (const stage of STAGES.filter((s) => s !== "pr")) {
    assert.notEqual(STAGE_FLOW[stage].success, "pr_opened");
    assert.notEqual(STAGE_FLOW[stage].success, "pr_authorized");
  }
});

test("human gates have no automatic follow-up", () => {
  assert.equal(STAGE_FLOW.analyze.next, null, "a human chooses the finding to patch");
  assert.equal(STAGE_FLOW.verify.next, null, "a human reviews before any PR");
  assert.equal(STAGE_FLOW.pr.next, null);
  assert.equal(STAGE_FLOW.patch.rejected, "awaiting_patch");
});

test("recovery queues only the step a run is actually waiting on", () => {
  const rec = (stage, attempt, state) => ({ stage, attempt, state });

  assert.deepEqual(nextStageToQueue("queued", []), { stage: "ingest", attempt: 1 });
  assert.deepEqual(nextStageToQueue("ingesting", [rec("ingest", 1, "succeeded")]), { stage: "manifest", attempt: 1 });
  assert.deepEqual(nextStageToQueue("ingesting", [rec("ingest", 1, "failed")]), { stage: "ingest", attempt: 2 });
  assert.deepEqual(nextStageToQueue("analyzing", [rec("ingest", 1, "succeeded"), rec("manifest", 1, "succeeded")]), { stage: "analyze", attempt: 1 });
  assert.deepEqual(nextStageToQueue("verifying", []), { stage: "verify", attempt: 1 });
  assert.deepEqual(nextStageToQueue("pr_authorized", []), { stage: "pr", attempt: 1 });
});

test("recovery never auto-advances waiting, finished, running or exhausted runs", () => {
  for (const state of ["awaiting_patch", "ready_for_review", "pr_opened", "failed", "cancelled"]) {
    assert.equal(nextStageToQueue(state, []), null, state);
  }

  assert.equal(nextStageToQueue("queued", [{ stage: "ingest", attempt: 1, state: "running" }]), null);
  assert.equal(nextStageToQueue("ingesting", [{ stage: "ingest", attempt: MAX_STAGE_ATTEMPTS.ingest, state: "failed" }]), null);
  // PR creation is never retried automatically.
  assert.equal(nextStageToQueue("pr_authorized", [{ stage: "pr", attempt: 1, state: "failed" }]), null);
});

test("latestAttempt picks the highest attempt of the requested stage", () => {
  const stages = [{ stage: "ingest", attempt: 1, state: "failed" }, { stage: "ingest", attempt: 2, state: "running" }, { stage: "patch", attempt: 5, state: "failed" }];

  assert.equal(latestAttempt(stages, "ingest").attempt, 2);
  assert.equal(latestAttempt(stages, "verify"), null);
});

test("retry backoff doubles, is capped, and rejects bad input", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => retryDelayMs(n)), [5000, 10000, 20000, 40000, 80000, 120000]);
  assert.equal(retryDelayMs(30), 120000);
  assert.equal(retryDelayMs(2, 10), 20);
  for (const bad of [0, -1, 1.5, NaN]) assert.throws(() => retryDelayMs(bad), TypeError);
});

// ------------------------------------------------------------- queue contract

test("job payloads carry identifiers only and reject anything else", () => {
  assert.deepEqual(StageJobSchema.parse({ runId: 3, stage: "patch", attempt: 1, findingId: 9 }), { runId: 3, stage: "patch", attempt: 1, findingId: 9 });

  for (const extra of [{ githubToken: "ghp_x" }, { apiKey: "sk-ant-x" }, { repoUrl: "https://github.com/a/b" }, { source: "code" }, { prompt: "p" }]) {
    assert.equal(StageJobSchema.safeParse({ runId: 3, stage: "ingest", attempt: 1, ...extra }).success, false, JSON.stringify(extra));
  }

  for (const bad of [{ runId: 0 }, { runId: 1.5 }, { runId: "1" }, { stage: "merge" }, { attempt: 0 }, { attempt: 11 }, { findingId: -1 }]) {
    assert.equal(StageJobSchema.safeParse({ runId: 3, stage: "ingest", attempt: 1, ...bad }).success, false, JSON.stringify(bad));
  }
});

test("job ids are deterministic and BullMQ-safe", () => {
  assert.equal(stageJobId({ runId: 12, stage: "verify", attempt: 2 }), "rp-12-verify-2");
  assert.doesNotMatch(stageJobId({ runId: 12, stage: "verify", attempt: 2 }), /:/);
});

test("enqueue uses the deterministic id, one BullMQ attempt, and retains failures", async () => {
  const added = [];
  const enqueue = bullEnqueue({ add: async (...args) => void added.push(args) });

  await enqueue({ runId: 4, stage: "analyze", attempt: 1 }, { delayMs: 250 });

  const [name, data, options] = added[0];
  assert.equal(name, "analyze");
  assert.deepEqual(data, { runId: 4, stage: "analyze", attempt: 1 });
  assert.equal(options.jobId, "rp-4-analyze-1");
  assert.equal(options.attempts, 1);
  assert.equal(options.delay, 250);
  assert.ok(options.removeOnFail.age > options.removeOnComplete.age, "failed jobs are kept longer as the dead-letter record");

  await assert.rejects(() => enqueue({ runId: 4, stage: "analyze", attempt: 1, githubToken: "ghp_x" }));
  assert.equal(added.length, 1);
});
