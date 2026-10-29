// REAL Redis + PostgreSQL through BullMQ. Skipped without both configured.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";

import { createRepoPilotStore } from "../../dist/src/repopilot/store.js";
import { createOrchestrator, StageError } from "../../dist/src/repopilot/orchestrator.js";
import { REPOPILOT_QUEUE, bullEnqueue } from "../../dist/src/repopilot/queue.js";
import { REDIS_ADDR, REPO, SHA, finding, openDatabase, resetDatabase, skipRedis } from "./helpers.js";

const OWNER = "instance";
const USER = "user:alice";

let pool;
let store;
let connection;
let queue;
let worker;

const waitFor = async (predicate, { timeoutMs = 10_000, label = "condition" } = {}) => {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

before(async () => {
  if (skipRedis) return;
  const [host, port] = REDIS_ADDR.split(":");
  pool = await openDatabase();
  connection = new Redis({ host, port: Number(port), maxRetriesPerRequest: null });
  queue = new Queue(REPOPILOT_QUEUE, { connection });
});

after(async () => {
  await worker?.close();
  await queue?.obliterate({ force: true }).catch(() => {});
  await queue?.close();
  await connection?.quit();
  await pool?.end();
});

beforeEach(async () => {
  if (skipRedis) return;
  await worker?.close();
  worker = undefined;
  await queue.obliterate({ force: true });
  await resetDatabase(pool);
  store = createRepoPilotStore(pool, { retryBaseMs: 50 });
});

function startWorker(handlers) {
  const enqueue = bullEnqueue(queue);
  const orchestrator = createOrchestrator({ store, enqueue, handlers, workerId: "bull-1", heartbeatMs: 100, cancelPollMs: 50 });

  worker = new Worker(REPOPILOT_QUEUE, (job) => orchestrator.processJob(job.data), { connection, concurrency: 2, maxStalledCount: 0 });

  return { enqueue, orchestrator };
}

const newRun = async () => (await store.createRun({ owner: OWNER, actor: USER, repo: REPO })).run;

test("a real BullMQ worker drives a run from queued to awaiting_patch", { skip: skipRedis }, async () => {
  const run = await newRun();
  const seen = [];
  const { enqueue } = startWorker({
    ingest: async () => { seen.push("ingest"); return { persist: (tx) => tx.setRunFacts({ commitSha: SHA, defaultBranch: "main" }) }; },
    manifest: async () => { seen.push("manifest"); },
    analyze: async () => { seen.push("analyze"); return { persist: (tx) => tx.insertFindings([finding()]) }; },
  });

  await enqueue({ runId: run.id, stage: "ingest", attempt: 1 });
  await waitFor(async () => (await store.getRun(OWNER, run.id)).state === "awaiting_patch", { label: "awaiting_patch" });

  assert.deepEqual(seen, ["ingest", "manifest", "analyze"]);
  assert.equal((await store.listFindings(OWNER, run.id)).length, 1);
});

test("adding the same job repeatedly through Redis runs it once", { skip: skipRedis }, async () => {
  const run = await newRun();
  let calls = 0;
  const { enqueue } = startWorker({ ingest: async () => { calls += 1; await new Promise((r) => setTimeout(r, 50)); }, manifest: async () => {}, analyze: async () => {} });

  await Promise.all(Array.from({ length: 5 }, () => enqueue({ runId: run.id, stage: "ingest", attempt: 1 })));
  await waitFor(async () => (await store.getRun(OWNER, run.id)).state === "awaiting_patch", { label: "awaiting_patch" });
  await enqueue({ runId: run.id, stage: "ingest", attempt: 1 }); // late duplicate
  await new Promise((r) => setTimeout(r, 200));

  assert.equal(calls, 1);
});

test("a retryable failure becomes a delayed job with the next attempt and then succeeds", { skip: skipRedis }, async () => {
  const run = await newRun();
  let attempts = 0;
  const { enqueue } = startWorker({
    ingest: async () => {
      attempts += 1;
      if (attempts < 3) throw new StageError("rate_limited", "slow down", true);
      return { persist: (tx) => tx.setRunFacts({ commitSha: SHA, defaultBranch: "main" }) };
    },
    manifest: async () => {},
    analyze: async () => {},
  });

  await enqueue({ runId: run.id, stage: "ingest", attempt: 1 });
  await waitFor(async () => (await store.getRun(OWNER, run.id)).state === "awaiting_patch", { label: "awaiting_patch after retries" });

  assert.equal(attempts, 3);
  assert.deepEqual((await store.listStages(OWNER, run.id)).filter((s) => s.stage === "ingest").map((s) => [s.attempt, s.state]), [[1, "failed"], [2, "failed"], [3, "succeeded"]]);
});

test("exhausted retries fail the run and leave no job waiting", { skip: skipRedis }, async () => {
  const run = await newRun();
  const { enqueue } = startWorker({ ingest: async () => { throw new StageError("rate_limited", "slow down", true); } });

  await enqueue({ runId: run.id, stage: "ingest", attempt: 1 });
  await waitFor(async () => (await store.getRun(OWNER, run.id)).state === "failed", { label: "failed" });
  await new Promise((r) => setTimeout(r, 200));

  const { waiting, delayed, active } = await queue.getJobCounts("waiting", "delayed", "active");
  assert.deepEqual({ waiting, delayed, active }, { waiting: 0, delayed: 0, active: 0 });
});

test("recovery re-queues a run whose follow-up job was lost, and the worker finishes it", { skip: skipRedis }, async () => {
  const run = await newRun();
  const { orchestrator } = startWorker({
    ingest: async () => ({ persist: (tx) => tx.setRunFacts({ commitSha: SHA, defaultBranch: "main" }) }),
    manifest: async () => {},
    analyze: async () => {},
  });

  // The run exists in "queued" but its first job was never added (crash after commit).
  await pool.query("UPDATE rp_runs SET updated_at = now() - interval '10 minutes'");
  const before = await queue.getJobCounts("waiting", "delayed");
  assert.equal(before.waiting + before.delayed, 0);

  const summary = await orchestrator.recover({ staleAfterMs: 60_000, idleForMs: 60_000 });
  assert.equal(summary.requeued, 1);

  await waitFor(async () => (await store.getRun(OWNER, run.id)).state === "awaiting_patch", { label: "recovered run to finish" });
});

test("the job in Redis contains identifiers only", { skip: skipRedis }, async () => {
  const run = await newRun();
  const enqueue = bullEnqueue(queue);

  await enqueue({ runId: run.id, stage: "ingest", attempt: 1 }, { delayMs: 60_000 });

  const [job] = await queue.getDelayed();
  assert.deepEqual(job.data, { runId: run.id, stage: "ingest", attempt: 1 });
  assert.equal(job.id, `rp-${run.id}-ingest-1`);
  assert.equal(job.opts.attempts, 1);
});
