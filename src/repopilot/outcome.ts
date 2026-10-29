/**
 * Baseline-versus-patched outcome classification.
 *
 * Pure function over sandbox execution records. These records are produced
 * only by the sandbox result path; nothing in a model response can reach
 * this module (see schemas.ts SandboxRunSchema).
 *
 * Three arms, each run several times so flakiness is visible:
 *   baseline  original code, the repository's own test script
 *   patched   patched code plus the new regression test, same script
 *   control   original code plus ONLY the new regression test (optional).
 *             A regression test that passes without the fix proves nothing,
 *             so `improved` requires the control to fail.
 *
 * Decision table (after every arm has a stable pass/fail result):
 *
 *   baseline  patched  control   outcome
 *   pass      fail     any       regressed
 *   pass      pass     none      unchanged
 *   pass      pass     fail      improved
 *   pass      pass     pass      inconclusive (test does not discriminate)
 *   fail      pass     none      inconclusive (no control)
 *   fail      pass     fail      improved
 *   fail      pass     pass      inconclusive (test does not discriminate)
 *   fail      fail     any       inconclusive (baseline already failing)
 *
 * Anything that is not a clean, repeatable exit (timeout, infrastructure
 * error, resource limit, missing test script, too few runs, flaky results)
 * makes the outcome inconclusive. Passing tests never prove a patch correct.
 */

import { SandboxRunSchema } from "./schemas.js";
import type { SandboxRun } from "./schemas.js";

export type Outcome = "improved" | "unchanged" | "regressed" | "inconclusive";

export type ArmName = "baseline" | "patched" | "control";

export type ArmState = "pass" | "fail" | "flaky" | "inconclusive";

export type InconclusiveReason =
  | "verification_unavailable"
  | "unsupported_project"
  | "no_test_script"
  | "infra_error"
  | "timeout"
  | "resource_limit"
  | "insufficient_runs"
  | "flaky_baseline"
  | "flaky_patched"
  | "flaky_control"
  | "baseline_failing"
  | "control_missing"
  | "regression_test_not_discriminating";

export interface ArmSummary {
  state: ArmState;
  attempts: number;
  reasons: InconclusiveReason[];
}

export interface OutcomeResult {
  outcome: Outcome;
  reasons: InconclusiveReason[];
  arms: Partial<Record<ArmName, ArmSummary>>;
  /** Always shown with the outcome: tests are evidence, not proof. */
  caveats: string[];
}

export interface ClassifyInput {
  baseline: readonly SandboxRun[];
  patched: readonly SandboxRun[];
  control?: readonly SandboxRun[];
  /** Runs required per arm to call a result stable. Default 2. */
  requiredAttempts?: number;
}

export const DEFAULT_REQUIRED_ATTEMPTS = 2;

export const OUTCOME_CAVEATS: readonly string[] = [
  "Passing tests do not prove the change is correct; they are evidence only.",
  "The regression test was written by an AI model and may not capture the real defect.",
];

// Reason priority when several apply: the most actionable first.
const REASON_PRIORITY: readonly InconclusiveReason[] = [
  "verification_unavailable",
  "unsupported_project",
  "no_test_script",
  "infra_error",
  "timeout",
  "resource_limit",
  "insufficient_runs",
  "flaky_baseline",
  "flaky_patched",
  "flaky_control",
  "baseline_failing",
  "control_missing",
  "regression_test_not_discriminating",
];

function sortReasons(reasons: Iterable<InconclusiveReason>): InconclusiveReason[] {
  const set = new Set(reasons);

  return REASON_PRIORITY.filter((reason) => set.has(reason));
}

function parseRuns(arm: ArmName, runs: unknown): SandboxRun[] {
  if (!Array.isArray(runs)) {
    throw new TypeError(`${arm} runs must be an array`);
  }

  return runs.map((run: unknown) => SandboxRunSchema.parse(run));
}

function summarize(
  arm: ArmName,
  rawRuns: readonly SandboxRun[],
  requiredAttempts: number
): ArmSummary {
  const runs = parseRuns(arm, rawRuns);
  const reasons = new Set<InconclusiveReason>();

  for (const run of runs) {
    if (run.kind === "no_test_script") reasons.add("no_test_script");
    else if (run.kind === "infra_error") reasons.add("infra_error");
    else if (run.kind === "timeout") reasons.add("timeout");
    else if (run.kind === "resource_limit") reasons.add("resource_limit");
  }

  if (reasons.size > 0) {
    return { state: "inconclusive", attempts: runs.length, reasons: sortReasons(reasons) };
  }

  if (runs.length < requiredAttempts) {
    return { state: "inconclusive", attempts: runs.length, reasons: ["insufficient_runs"] };
  }

  const passes = runs.filter((run) => run.kind === "exited" && run.exitCode === 0).length;

  if (passes === runs.length) {
    return { state: "pass", attempts: runs.length, reasons: [] };
  }

  if (passes === 0) {
    return { state: "fail", attempts: runs.length, reasons: [] };
  }

  return {
    state: "flaky",
    attempts: runs.length,
    reasons: [
      arm === "baseline" ? "flaky_baseline" : arm === "patched" ? "flaky_patched" : "flaky_control",
    ],
  };
}

function result(
  outcome: Outcome,
  reasons: Iterable<InconclusiveReason>,
  arms: Partial<Record<ArmName, ArmSummary>>
): OutcomeResult {
  return {
    outcome,
    reasons: sortReasons(reasons),
    arms,
    caveats: [...OUTCOME_CAVEATS],
  };
}

/**
 * Classify a verification from sandbox execution records.
 * Throws TypeError/ZodError if a record is not a valid SandboxRun: that is
 * a bug in the caller, not an outcome.
 */
export function classifyOutcome(input: ClassifyInput): OutcomeResult {
  const required = input.requiredAttempts ?? DEFAULT_REQUIRED_ATTEMPTS;

  if (!Number.isInteger(required) || required < 1) {
    throw new TypeError("requiredAttempts must be a positive integer");
  }

  const arms: Partial<Record<ArmName, ArmSummary>> = {
    baseline: summarize("baseline", input.baseline, required),
    patched: summarize("patched", input.patched, required),
  };

  if (input.control !== undefined) {
    arms.control = summarize("control", input.control, required);
  }

  const summaries = Object.values(arms);
  const armReasons = summaries.flatMap((summary) => summary.reasons);

  if (summaries.some((summary) => summary.state === "inconclusive" || summary.state === "flaky")) {
    return result("inconclusive", armReasons, arms);
  }

  const baseline = arms.baseline?.state;
  const patched = arms.patched?.state;
  const control = arms.control?.state;

  if (baseline === "pass" && patched === "fail") {
    return result("regressed", [], arms);
  }

  if (patched === "pass") {
    if (control === "fail") {
      return result("improved", [], arms);
    }

    if (control === "pass") {
      return result("inconclusive", ["regression_test_not_discriminating"], arms);
    }

    // No control arm.
    return baseline === "pass"
      ? result("unchanged", [], arms)
      : result("inconclusive", ["control_missing"], arms);
  }

  // patched failed while the baseline did too.
  return result("inconclusive", ["baseline_failing"], arms);
}
