import { Worker } from "bullmq";
import IORedis from "ioredis";
import { testRelease } from "./src/test.js";

import { getRelease, updateRelease } from "./src/releaseStore.js";

import { prepareRelease } from "./src/prepare.js";
import { buildRelease } from "./src/build.js";
import { deployRelease } from "./src/deploy.js";
import { verifyRelease } from "./src/verify.js";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null,
});

const worker = new Worker(
  "deployment-queue",
  async (job) => {
    const { releaseId, repoUrl } = job.data;
    console.log("Processing release:", releaseId);

    const release = await getRelease(releaseId);

    if (!release) {
      throw new Error(`Release ${releaseId} not found`);
    }
    console.log("Release found", release);

    let currentStage = "RELEASE";

    try {
      currentStage = "PREPARE";
      // -----------------------------
      // PREPARE START
      // -----------------------------

      await updateRelease(releaseId, {
        status: "RUNNNING",
        currentStage: "PREPARE",
        errorMessage: null,
      });

      const prepared = await prepareRelease({ releaseId, repoUrl });

      console.log("Prepare result", prepared);

      currentStage = "BUILD";
      // -----------------------
      // BUILD
      // -----------------------

      await updateRelease(releaseId, {
        status: "RUNNING",
        currentStage: "BUILD",
        errorMessage: null,
      });
      const built = await buildRelease({
        releaseId,
        workspacePath: prepared.workspacePath,
      });

      console.log("Build result:", built);
      // -----------------------
      // TEMPORARY SUCCESS
      // -----------------------

      await updateRelease(releaseId, {
        status: "SUCCESS",
        currentStage: "BUILD",
        errorMessage: null,
      });

      currentStage = "TEST";

      await updateRelease(releaseId, {
        status: "RUNNING",
        currentStage,
        errorMessage: null,
      });

      const tested = await testRelease({
        releaseId,
        workspacePath: built.workspacePath,
      });

      console.log("Test result:", tested);

      await updateRelease(releaseId, {
        status: "SUCCESS",
        currentStage: "TEST",
        errorMessage: null,
      });

      currentStage = "DEPLOY";

      await updateRelease(releaseId, {
        status: "RUNNING",
        currentStage,
        errorMessage: null,
      });

      const deployed = await deployRelease({
        releaseId,
        workspacePath: tested.workspacePath,
      });

      console.log("Deploy result:", deployed);

      await updateRelease(releaseId, {
        status: "SUCCESS",
        currentStage: "DEPLOY",
        deploymentUrl: deployed.deploymentUrl,
        errorMessage: null,
      });

      currentStage = "VERIFY";

      await updateRelease(releaseId, {
        status: "RUNNING",
        currentStage,
        errorMessage: null,
      });

      const verified = await verifyRelease({
        releaseId,
        deploymentUrl: deployed.deploymentUrl,
      });

      console.log("Verify result:", verified);

      await updateRelease(releaseId, {
        status: "SUCCESS",
        currentStage: "VERIFY",
        errorMessage: null,
      });

      return {
        success: true,
        releaseId,
      };
    } catch (error) {
      console.error(`${currentStage} failed for ${releaseId}`);

      console.error(error);
      await updateRelease(releaseId, {
        status: "FAILED",
        currentStage,
        errorMessage: error.message,
      });
      throw error;
    }
  },
  {
    connection,
  },
);

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
