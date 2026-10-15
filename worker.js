import { Worker } from "bullmq";
import { config } from "./src/config.js";
import { connection } from "./src/queue.js";
import { pool } from "./src/db.js";
import { runMigrations } from "./src/migrate.js";
import { removeOrphanedSandboxes } from "./src/sandbox.js";
import { runPipeline } from "./src/pipeline.js";

if (!config.s3.bucket) {
  console.error("S3_BUCKET_NAME must be set");
  process.exit(1);
}

if (!config.apiToken) {
  console.error("SHIPFLOW_API_TOKEN must be set (used for candidate health checks)");
  process.exit(1);
}

await runMigrations();
await removeOrphanedSandboxes();

const worker = new Worker(
  "deployment-queue",
  async (job) => {
    const {
      releaseId,
      repoUrl,
    } = job.data;

    console.log(
      `Processing release: ${releaseId}`
    );

    return await runPipeline({
      releaseId,
      repoUrl,
    });
  },
  {
    connection,
    concurrency: config.workerConcurrency,
  }
);

worker.on("completed", (job) => {
  console.log(`✅ Job ${job.id} completed`);
});

worker.on("failed", (job, err) => {
  console.error(`❌ Job ${job?.id} failed: ${err.message}`);
});

console.log(
  `🚀 Deployment worker started (sandbox: ${config.sandbox}, concurrency: ${config.workerConcurrency})`
);

async function shutdown(signal) {
  console.log(`${signal} received, finishing current job before exit`);
  await worker.close();
  await pool.end().catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
