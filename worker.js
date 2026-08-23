import { Worker } from "bullmq";
import IORedis from "ioredis";

const connection = new IORedis({
  host: "127.0.0.1",
  port: 6379,
  maxRetriesPerRequest: null,
});

const worker = new Worker(
  "deployment-queue",
  async (job) => {
    console.log("Processing deployment job...");
    console.log("Job ID:", job.id);
    console.log("Deployment ID:", job.data.id);

    const id = job.data.id;

    // This is where the actual deployment logic
    // will happen.

    console.log(`Deployment ${id} processed successfully`);

    return {
      success: true,
      id,
    };
  },
  {
    connection,
  }
);

worker.on("completed", (job) => {
  console.log(`✅ Job ${job.id} completed`);
});

worker.on("failed", (job, err) => {
  console.error(`❌ Job ${job?.id} failed`);
  console.error(err);
});

console.log("🚀 Deployment worker started");