import { Worker } from "bullmq";
import IORedis from "ioredis";
import { getRelease, updateRelease } from "./src/releaseStore.js";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379) ,
  maxRetriesPerRequest: null,
});

const worker = new Worker(
  'deployment-queue',
  async (job) => {
    const {releaseId,repoUrl} = job.data;
    console.log("Processing release:", releaseId);

    const release = await getRelease(releaseId);

    if(!release){
      throw new Error(`Release ${releaseId} not found`);
    }
    console.log("Release found", release);
    
    await updateRelease(releaseId, {
      status:"RUNNING",
      currentStage: "RELEASE"
    });
    console.log("Release status",await getRelease(releaseId));

    return {
      success: true,
      releaseId,
      repoUrl
    }  
  },
  {
    connection
  }
)



worker.on("completed", (job) => {
  console.log(`✅ Job ${job.id} completed`);
});

worker.on("failed", (job, err) => {
  console.error(`❌ Job ${job?.id} failed`);
  console.error(err);
});

console.log("🚀 Deployment worker started");






// const worker = new Worker(
//   "deployment-queue",
//   async (job) => {
//     console.log("Processing deployment job...");
//     console.log("Job ID:", job.id);
//     console.log("Deployment ID:", job.data.id);

//     const id = job.data.id;

//     // This is where the actual deployment logic
//     // will happen.

//     console.log(`Deployment ${id} processed successfully`);

//     return {
//       success: true,
//       id,
//     };
//   },
//   {
//     connection,
//   }
// );
