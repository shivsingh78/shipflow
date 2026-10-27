import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RUN_STATES,
  STAGES,
  MAX_STAGE_ATTEMPTS,
  InvalidTransitionError,
  allowedRunTransitions,
  assertRunTransition,
  assertStageTransition,
  canRetryStage,
  canTransitionRun,
  canTransitionStage,
  isRunState,
  isTerminalRunState,
  stageIdempotencyKey,
} from "../../dist/src/repopilot/states.js";

const HAPPY_PATH = [
  "queued",
  "ingesting",
  "analyzing",
  "awaiting_patch",
  "patching",
  "verifying",
  "ready_for_review",
  "pr_authorized",
  "pr_opened",
];

test("the happy path is allowed step by step, with authorization by a user", () => {
  for (let i = 0; i < HAPPY_PATH.length - 1; i++) {
    const actor = HAPPY_PATH[i + 1] === "pr_authorized" ? "user" : "system";
    assert.equal(canTransitionRun(HAPPY_PATH[i], HAPPY_PATH[i + 1], actor), true, `${HAPPY_PATH[i]} -> ${HAPPY_PATH[i + 1]}`);
  }
});

test("pr_authorized can only be reached by a user, never by the system", () => {
  assert.equal(canTransitionRun("ready_for_review", "pr_authorized", "system"), false);
  assert.equal(canTransitionRun("ready_for_review", "pr_authorized"), false);
  assert.equal(canTransitionRun("ready_for_review", "pr_authorized", "user"), true);
  assert.throws(
    () => assertRunTransition("ready_for_review", "pr_authorized", "system"),
    (error) => error instanceof InvalidTransitionError && /explicit user authorization/.test(error.message)
  );
  assert.doesNotThrow(() => assertRunTransition("ready_for_review", "pr_authorized", "user"));
});

test("there is no way to a pull request without passing pr_authorized", () => {
  for (const from of RUN_STATES) {
    for (const actor of ["system", "user"]) {
      if (canTransitionRun(from, "pr_opened", actor)) {
        assert.equal(from, "pr_authorized");
      }
    }
  }
});

test("an unrecognised actor (such as a model) gets no user-only transitions", () => {
  assert.equal(canTransitionRun("ready_for_review", "pr_authorized", "model"), false);
  assert.equal(canTransitionRun("ready_for_review", "pr_authorized", "assistant"), false);
});

test("steps cannot be skipped", () => {
  const invalid = [
    ["queued", "analyzing"],
    ["queued", "verifying"],
    ["ingesting", "patching"],
    ["analyzing", "verifying"],
    ["awaiting_patch", "verifying"],
    ["patching", "ready_for_review"],
    ["verifying", "pr_authorized"],
    ["verifying", "pr_opened"],
    ["ready_for_review", "pr_opened"],
  ];

  for (const [from, to] of invalid) {
    assert.equal(canTransitionRun(from, to, "user"), false, `${from} -> ${to}`);
    assert.throws(() => assertRunTransition(from, to, "user"), InvalidTransitionError);
  }
});

test("terminal states have no way out", () => {
  for (const terminal of ["pr_opened", "failed", "cancelled"]) {
    assert.equal(isTerminalRunState(terminal), true);
    assert.deepEqual(allowedRunTransitions(terminal, "user"), []);
    assert.throws(
      () => assertRunTransition(terminal, "queued"),
      /already finished/
    );
  }
});

test("every non-terminal state can fail or be cancelled", () => {
  for (const state of RUN_STATES.filter((s) => !isTerminalRunState(s))) {
    assert.equal(canTransitionRun(state, "failed"), true, state);
    assert.equal(canTransitionRun(state, "cancelled"), true, state);
  }
});

test("a rejected patch or a reviewed run can return to awaiting_patch", () => {
  assert.equal(canTransitionRun("patching", "awaiting_patch"), true);
  assert.equal(canTransitionRun("ready_for_review", "awaiting_patch"), true);
});

test("unknown states are rejected rather than assumed", () => {
  assert.equal(isRunState("running"), false);
  assert.equal(isRunState(undefined), false);
  assert.equal(canTransitionRun("running", "queued"), false);
  assert.equal(canTransitionRun("queued", "bogus"), false);
  assert.throws(() => assertRunTransition("nope", "queued"), /unknown state/);
  assert.throws(() => assertRunTransition("queued", 5), InvalidTransitionError);
});

test("no state transitions to itself", () => {
  for (const state of RUN_STATES) {
    assert.equal(canTransitionRun(state, state, "user"), false, state);
  }
});

// ------------------------------------------------------------------ stages

test("stage lifecycle: pending -> running -> succeeded/failed", () => {
  assert.equal(canTransitionStage("analyze", "pending", "running"), true);
  assert.equal(canTransitionStage("analyze", "running", "succeeded"), true);
  assert.equal(canTransitionStage("analyze", "running", "failed"), true);
  assert.equal(canTransitionStage("analyze", "pending", "skipped"), true);
});

test("stage transitions cannot skip running or leave a finished state", () => {
  assert.equal(canTransitionStage("analyze", "pending", "succeeded"), false);
  assert.equal(canTransitionStage("analyze", "pending", "failed"), false);
  assert.equal(canTransitionStage("analyze", "succeeded", "running"), false);
  assert.equal(canTransitionStage("analyze", "succeeded", "failed"), false);
  assert.equal(canTransitionStage("analyze", "skipped", "running"), false);
  assert.equal(canTransitionStage("analyze", "running", "pending"), false);
  assert.equal(canTransitionStage("analyze", "bogus", "running"), false);
  assert.throws(() => assertStageTransition("analyze", "succeeded", "running"), InvalidTransitionError);
});

test("a failed stage retries only while attempts remain", () => {
  const max = MAX_STAGE_ATTEMPTS.analyze;

  for (let used = 1; used < max; used++) {
    assert.equal(canTransitionStage("analyze", "failed", "pending", used), true, `used ${used}`);
  }

  assert.equal(canTransitionStage("analyze", "failed", "pending", max), false);
  assert.throws(
    () => assertStageTransition("analyze", "failed", "pending", max),
    /no retries left/
  );
});

test("the pull-request stage is never retried automatically", () => {
  assert.equal(MAX_STAGE_ATTEMPTS.pr, 1);
  assert.equal(canRetryStage("pr", 1), false);
  assert.equal(canTransitionStage("pr", "failed", "pending", 1), false);
});

test("retry accounting rejects nonsense attempt counts", () => {
  for (const attempts of [0, -1, 1.5, NaN, Infinity]) {
    assert.equal(canRetryStage("ingest", attempts), false, String(attempts));
  }

  for (const stage of STAGES) {
    assert.ok(MAX_STAGE_ATTEMPTS[stage] >= 1, stage);
  }
});

test("idempotency keys are stable and validated", () => {
  assert.equal(stageIdempotencyKey(7, "verify", 2), "7:verify:2");
  assert.equal(stageIdempotencyKey(7, "verify", 2), stageIdempotencyKey(7, "verify", 2));
  assert.notEqual(stageIdempotencyKey(7, "verify", 1), stageIdempotencyKey(7, "verify", 2));
  assert.throws(() => stageIdempotencyKey(0, "verify", 1), TypeError);
  assert.throws(() => stageIdempotencyKey(1.5, "verify", 1), TypeError);
  assert.throws(() => stageIdempotencyKey(1, "deploy", 1), TypeError);
  assert.throws(() => stageIdempotencyKey(1, "verify", 0), TypeError);
});
