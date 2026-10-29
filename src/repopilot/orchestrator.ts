/**
 * Durable stage orchestration.
 *
 * A job runs ONE stage attempt:
 *   beginStage (guarded, idempotent)  ->  handler  ->  completeStage
 * with failures turned into a bounded retry (new job, next attempt, backoff)
 * or a failed run. State changes and stage results commit in single
 * transactions (store.ts). Handlers are injected, so this module has no
 * knowledge of GitHub, the AI provider or the sandbox, and tests need no
 * Redis.
 */

import { StageError } from "./errors.js";
import { StageJobSchema } from "./queue.js";
import type { EnqueueStage, StageJob } from "./queue.js";
import { RepoPilotError } from "./store.js";
import type { RepoPilotStore, RunRow, StagePersistResult, StageTx } from "./store.js";
import { redactSensitive } from "./redact.js";
import type { StageName } from "./states.js";

export { StageError };

export interface StageContext {
  run: RunRow;
  stage: StageName;
  attempt: number;
  params: Record<string, unknown>;
  /** Aborted when the run is cancelled or the worker is shutting down. */
  signal: AbortSignal;
  log(level: "INFO" | "WARN" | "ERROR", message: string): Promise<void>;
}

export interface StageOutput {
  /** Writes the stage's results inside the transaction that advances the run. */
  persist?: (tx: StageTx) => Promise<StagePersistResult | void>;
}

export type StageHandler = (context: StageContext) => Promise<StageOutput | void>;

export type StageHandlers = Partial<Record<StageName, StageHandler>>;

export interface OrchestratorOptions {
  store: RepoPilotStore;
  enqueue: EnqueueStage;
  handlers: StageHandlers;
  workerId: string;
  /** Called with structured, already-redacted log lines. */
  log?: (line: Record<string, unknown>) => void;
  heartbeatMs?: number;
  cancelPollMs?: number;
}

export type JobStatus =
  | { status: "completed"; runState: string }
  | { status: "skipped"; reason: string }
  | { status: "retry_scheduled"; attempt: number; delayMs: number }
  | { status: "failed"; code: string }
  | { status: "cancelled" }
  | { status: "invalid_job" };

export function createOrchestrator(options: OrchestratorOptions) {
  const { store, enqueue, handlers, workerId } = options;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const cancelPollMs = options.cancelPollMs ?? 3_000;
  const emit = options.log ?? (() => {});
  const actor = `worker:${workerId}`;
  let shuttingDown = false;
  const inFlight = new Set<AbortController>();

  async function processJob(raw: unknown): Promise<JobStatus> {
    const parsed = StageJobSchema.safeParse(raw);

    if (!parsed.success) {
      emit({ event: "invalid_job" });

      return { status: "invalid_job" };
    }

    const job = parsed.data;
    const correlation = { runId: job.runId, stage: job.stage, attempt: job.attempt };

    if (job.stage === "patch" && job.findingId === undefined) {
      // Retries reuse the findingId recorded by the first attempt.
      const stored = await store.latestStageParams(job.runId, "patch");

      if (typeof stored.findingId === "number") {
        job.findingId = stored.findingId;
      }
    }

    const begun = await store.beginStage({
      runId: job.runId,
      stage: job.stage,
      attempt: job.attempt,
      worker: actor,
      params: job.findingId === undefined ? {} : { findingId: job.findingId },
    });

    if (begun.kind === "skip") {
      emit({ event: "stage_skipped", ...correlation, reason: begun.reason });

      return { status: "skipped", reason: begun.reason };
    }

    emit({ event: "stage_started", ...correlation });

    const controller = new AbortController();
    inFlight.add(controller);

    const heartbeat = setInterval(() => {
      store.touchStage(job.runId, job.stage, job.attempt).catch(() => {});
    }, heartbeatMs);
    const cancelWatch = setInterval(() => {
      store.isCancelRequested(job.runId).then((cancelled) => {
        if (cancelled) controller.abort(new StageError("cancelled", "run was cancelled"));
      }).catch(() => {});
    }, cancelPollMs);

    try {
      const handler = handlers[job.stage];

      if (!handler) {
        throw new StageError("stage_unavailable", `stage ${job.stage} is not enabled on this worker`);
      }

      const output = await handler({
        run: begun.run,
        stage: job.stage,
        attempt: job.attempt,
        params: begun.stage.params,
        signal: controller.signal,
        log: (level, message) => store.appendLog(job.runId, job.stage, level, message),
      });

      controller.signal.throwIfAborted();

      const completed = await store.completeStage({
        runId: job.runId,
        stage: job.stage,
        attempt: job.attempt,
        worker: actor,
        ...(output?.persist ? { persist: output.persist } : {}),
      });

      if (completed.kind === "ignored") {
        return { status: "skipped", reason: completed.reason };
      }

      if (completed.kind === "cancelled") {
        emit({ event: "run_cancelled", ...correlation });

        return { status: "cancelled" };
      }

      if (completed.next) {
        await enqueue({ runId: job.runId, stage: completed.next.stage, attempt: completed.next.attempt });
      }

      emit({ event: "stage_succeeded", ...correlation, runState: completed.run.state });

      return { status: "completed", runState: completed.run.state };
    } catch (error) {
      return await handleFailure(job, error, correlation);
    } finally {
      clearInterval(heartbeat);
      clearInterval(cancelWatch);
      inFlight.delete(controller);
    }
  }

  async function handleFailure(job: StageJob, error: unknown, correlation: Record<string, unknown>): Promise<JobStatus> {
    const stageError = error instanceof StageError
      ? error
      : error instanceof RepoPilotError
        // Conflicts mean the world changed under us; retrying cannot help.
        ? new StageError(error.code, error.message, false)
        // Unknown failures are assumed transient and are bounded by attempts.
        : new StageError("internal_error", error instanceof Error ? error.message : "unknown error", true);

    const detail = redactSensitive(stageError.message);
    const failed = await store.failStage({
      runId: job.runId,
      stage: job.stage,
      attempt: job.attempt,
      worker: actor,
      code: stageError.code,
      detail,
      retryable: stageError.retryable,
    });

    emit({ event: "stage_failed", ...correlation, code: stageError.code, retryable: stageError.retryable });

    if (failed.kind === "retry") {
      try {
        await enqueue(
          { runId: job.runId, stage: job.stage, attempt: failed.attempt, ...(job.findingId === undefined ? {} : { findingId: job.findingId }) },
          { delayMs: failed.delayMs }
        );
      } catch {
        // The stage attempt is already recorded as failed; without a queued
        // retry the run would stall, so fail it explicitly.
        await store.failRun(job.runId, actor, "enqueue_failed", "The retry could not be queued");

        return { status: "failed", code: "enqueue_failed" };
      }

      return { status: "retry_scheduled", attempt: failed.attempt, delayMs: failed.delayMs };
    }

    if (failed.kind === "failed") {
      return failed.run.state === "cancelled" ? { status: "cancelled" } : { status: "failed", code: stageError.code };
    }

    return { status: "skipped", reason: "not_running" };
  }

  /**
   * Periodic repair: fail stages whose worker vanished (retrying them within
   * their budget) and queue steps that were committed but never enqueued.
   * Safe to run on every worker: job ids make duplicate enqueues no-ops.
   */
  async function recover(options: { staleAfterMs: number; idleForMs: number }): Promise<{ interrupted: number; requeued: number }> {
    let requeued = 0;
    const interrupted = await store.recoverStaleStages(options.staleAfterMs);

    for (const item of interrupted) {
      if (item.result.kind === "retry") {
        const findingId = item.stage === "patch" ? (await store.latestStageParams(item.runId, "patch")).findingId : undefined;

        await enqueue(
          { runId: item.runId, stage: item.stage, attempt: item.result.attempt, ...(typeof findingId === "number" ? { findingId } : {}) },
          { delayMs: item.result.delayMs }
        );
        requeued += 1;
      }
    }

    for (const work of await store.findIdleRuns(options.idleForMs)) {
      const findingId = work.stage === "patch" ? (await store.latestStageParams(work.runId, "patch")).findingId : undefined;

      await enqueue({ runId: work.runId, stage: work.stage, attempt: work.attempt, ...(typeof findingId === "number" ? { findingId } : {}) });
      requeued += 1;
    }

    return { interrupted: interrupted.length, requeued };
  }

  /** Stop accepting work and abort running handlers (graceful shutdown). */
  function shutdown(): void {
    shuttingDown = true;

    for (const controller of inFlight) {
      controller.abort(new StageError("shutdown", "worker is shutting down", true));
    }
  }

  return { processJob, recover, shutdown, isShuttingDown: () => shuttingDown };
}

export type Orchestrator = ReturnType<typeof createOrchestrator>;
