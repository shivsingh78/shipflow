/**
 * RepoPilot run and stage state machines.
 *
 * Pure data and guards: no I/O. Persistence (increment 2) applies a
 * transition with a guarded `UPDATE ... WHERE state = ANY(...)`, using
 * these tables as the single source of truth for what is allowed.
 *
 * Run states cover the whole pipeline. "ingesting" spans the ingest and
 * manifest stages; every other working state maps to one stage.
 */

export const RUN_STATES = [
  "queued",
  "ingesting",
  "analyzing",
  "awaiting_patch",
  "patching",
  "verifying",
  "ready_for_review",
  "pr_authorized",
  "pr_opened",
  "failed",
  "cancelled",
] as const;

export type RunState = (typeof RUN_STATES)[number];

export const TERMINAL_RUN_STATES: readonly RunState[] = [
  "pr_opened",
  "failed",
  "cancelled",
];

/**
 * Who is asking for a transition. There is deliberately no "model" actor:
 * AI output can never drive a state change.
 */
export type TransitionActor = "system" | "user";

const RUN_TRANSITIONS: Record<RunState, readonly RunState[]> = {
  queued: ["ingesting", "failed", "cancelled"],
  ingesting: ["analyzing", "failed", "cancelled"],
  analyzing: ["awaiting_patch", "failed", "cancelled"],
  awaiting_patch: ["patching", "failed", "cancelled"],
  // A rejected patch returns to awaiting_patch so another finding can be tried.
  patching: ["verifying", "awaiting_patch", "failed", "cancelled"],
  verifying: ["ready_for_review", "failed", "cancelled"],
  ready_for_review: ["pr_authorized", "awaiting_patch", "failed", "cancelled"],
  pr_authorized: ["pr_opened", "failed", "cancelled"],
  pr_opened: [],
  failed: [],
  cancelled: [],
};

/** Transitions only a human may request (explicit, audited authorization). */
const USER_ONLY_TRANSITIONS: ReadonlySet<string> = new Set([
  "ready_for_review->pr_authorized",
]);

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
    reason: string
  ) {
    super(`Invalid RepoPilot transition ${from} -> ${to}: ${reason}`);
    this.name = "InvalidTransitionError";
  }
}

export function isRunState(value: unknown): value is RunState {
  return (
    typeof value === "string" &&
    (RUN_STATES as readonly string[]).includes(value)
  );
}

export function isTerminalRunState(state: RunState): boolean {
  return TERMINAL_RUN_STATES.includes(state);
}

/** States reachable from `from` for the given actor. */
export function allowedRunTransitions(
  from: RunState,
  actor: TransitionActor = "system"
): RunState[] {
  return RUN_TRANSITIONS[from].filter(
    (to) => actor === "user" || !USER_ONLY_TRANSITIONS.has(`${from}->${to}`)
  );
}

export function canTransitionRun(
  from: unknown,
  to: unknown,
  actor: TransitionActor = "system"
): boolean {
  if (!isRunState(from) || !isRunState(to)) {
    return false;
  }

  return allowedRunTransitions(from, actor).includes(to);
}

export function assertRunTransition(
  from: unknown,
  to: unknown,
  actor: TransitionActor = "system"
): void {
  if (!isRunState(from) || !isRunState(to)) {
    throw new InvalidTransitionError(String(from), String(to), "unknown state");
  }

  if (canTransitionRun(from, to, actor)) {
    return;
  }

  if (RUN_TRANSITIONS[from].includes(to)) {
    throw new InvalidTransitionError(from, to, "requires explicit user authorization");
  }

  throw new InvalidTransitionError(
    from,
    to,
    isTerminalRunState(from) ? "run is already finished" : "transition not allowed"
  );
}

// ------------------------------------------------------------------ stages

export const STAGES = [
  "ingest",
  "manifest",
  "analyze",
  "patch",
  "verify",
  "pr",
] as const;

export type StageName = (typeof STAGES)[number];

export const STAGE_STATES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
] as const;

export type StageState = (typeof STAGE_STATES)[number];

const STAGE_TRANSITIONS: Record<StageState, readonly StageState[]> = {
  pending: ["running", "skipped"],
  running: ["succeeded", "failed"],
  // failed -> pending is a retry; whether it is allowed depends on the
  // stage and attempt count (see canRetryStage).
  failed: ["pending"],
  succeeded: [],
  skipped: [],
};

/**
 * Attempts allowed per stage (first run included). The pull-request stage
 * is never retried automatically: it has outward-facing side effects and a
 * new attempt needs a new explicit authorization.
 */
export const MAX_STAGE_ATTEMPTS: Record<StageName, number> = {
  ingest: 3,
  manifest: 2,
  analyze: 3,
  patch: 3,
  verify: 2,
  pr: 1,
};

export function isStageName(value: unknown): value is StageName {
  return (
    typeof value === "string" && (STAGES as readonly string[]).includes(value)
  );
}

export function isStageState(value: unknown): value is StageState {
  return (
    typeof value === "string" &&
    (STAGE_STATES as readonly string[]).includes(value)
  );
}

/** True when a failed stage that has already used `attemptsUsed` may retry. */
export function canRetryStage(stage: StageName, attemptsUsed: number): boolean {
  return (
    Number.isInteger(attemptsUsed) &&
    attemptsUsed >= 1 &&
    attemptsUsed < MAX_STAGE_ATTEMPTS[stage]
  );
}

export function canTransitionStage(
  stage: StageName,
  from: unknown,
  to: unknown,
  attemptsUsed = 1
): boolean {
  if (!isStageState(from) || !isStageState(to)) {
    return false;
  }

  if (!STAGE_TRANSITIONS[from].includes(to)) {
    return false;
  }

  return from === "failed" ? canRetryStage(stage, attemptsUsed) : true;
}

export function assertStageTransition(
  stage: StageName,
  from: unknown,
  to: unknown,
  attemptsUsed = 1
): void {
  if (!canTransitionStage(stage, from, to, attemptsUsed)) {
    throw new InvalidTransitionError(
      `${stage}:${String(from)}`,
      `${stage}:${String(to)}`,
      from === "failed" && to === "pending"
        ? "no retries left for this stage"
        : "transition not allowed"
    );
  }
}

/**
 * Key that makes a stage execution idempotent: persistence enforces
 * uniqueness, so a redelivered job cannot run the same attempt twice.
 */
export function stageIdempotencyKey(
  runId: number,
  stage: StageName,
  attempt: number
): string {
  if (!Number.isInteger(runId) || runId < 1) {
    throw new TypeError("runId must be a positive integer");
  }

  if (!isStageName(stage)) {
    throw new TypeError(`Unknown stage ${JSON.stringify(stage)}`);
  }

  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new TypeError("attempt must be a positive integer");
  }

  return `${runId}:${stage}:${attempt}`;
}
