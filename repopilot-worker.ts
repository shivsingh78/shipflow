import os from "os";
import { Worker } from "bullmq";

import { pool } from "./src/db.js";
import { config } from "./src/config.js";
import { connection, bullConnection } from "./src/queue.js";
import { runMigrations } from "./src/migrate.js";
import { getArtifactStore } from "./src/artifactStore.js";
import { errorMessage } from "./src/errors.js";
import { heartbeatPrefix } from "./src/repopilot/capabilities.js";
import type { Heartbeat } from "./src/repopilot/capabilities.js";
import { loadRepoPilotConfig, loadWorkerSecrets } from "./src/repopilot/config.js";
import { createEvidenceStore } from "./src/repopilot/evidence.js";
import { createGithubClient } from "./src/repopilot/github.js";
import { createOrchestrator } from "./src/repopilot/orchestrator.js";
import { REPOPILOT_QUEUE, bullEnqueue, createRepoPilotQueue } from "./src/repopilot/queue.js";
import type { StageJob } from "./src/repopilot/queue.js";
import { sanitizeForStorage } from "./src/repopilot/redact.js";
import { createAnalyzeHandler } from "./src/repopilot/stagesAnalyze.js";
import { createIngestHandler, createManifestHandler } from "./src/repopilot/stagesIngest.js";
import { createPatchHandler } from "./src/repopilot/stagesPatch.js";
import { createPrHandler } from "./src/repopilot/stagesPr.js";
import { createVerifyHandler } from "./src/repopilot/stagesVerify.js";
import { createRepoPilotStore } from "./src/repopilot/store.js";
import { createSandboxRunner } from "./src/repopilot/verifySandbox.js";

// Structured, redacted logs. Run/stage ids for correlation; never source code,
// prompts, tokens or provider keys.
function logLine(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), service: "repopilot-worker", instance: config.instance, ...(sanitizeForStorage(fields) as object) }));
}

const rp = loadRepoPilotConfig();

if (!rp.enabled) {
  console.error("RepoPilot is disabled. Set REPOPILOT=enabled to start this worker.");
  process.exit(1);
}

for (const problem of rp.problems) {
  console.warn(`[repopilot] ${problem}`);
}

const secrets = loadWorkerSecrets();

if (!secrets.githubToken) {
  console.warn("[repopilot] REPOPILOT_GITHUB_TOKEN is not set: repositories cannot be read and no pull request can be opened.");
}

if (!secrets.credentialPrivateKey) {
  console.warn("[repopilot] REPOPILOT_CREDENTIAL_PRIVATE_KEY(_FILE) is not set: stored AI provider keys cannot be read, so analysis and patching will fail.");
}

await runMigrations();

const artifactStore = await getArtifactStore();
const store = createRepoPilotStore(pool, { maxActiveRuns: rp.limits.maxActiveRuns });
const evidence = createEvidenceStore(artifactStore);
const github = secrets.githubToken ? createGithubClient({ token: secrets.githubToken }) : null;
const sandbox = createSandboxRunner(rp.sandboxMode);
const queue = createRepoPilotQueue(bullConnection);

console.warn(
  sandbox.status === "ready"
    ? "[repopilot] Sandbox verification is ENABLED."
    : `[repopilot] Sandbox verification is ${sandbox.status.toUpperCase()}: ${sandbox.reason ?? ""} Patches will be reported as inconclusive.`
);

const deps = { store, github, evidence, config: rp };
const ai = { credentialPrivateKey: secrets.credentialPrivateKey, model: rp.aiModel, timeoutMs: rp.limits.aiTimeoutMs };
const workerId = `${os.hostname()}:${process.pid}`;

const orchestrator = createOrchestrator({
  store,
  enqueue: bullEnqueue(queue),
  workerId,
  log: logLine,
  handlers: {
    ingest: createIngestHandler(deps),
    manifest: createManifestHandler(deps),
    analyze: createAnalyzeHandler({ ...deps, ai }),
    patch: createPatchHandler({ ...deps, ai }),
    verify: createVerifyHandler({ store, evidence, config: rp, sandbox }),
    pr: createPrHandler(deps),
  },
});

const concurrency = Math.max(1, Number(process.env.REPOPILOT_WORKER_CONCURRENCY || 1));

const worker = new Worker<StageJob>(REPOPILOT_QUEUE, (job) => orchestrator.processJob(job.data), {
  connection: bullConnection,
  concurrency,
  // A stalled job is failed and recovered by the reconciler, never silently re-run.
  maxStalledCount: 0,
});

worker.on("failed", (job, error) => {
  // Reached only for unexpected errors (e.g. the database was down). The failed
  // job stays in Redis as the dead-letter record; the reconciler repairs the run.
  logLine({ event: "job_failed", jobId: job?.id, error: errorMessage(error) });
});

const heartbeatKey = `${heartbeatPrefix(config.instance)}${os.hostname()}:${process.pid}`;

async function heartbeat(): Promise<void> {
  const beat: Heartbeat = { at: new Date().toISOString(), github: github !== null, credentialDecryption: secrets.credentialPrivateKey !== null, sandbox: sandbox.status, concurrency };

  try {
    await connection.set(heartbeatKey, JSON.stringify(beat), "EX", 30);
  } catch (error) {
    logLine({ event: "heartbeat_failed", error: errorMessage(error) });
  }
}

async function maintenance(): Promise<void> {
  try {
    const result = await orchestrator.recover({ staleAfterMs: 120_000, idleForMs: 120_000 });

    if (result.interrupted > 0 || result.requeued > 0) logLine({ event: "recovered", ...result });
  } catch (error) {
    logLine({ event: "recovery_failed", error: errorMessage(error) });
  }
}

async function retention(): Promise<void> {
  try {
    const pruned = await store.pruneEvidence(rp.limits.evidenceRetentionDays);

    if (pruned.artifactKeys.length > 0) await evidence.remove(pruned.artifactKeys);
    if (pruned.logRows > 0 || pruned.artifactKeys.length > 0) logLine({ event: "evidence_pruned", logRows: pruned.logRows, artifacts: pruned.artifactKeys.length });
  } catch (error) {
    logLine({ event: "retention_failed", error: errorMessage(error) });
  }
}

await heartbeat();
await maintenance();
const timers = [setInterval(heartbeat, 10_000), setInterval(maintenance, 60_000), setInterval(retention, 6 * 60 * 60 * 1000)];

logLine({ event: "started", concurrency, sandbox: sandbox.status, github: github !== null, credentialDecryption: secrets.credentialPrivateKey !== null, retentionDays: rp.limits.evidenceRetentionDays });

async function shutdown(signal: string): Promise<void> {
  logLine({ event: "shutdown", signal });
  for (const timer of timers) clearInterval(timer);
  // Running stages are aborted (and retried later); no new work is accepted.
  orchestrator.shutdown();
  await worker.close();
  await queue.close();
  await connection.del(heartbeatKey).catch(() => undefined);
  await pool.end().catch(() => undefined);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
