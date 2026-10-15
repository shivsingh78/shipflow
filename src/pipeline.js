import fs from "fs/promises";
import path from "path";

import { config } from "./config.js";
import { prepareRelease } from "./prepare.js";
import { buildRelease } from "./build.js";
import { testRelease } from "./test.js";
import {
  collectBuildOutput,
  validateArtifact,
  uploadArtifact,
} from "./deploy.js";
import { verifyCandidate, verifyActive } from "./verify.js";
import { activateRelease, revertActivation } from "./activation.js";
import { createSandbox } from "./sandbox.js";
import { notifyRelease } from "./notify.js";
import { logRelease } from "./logStore.js";
import { redactSecrets } from "./runCommand.js";

import {
  getRelease,
  updateRelease,
} from "./releaseStore.js";

const OUTPUT_TAIL_ON_FAILURE = 12_000;

/**
 * Prepare → Build → Test → Deploy (immutable upload) → Verify (candidate)
 * → Activate (switch live pointer, verify live site).
 *
 * The live site only changes in ACTIVATE, after every earlier stage passed,
 * so a failed candidate never replaces the current deployment.
 */
export async function runPipeline({
  releaseId,
  repoUrl,
}) {
  let currentStage = "RELEASE";
  let sandbox = null;
  const releaseRoot = path.join(config.workspaceRoot, releaseId);

  // A failure to write a log line must never hide the real error.
  const log = async (stage, message, level = "INFO") => {
    const text = redactSecrets(message);

    console.log(`[${releaseId}] [${stage}] [${level}] ${text}`);

    try {
      await logRelease({ releaseId, stage, level, message: text });
    } catch (error) {
      console.error(`Failed to persist log for ${releaseId}:`, error.message);
    }
  };

  const stageLog = (stage) => (message, level) =>
    log(stage, message, level);

  const enterStage = async (stage) => {
    currentStage = stage;
    await updateRelease(releaseId, {
      status: "RUNNING",
      currentStage,
    });
    await log(stage, `${stage} stage started`);
  };

  try {
    const release = await getRelease(releaseId);

    if (!release) {
      throw new Error(`Release ${releaseId} not found`);
    }

    // -----------------------
    // PREPARE
    // -----------------------

    await enterStage("PREPARE");

    const prepared = await prepareRelease({
      releaseId,
      repoUrl,
      log: stageLog("PREPARE"),
    });

    await updateRelease(releaseId, { commitSha: prepared.commitSha });
    await log("PREPARE", "Repository prepared successfully");

    // -----------------------
    // BUILD
    // -----------------------

    await enterStage("BUILD");

    sandbox = await createSandbox({
      releaseId,
      workspacePath: prepared.workspacePath,
    });

    const built = await buildRelease({
      releaseId,
      workspacePath: prepared.workspacePath,
      sandbox,
      log: stageLog("BUILD"),
    });

    await log("BUILD", "Build completed successfully");

    // -----------------------
    // TEST
    // -----------------------

    await enterStage("TEST");

    const tested = await testRelease({
      releaseId,
      workspacePath: prepared.workspacePath,
      sandbox,
      packageJson: built.packageJson,
      packageManager: built.packageManager,
      log: stageLog("TEST"),
    });

    await updateRelease(releaseId, { testStatus: tested.testStatus });
    await log("TEST", `Test stage finished: ${tested.testStatus}`);

    // -----------------------
    // DEPLOY: upload an immutable artifact; the live site is untouched.
    // -----------------------

    await enterStage("DEPLOY");

    const artifactDirectory = path.join(releaseRoot, "artifact");
    const outputDirectory = await collectBuildOutput({
      sandbox,
      destination: artifactDirectory,
    });

    await sandbox.destroy();
    sandbox = null;

    const artifact = await validateArtifact(artifactDirectory);

    await log(
      "DEPLOY",
      `Validated ${outputDirectory}/: ${artifact.files.length} files, ${artifact.totalBytes} bytes` +
        (artifact.skippedSymlinks
          ? `, ${artifact.skippedSymlinks} symlinks skipped`
          : "")
    );

    const uploaded = await uploadArtifact({
      releaseId,
      artifactDirectory,
      files: artifact.files,
    });

    await updateRelease(releaseId, {
      artifactPath: uploaded.artifactPath,
      deploymentUrl: `/preview/${releaseId}/`,
    });

    await log(
      "DEPLOY",
      `Uploaded ${uploaded.fileCount} files to ${uploaded.artifactPath}`
    );

    // -----------------------
    // VERIFY: HTTP check of the candidate before it goes live.
    // -----------------------

    await enterStage("VERIFY");

    const candidate = await verifyCandidate({ releaseId });

    await log(
      "VERIFY",
      `Candidate served HTTP ${candidate.statusCode} (${candidate.contentType})`
    );

    // -----------------------
    // ACTIVATE: switch the live pointer, then check the live site.
    // -----------------------

    await enterStage("ACTIVATE");

    const activation = await activateRelease({
      releaseId,
      action: "DEPLOY",
    });

    try {
      const live = await verifyActive({ releaseId });

      await log(
        "ACTIVATE",
        `Live site serves ${releaseId}: HTTP ${live.statusCode} (${live.contentType})`
      );
    } catch (error) {
      const reverted = await revertActivation(activation);

      throw new Error(
        `Live check failed after activation (${error.message}); ` +
          (reverted
            ? `restored previous release ${activation.previousReleaseId ?? "(none)"}`
            : "a newer activation has since replaced it")
      );
    }

    // -----------------------
    // SUCCESS
    // -----------------------

    await updateRelease(releaseId, {
      status: "SUCCESS",
      currentStage: "ACTIVATE",
      publicDeploymentUrl: config.publicSiteUrl,
    });

    try {
      await notifyRelease({
        releaseId,
        type: "RELEASE_SUCCESS",
        message: `Release ${releaseId} deployed and verified (tests: ${tested.testStatus}).`,
      });
    } catch (notifyError) {
      console.error("Failed to create success notification:", notifyError.message);
    }

    return {
      success: true,
      releaseId,
      previousReleaseId: activation.previousReleaseId,
    };

  } catch (error) {
    const errorMessage = redactSecrets(error.message);

    if (error.result?.output) {
      await log(
        currentStage,
        `Command output (last ${OUTPUT_TAIL_ON_FAILURE} chars):\n${error.result.output.slice(
          -OUTPUT_TAIL_ON_FAILURE
        )}`,
        "ERROR"
      );
    }

    await log(currentStage, errorMessage, "ERROR");

    console.error(`${currentStage} failed for ${releaseId}`);

    try {
      await updateRelease(releaseId, {
        status: "FAILED",
        currentStage,
        errorMessage,
      });
    } catch (updateError) {
      console.error("Failed to mark release as failed:", updateError.message);
    }

    try {
      await notifyRelease({
        releaseId,
        type: "RELEASE_FAILED",
        message:
          `Release ${releaseId} failed during ${currentStage}: ${errorMessage}`,
      });
    } catch (notifyError) {
      console.error(
        "Failed to create failure notification:",
        notifyError.message
      );
    }

    throw error;
  } finally {
    if (sandbox) {
      await sandbox.destroy().catch((error) =>
        console.error("Failed to remove sandbox:", error.message)
      );
    }

    await fs
      .rm(releaseRoot, { recursive: true, force: true })
      .catch((error) =>
        console.error("Failed to clean workspace:", error.message)
      );
  }
}
