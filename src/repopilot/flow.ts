/**
 * How stages drive the run state machine. Pure: no I/O.
 *
 * Each stage starts from one run state, runs in a "working" state and, on
 * success, moves the run to the next state (and may queue a follow-up
 * stage). Human-gated hand-offs (choosing a finding to patch, authorising a
 * pull request) have no automatic follow-up.
 */

import { MAX_STAGE_ATTEMPTS } from "./states.js";
import type { RunState, StageName, StageState } from "./states.js";

export interface StageFlow {
  /** Run state the stage may start from. */
  from: RunState;
  /** State the run is in while the stage executes. */
  working: RunState;
  /** State after the stage succeeds. */
  success: RunState;
  /** Stage queued automatically after success. */
  next: StageName | null;
  /** State when the stage's result was rejected by policy (patch only). */
  rejected?: RunState;
}

export const STAGE_FLOW: Readonly<Record<StageName, StageFlow>> = {
  ingest: { from: "queued", working: "ingesting", success: "ingesting", next: "manifest" },
  manifest: { from: "ingesting", working: "ingesting", success: "analyzing", next: "analyze" },
  analyze: { from: "analyzing", working: "analyzing", success: "awaiting_patch", next: null },
  patch: {
    from: "awaiting_patch",
    working: "patching",
    success: "verifying",
    next: "verify",
    rejected: "awaiting_patch",
  },
  verify: { from: "verifying", working: "verifying", success: "ready_for_review", next: null },
  pr: { from: "pr_authorized", working: "pr_authorized", success: "pr_opened", next: null },
};

export interface StageRecord {
  stage: StageName;
  attempt: number;
  state: StageState;
}

/** Highest attempt number recorded for a stage, or 0. */
export function latestAttempt(stages: readonly StageRecord[], stage: StageName): StageRecord | null {
  let latest: StageRecord | null = null;

  for (const record of stages) {
    if (record.stage === stage && (latest === null || record.attempt > latest.attempt)) {
      latest = record;
    }
  }

  return latest;
}

/**
 * What an automatic recovery pass should queue for a run that has no stage
 * executing: used when a worker died between committing a state change and
 * queueing the follow-up. Returns null while a stage is running, when the
 * run waits for a human, or when retries are exhausted.
 */
export function nextStageToQueue(
  state: RunState,
  stages: readonly StageRecord[]
): { stage: StageName; attempt: number } | null {
  if (stages.some((record) => record.state === "running")) {
    return null;
  }

  let stage: StageName | null;

  switch (state) {
    case "queued":
      stage = "ingest";
      break;
    case "ingesting":
      stage = latestAttempt(stages, "ingest")?.state === "succeeded" ? "manifest" : "ingest";
      break;
    case "analyzing":
      stage = "analyze";
      break;
    case "verifying":
      stage = "verify";
      break;
    case "patching":
      stage = "patch";
      break;
    case "pr_authorized":
      stage = "pr";
      break;
    default:
      return null;
  }

  const latest = latestAttempt(stages, stage);

  if (latest === null) {
    return { stage, attempt: 1 };
  }

  // The latest attempt of the stage the run is waiting on failed: retry if
  // the budget allows. (A succeeded latest attempt for the same stage means
  // the state change that should have followed was lost; failStage/complete
  // are transactional, so this does not happen, and we do not guess.)
  if (latest.state === "failed" && latest.attempt < MAX_STAGE_ATTEMPTS[stage]) {
    return { stage, attempt: latest.attempt + 1 };
  }

  return null;
}

/** Exponential backoff with a cap, in milliseconds. Deterministic (no jitter). */
export function retryDelayMs(attempt: number, baseMs = 5_000, maxMs = 120_000): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new TypeError("attempt must be a positive integer");
  }

  return Math.min(maxMs, baseMs * 2 ** (attempt - 1));
}
