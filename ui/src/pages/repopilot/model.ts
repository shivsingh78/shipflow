import type { Outcome, RpOutcome, RpPatch, RpPullRequest, RpRun, RunState } from "@/api/repopilotTypes";
import type { Tone } from "@/lib/status";

export const RUN_STATE: Record<RunState, { label: string; tone: Tone }> = {
  queued: { label: "Queued", tone: "neutral" },
  ingesting: { label: "Reading repository", tone: "info" },
  analyzing: { label: "Analysing", tone: "info" },
  awaiting_patch: { label: "Choose a finding", tone: "warning" },
  patching: { label: "Writing patch", tone: "info" },
  verifying: { label: "Verifying", tone: "info" },
  ready_for_review: { label: "Ready for your review", tone: "warning" },
  pr_authorized: { label: "Opening pull request", tone: "info" },
  pr_opened: { label: "Pull request opened", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

export const isActive = (state: RunState): boolean => !["pr_opened", "failed", "cancelled"].includes(state);

/** States where the system is waiting for a person, not working. */
export const needsPerson = (state: RunState): boolean => state === "awaiting_patch" || state === "ready_for_review";

export const OUTCOME: Record<Outcome, { label: string; tone: Tone; meaning: string }> = {
  improved: { label: "Improved", tone: "success", meaning: "The new test failed on the original code and the patched code passed, consistently. That is evidence, not proof." },
  unchanged: { label: "No improvement shown", tone: "neutral", meaning: "Tests passed before and after, but there was no control run showing the new test fails without the fix." },
  regressed: { label: "Regression", tone: "danger", meaning: "Tests that passed before failed after the change." },
  inconclusive: { label: "Inconclusive", tone: "warning", meaning: "The evidence does not support a conclusion. See the reasons." },
};

const REASONS: Record<string, string> = {
  verification_unavailable: "No isolated sandbox is configured, so no tests were run.",
  unsupported_project: "This project cannot be verified yet (only npm projects with a real test script are supported).",
  no_test_script: "The project has no test script.",
  infra_error: "The test environment failed (not a test result).",
  timeout: "A test run timed out.",
  resource_limit: "A test run hit a resource limit.",
  insufficient_runs: "Too few runs to call the result stable.",
  flaky_baseline: "The original code gave different results across runs (flaky).",
  flaky_patched: "The patched code gave different results across runs (flaky).",
  flaky_control: "The control runs gave different results (flaky).",
  baseline_failing: "The project's tests were already failing before the change.",
  control_missing: "No control run: the new test was not shown to fail on the original code.",
  regression_test_not_discriminating: "The new test passes even without the fix, so it does not prove the fix works.",
};

export const reasonText = (reason: string): string => REASONS[reason] ?? reason.replace(/_/g, " ");

export type StepStatus = "done" | "pending" | "warn" | "fail";

export interface LadderStep {
  key: "generated" | "policy" | "verification" | "pr";
  label: string;
  status: StepStatus;
  detail: string;
}

/**
 * Four separate facts, never merged into one "success": a patch existing, it
 * passing OUR validation, the sandbox evidence, and a pull request existing.
 */
export function ladderFor(patch: RpPatch | undefined, outcome: RpOutcome | undefined, pr: RpPullRequest | null): LadderStep[] {
  const policy: LadderStep = !patch
    ? { key: "policy", label: "Patch validated", status: "pending", detail: "Nothing to validate yet." }
    : patch.policy.passed
      ? { key: "policy", label: "Patch validated", status: "done", detail: "Well-formed, within policy and applies cleanly. This does not mean it is correct." }
      : { key: "policy", label: "Patch validated", status: "fail", detail: "Rejected by RepoPilot's patch policy or it did not apply. It will not be verified or proposed." };

  const verification: LadderStep = !patch || !patch.policy.passed
    ? { key: "verification", label: "Verification", status: "pending", detail: "Only validated patches are verified." }
    : !outcome
      ? { key: "verification", label: "Verification", status: "pending", detail: "Not finished yet." }
      : outcome.outcome === "improved"
        ? { key: "verification", label: "Verification", status: "done", detail: OUTCOME.improved.label }
        : { key: "verification", label: "Verification", status: outcome.outcome === "regressed" ? "fail" : "warn", detail: OUTCOME[outcome.outcome].label };

  const prStep: LadderStep = !pr
    ? { key: "pr", label: "Pull request opened", status: "pending", detail: "Needs your explicit authorisation." }
    : pr.state === "opened"
      ? { key: "pr", label: "Pull request opened", status: "done", detail: pr.number ? `#${pr.number}` : "Opened" }
      : pr.state === "failed"
        ? { key: "pr", label: "Pull request opened", status: "fail", detail: pr.error?.detail ?? "Could not be opened." }
        : { key: "pr", label: "Pull request opened", status: "pending", detail: "Authorised; being created." };

  return [
    { key: "generated", label: "Patch generated", status: patch ? "done" : "pending", detail: patch ? "An AI model proposed a change and a test." : "Choose a finding to generate one." },
    policy,
    verification,
    prStep,
  ];
}

/** Why a person cannot authorise a pull request right now, or null if they can. */
export function authorizationBlocker(run: Pick<RpRun, "state">, patch: RpPatch | undefined, outcome: RpOutcome | undefined): string | null {
  if (run.state !== "ready_for_review") return "This run is not waiting for review.";
  if (!patch) return "There is no patch to propose.";
  if (!patch.policy.passed) return "This patch failed validation and cannot be proposed.";
  if (!outcome) return "This patch has no verification outcome yet.";
  if (outcome.outcome === "regressed") return "This patch made passing tests fail, so it cannot be proposed.";

  return null;
}

export const canCancel = (run: Pick<RpRun, "state" | "cancelRequested">): boolean => isActive(run.state) && !run.cancelRequested;

export const shortSha = (sha: string | null): string => (sha ? sha.slice(0, 10) : "—");

export const percent = (confidence: number): string => `${Math.round(confidence * 100)}%`;
