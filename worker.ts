import os from "os";
import { Worker } from "bullmq";
import { config } from "./src/config.js";
import type { ReleaseJobData } from "./src/queue.js";
import { connection, bullConnection, deployQueue } from "./src/queue.js";
import { pool } from "./src/db.js";
import { runMigrations } from "./src/migrate.js";
import { removeOrphanedSandboxes } from "./src/sandbox.js";
import { runPipeline } from "./src/pipeline.js";
import { getArtifactStore } from "./src/artifactStore.js";
import { createSecretStore, parseSecretsKey } from "./src/secrets.js";
import { reconcileReleases } from "./src/reconcile.js";
import { pruneLogs } from "./src/retention.js";
import { transitionRelease } from "./src/releaseStore.js";
import { errorMessage } from "./src/errors.js";

if (!config.apiToken) {
  console.error("SHIPFLOW_API_TOKEN must be set (used for candidate health checks)");
  process.exit(1);
}

const store = await getArtifactStore();
const secretStore = createSecretStore({ key: parseSecretsKey(config.secretsKey) });

await runMigrations();
await removeOrphanedSandboxes();

if (config.sandbox === "docker" && !config.egressProxy) {
  console.warn(
    "[sandbox] No SHIPFLOW_EGRESS_PROXY: dependency installs have unrestricted network access " +
      `on Docker network "${config.sandboxNetwork}". Use the docker-compose setup for the restricted network.`
  );
}

const worker = new Worker<ReleaseJobData>(
  "deployment-queue",
  async (job) => {
    console.log(`Processing release: ${job.data.releaseId}`);
    return await runPipeline({ releaseId: job.data.releaseId, secretStore });
  },
  {
    connection: bullConnection,
    concurrency: config.workerConcurrency,
    // Deploy stages have side effects; a job whose worker died is failed
    // and reconciled, never silently re-run.
    maxStalledCount: 0,
  }
);

worker.on("completed", (job) => {
  console.log(`✅ Job ${job.id} completed`);
});

worker.on("failed", async (job, err) => {
  console.error(`❌ Job ${job?.id} failed: ${err.message}`);

  // A stalled job fails without running the pipeline's own error handling.
  if (job?.data.releaseId) {
    await transitionRelease(
      job.data.releaseId,
      ["QUEUED", "RUNNING"],
      "FAILED",
      `Job failed: ${err.message}`
    ).catch(() => {});
  }
});

const heartbeatKey = `shipflow:worker:${config.instance}:${os.hostname()}:${process.pid}`;
const startedAt = new Date().toISOString();

async function maintenance() {
  try {
    await connection.set(
      heartbeatKey,
      JSON.stringify({
        startedAt,
        at: new Date().toISOString(),
        concurrency: config.workerConcurrency,
        sandbox: config.sandbox,
        sandboxNetwork: config.sandboxNetwork,
        egressProxy: Boolean(config.egressProxy),
        artifactStore: store.describe(),
      }),
      "EX",
      30
    );
  } catch (error) {
    console.error("Heartbeat failed:", errorMessage(error));
  }
}

async function reconcile() {
  try {
    const fixed = await reconcileReleases(deployQueue);
    if (fixed.length) console.log(`Reconciled orphaned releases: ${fixed.join(", ")}`);
    const pruned = await pruneLogs();
    if (pruned) console.log(`Pruned ${pruned} old log rows`);
  } catch (error) {
    console.error("Reconciliation failed:", errorMessage(error));
  }
}

await maintenance();
await reconcile();
const heartbeatTimer = setInterval(maintenance, 10_000);
const reconcileTimer = setInterval(reconcile, 60 * 60 * 1000);

console.log(
  `🚀 Deployment worker started (sandbox: ${config.sandbox}, network: ${config.sandboxNetwork}, ` +
    `artifacts: ${store.describe()}, concurrency: ${config.workerConcurrency})`
);

async function shutdown(signal: string) {
  console.log(`${signal} received, finishing current job before exit`);
  clearInterval(heartbeatTimer);
  clearInterval(reconcileTimer);
  await worker.close();
  await connection.del(heartbeatKey).catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
