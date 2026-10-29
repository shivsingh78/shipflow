/**
 * RepoPilot job contract and BullMQ binding.
 *
 * A job names a run, a stage and an attempt, and nothing else: no
 * credentials, tokens, source code or prompts. Everything a stage needs is
 * read from PostgreSQL (and the worker's own environment) when it runs.
 *
 * Job ids are deterministic (`rp-<run>-<stage>-<attempt>`), so BullMQ drops a
 * duplicate add. Retries are NOT BullMQ retries: attempts are counted in
 * PostgreSQL (rp_stages) and a retry is a new job with the next attempt, so
 * the budget survives worker restarts and is visible to operators.
 */

import { Queue } from "bullmq";
import type { ConnectionOptions } from "bullmq";
import { z } from "zod";

import { STAGES } from "./states.js";

export const REPOPILOT_QUEUE = "repopilot-queue";

export const StageJobSchema = z.strictObject({
  runId: z.number().int().positive(),
  stage: z.enum(STAGES),
  attempt: z.number().int().min(1).max(10),
  /** Non-secret input for the patch stage. */
  findingId: z.number().int().positive().optional(),
});

export type StageJob = z.infer<typeof StageJobSchema>;

export function stageJobId(job: Pick<StageJob, "runId" | "stage" | "attempt">): string {
  // BullMQ forbids ":" in custom ids.
  return `rp-${job.runId}-${job.stage}-${job.attempt}`;
}

/** Where the orchestrator puts follow-up work. Implemented over BullMQ below. */
export type EnqueueStage = (job: StageJob, options?: { delayMs?: number }) => Promise<void>;

export const FAILED_JOB_RETENTION_SECONDS = 7 * 24 * 3600;
export const COMPLETED_JOB_RETENTION_SECONDS = 24 * 3600;

export function createRepoPilotQueue(connection: ConnectionOptions): Queue<StageJob> {
  return new Queue<StageJob>(REPOPILOT_QUEUE, { connection });
}

export function bullEnqueue(queue: Pick<Queue<StageJob>, "add">): EnqueueStage {
  return async (job, { delayMs = 0 } = {}) => {
    const parsed = StageJobSchema.parse(job);

    await queue.add(`${parsed.stage}`, parsed, {
      jobId: stageJobId(parsed),
      delay: delayMs,
      // One BullMQ attempt: retries are persisted stage attempts.
      attempts: 1,
      // Completed ids stay for a day so a late duplicate add is still a no-op;
      // failed jobs stay a week as the dead-letter record for operators.
      removeOnComplete: { age: COMPLETED_JOB_RETENTION_SECONDS },
      removeOnFail: { age: FAILED_JOB_RETENTION_SECONDS },
    });
  };
}
