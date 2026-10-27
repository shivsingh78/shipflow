import { test } from "node:test";
import assert from "node:assert/strict";

import {
  OUTCOME_CAVEATS,
  classifyOutcome,
} from "../../dist/src/repopilot/outcome.js";

const pass = () => ({ kind: "exited", exitCode: 0, durationMs: 1200 });
const fail = (exitCode = 1) => ({ kind: "exited", exitCode, durationMs: 900 });
const runs = (make, n = 2) => Array.from({ length: n }, make);

function classify(baseline, patched, control) {
  return classifyOutcome({ baseline, patched, ...(control ? { control } : {}) });
}

test("improved: regression test fails without the fix and the patched run passes", () => {
  for (const baseline of [runs(pass), runs(fail)]) {
    const result = classify(baseline, runs(pass), runs(fail));
    assert.equal(result.outcome, "improved");
    assert.deepEqual(result.reasons, []);
  }
});

test("regressed: baseline passes, patched fails", () => {
  assert.equal(classify(runs(pass), runs(fail)).outcome, "regressed");
  assert.equal(classify(runs(pass), runs(fail), runs(fail)).outcome, "regressed");
  assert.equal(classify(runs(pass), runs(() => fail(2)), runs(pass)).outcome, "regressed");
});

test("unchanged: both pass and no control arm is available", () => {
  const result = classify(runs(pass), runs(pass));
  assert.equal(result.outcome, "unchanged");
});

test("a regression test that passes without the fix is not discriminating", () => {
  for (const baseline of [runs(pass), runs(fail)]) {
    const result = classify(baseline, runs(pass), runs(pass));
    assert.equal(result.outcome, "inconclusive");
    assert.deepEqual(result.reasons, ["regression_test_not_discriminating"]);
  }
});

test("baseline failing then patched passing without a control is inconclusive", () => {
  const result = classify(runs(fail), runs(pass));
  assert.equal(result.outcome, "inconclusive");
  assert.deepEqual(result.reasons, ["control_missing"]);
});

test("an already-failing baseline with a failing patched run is inconclusive", () => {
  for (const control of [undefined, runs(fail), runs(pass)]) {
    const result = classify(runs(fail), runs(fail), control);
    assert.equal(result.outcome, "inconclusive");
    assert.deepEqual(result.reasons, ["baseline_failing"]);
  }
});

test("timeouts are inconclusive in any arm, never pass or fail", () => {
  const timeout = () => ({ kind: "timeout", durationMs: 300000 });

  for (const [b, p, c] of [
    [runs(timeout), runs(pass), runs(fail)],
    [runs(pass), runs(timeout), runs(fail)],
    [runs(pass), runs(pass), runs(timeout)],
    [runs(pass), [pass(), timeout()], runs(fail)],
  ]) {
    const result = classify(b, p, c);
    assert.equal(result.outcome, "inconclusive");
    assert.deepEqual(result.reasons, ["timeout"]);
  }
});

test("infrastructure errors are inconclusive even when other runs passed", () => {
  const infra = () => ({ kind: "infra_error", detail: "docker daemon unavailable" });
  const result = classify(runs(pass), [pass(), infra()], runs(fail));
  assert.equal(result.outcome, "inconclusive");
  assert.deepEqual(result.reasons, ["infra_error"]);
});

test("resource-limit kills are inconclusive", () => {
  const killed = () => ({ kind: "resource_limit", detail: "out of memory" });
  const result = classify(runs(pass), runs(killed), runs(fail));
  assert.equal(result.outcome, "inconclusive");
  assert.deepEqual(result.reasons, ["resource_limit"]);
});

test("a missing test script is inconclusive and takes priority", () => {
  const none = () => ({ kind: "no_test_script" });
  const timeout = () => ({ kind: "timeout", durationMs: 1 });
  const result = classify(runs(none, 1), runs(timeout));
  assert.equal(result.outcome, "inconclusive");
  assert.deepEqual(result.reasons, ["no_test_script", "timeout"]);
});

test("flaky runs are inconclusive and name the arm", () => {
  const flaky = () => [pass(), fail(), pass()];

  let result = classify(flaky(), runs(pass), runs(fail));
  assert.equal(result.outcome, "inconclusive");
  assert.deepEqual(result.reasons, ["flaky_baseline"]);
  assert.equal(result.arms.baseline.state, "flaky");

  result = classify(runs(pass), flaky(), runs(fail));
  assert.deepEqual(result.reasons, ["flaky_patched"]);

  result = classify(runs(pass), runs(pass), flaky());
  assert.deepEqual(result.reasons, ["flaky_control"]);
});

test("different failing exit codes are still a consistent failure, not flakiness", () => {
  const result = classify(runs(pass), [fail(1), fail(137)]);
  assert.equal(result.outcome, "regressed");
});

test("too few runs cannot establish a stable result", () => {
  let result = classify([pass()], runs(pass), runs(fail));
  assert.equal(result.outcome, "inconclusive");
  assert.deepEqual(result.reasons, ["insufficient_runs"]);

  result = classify([], runs(pass));
  assert.deepEqual(result.reasons, ["insufficient_runs"]);

  // The requirement is configurable.
  result = classifyOutcome({ baseline: [pass()], patched: [pass()], control: [fail()], requiredAttempts: 1 });
  assert.equal(result.outcome, "improved");
});

test("every result carries the standing caveats", () => {
  for (const result of [
    classify(runs(pass), runs(pass), runs(fail)),
    classify(runs(pass), runs(fail)),
    classify([], []),
  ]) {
    assert.deepEqual(result.caveats, [...OUTCOME_CAVEATS]);
    assert.ok(result.caveats.some((c) => /do not prove/.test(c)));
  }
});

test("the result reports each arm's summary for display", () => {
  const result = classify(runs(pass), runs(pass), runs(fail));
  assert.deepEqual(result.arms.baseline, { state: "pass", attempts: 2, reasons: [] });
  assert.deepEqual(result.arms.control, { state: "fail", attempts: 2, reasons: [] });
});

test("records that are not valid sandbox runs are a caller bug, not an outcome", () => {
  const forged = [
    { kind: "exited", exitCode: 0, durationMs: 1, verified: true },
    { kind: "passed" },
    { exitCode: 0, durationMs: 1 },
    { kind: "exited", exitCode: -1, durationMs: 1 },
    { kind: "exited", exitCode: "0", durationMs: 1 },
    "passed",
    null,
  ];

  for (const record of forged) {
    assert.throws(() => classify([record, record], runs(pass)), undefined, JSON.stringify(record));
  }

  assert.throws(() => classifyOutcome({ baseline: "x", patched: [] }), TypeError);
  assert.throws(() => classifyOutcome({ baseline: [], patched: [], requiredAttempts: 0 }), TypeError);
});
