import fs from "fs/promises";
import path from "path";

import { config } from "./config.js";
import { prepareRelease } from "./prepare.js";
import { buildRelease, DEFAULT_BUILD } from "./build.js";
import { testRelease } from "./test.js";
import {
  collectBuildOutput,
  validateArtifact,
  uploadArtifact,
  artifactPrefix,
} from "./deploy.js";
import { activateRelease, revertActivation } from "./activation.js";
import { createSandbox } from "./sandbox.js";
import { notifyRelease } from "./notify.js";
import { logRelease } from "./logStore.js";
import { redactSecrets } from "./runCommand.js";
import { getArtifactStore, downloadArtifact } from "./artifactStore.js";
import { getTarget } from "./targets/index.js";
import { pruneArtifacts } from "./retention.js";

import {
  getRelease,
  updateRelease,
  transitionRelease,
} from "./releaseStore.js";

const OUTPUT_TAIL_ON_FAILURE = 12_000;

export class CancelledError extends Error {
  constructor() {
    super("Cancelled by user");
    this.name = "CancelledError";
  }
}

/**
 * Redact worker-environment secrets and any project secrets resolved for
 * this release.
 */
export function redactAll(text, secretValues = []) {
  let result = redactSecrets(text);

  for (const value of secretValues) {
    if (value && value.length >= 6) {
      result = result.split(value).join("[REDACTED]");
      // Also catch the value as it appears line-by-line (e.g. a PEM key).
      for (const line of value.split("\n")) {
        if (line.trim().length >= 16) result = result.split(line).join("[REDACTED]");
      }
    }
  }

  return result;
}

/**
 * Normalized project configuration for a release. Releases created with
 * `shipflow deploy <repoUrl>` (no shipflow.yml) use the legacy defaults:
 * auto-detected build, the "shipflow" target, project "default".
 */
export function releaseSettings(release) {
  const stored = release.config;

  if (!stored) {
    return {
      build: DEFAULT_BUILD,
      target: "shipflow",
      targetConfig: {},
      verification: { path: "/", expectStatus: 200 },
    };
  }

  return {
    build: stored.build,
    target: stored.deployment.target,
    targetConfig: stored.deployment[stored.deployment.target] ?? {},
    verification: stored.verification,
  };
}

/**
 * Context handed to deployment-target adapters (see src/targets/index.js).
 * `ensureArtifactDir` returns a local copy of the build output, downloading
 * it from artifact storage when the local one no longer exists (rollback).
 */
export function createTargetContext({
  project,
  releaseId,
  artifactPath,
  settings,
  secrets,
  store,
  localArtifactDir = null,
  scratchDir,
  log,
}) {
  let artifactDir = localArtifactDir;

  return {
    project,
    releaseId,
    targetConfig: settings.targetConfig,
    verification: settings.verification,
    secrets,
    log,
    async ensureArtifactDir() {
      if (!artifactDir) {
        artifactDir = path.join(scratchDir, `artifact-${releaseId}`);
        await fs.rm(artifactDir, { recursive: true, force: true });
        await fs.mkdir(artifactDir, { recursive: true });
        const count = await downloadArtifact(store, artifactPath, artifactDir);

        if (count === 0) {
          throw new Error(`Artifacts for release ${releaseId} are missing from storage`);
        }
      }

      return artifactDir;
    },
  };
}

/**
 * Prepare → Build → Test → Deploy (store artifact + transfer to target)
 * → Verify (candidate) → Activate (switch, verify live).
 *
 * The live site only changes in ACTIVATE, after every earlier stage passed,
 * so a failed candidate never replaces the current deployment.
 * Releases in "check" mode (pull requests) stop after TEST and never see
 * deployment secrets.
 */
export async function runPipeline({ releaseId, secretStore }) {
  let currentStage = "RELEASE";
  let sandbox = null;
  let secretValues = [];
  let cancelWatch = null;
  let cancelled = false;
  const releaseRoot = path.join(config.workspaceRoot, releaseId);

  // A failure to write a log line must never hide the real error.
  const log = async (stage, message, level = "INFO") => {
    const text = redactAll(message, secretValues);

    console.log(`[${releaseId}] [${stage}] [${level}] ${text}`);

    try {
      await logRelease({ releaseId, stage, level, message: text });
    } catch (error) {
      console.error(`Failed to persist log for ${releaseId}:`, error.message);
    }
  };

  const stageLog = (stage) => (message, level) => log(stage, message, level);

  const throwIfCancelled = async () => {
    if (cancelled || (await getRelease(releaseId))?.cancel_requested) {
      cancelled = true;
      throw new CancelledError();
    }
  };

  const enterStage = async (stage, { cancellable = true } = {}) => {
    if (cancellable) await throwIfCancelled();
    currentStage = stage;
    await updateRelease(releaseId, { currentStage });
    await log(stage, `${stage} stage started`);
  };

  // Claim the release. A duplicate delivery of the same job (or a job for a
  // release that was cancelled while queued) finds it no longer QUEUED.
  const claimed = await transitionRelease(releaseId, ["QUEUED"], "RUNNING");

  if (!claimed) {
    const existing = await getRelease(releaseId);
    console.log(
      `Skipping ${releaseId}: status is ${existing?.status ?? "missing"}, not QUEUED (duplicate or cancelled job)`
    );
    return { skipped: true, releaseId };
  }

  const release = claimed;
  const settings = releaseSettings(release);
  const target = getTarget(settings.target);
  const project = release.project;

  try {
    if (release.cancel_requested) throw new CancelledError();

    // Cancellation while a command runs: stop the sandbox, which ends it.
    cancelWatch = setInterval(async () => {
      try {
        if (!cancelled && (await getRelease(releaseId))?.cancel_requested) {
          cancelled = true;
          await sandbox?.destroy();
        }
      } catch {
        // Polling errors are retried on the next tick.
      }
    }, 3000);

    await checkDiskSpace();

    const store = await getArtifactStore();

    // -----------------------
    // PREPARE
    // -----------------------

    await enterStage("PREPARE");

    const prepared = await prepareRelease({
      releaseId,
      repoUrl: release.repo_url,
      ref: release.ref,
      store,
      snapshot: release.mode === "deploy",
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
      buildEnv: settings.build.env,
    });

    const built = await buildRelease({
      releaseId,
      workspacePath: prepared.workspacePath,
      sandbox,
      buildConfig: settings.build,
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
      testConfig: settings.build.test,
      log: stageLog("TEST"),
    });

    await updateRelease(releaseId, { testStatus: tested.testStatus });
    await log("TEST", `Test stage finished: ${tested.testStatus}`);

    if (release.mode === "check") {
      await throwIfCancelled();
      await updateRelease(releaseId, { status: "SUCCESS", currentStage: "TEST" });
      await safeNotify(releaseId, "CHECK_SUCCESS", `Checks passed for ${release.ref ?? "default branch"} (tests: ${tested.testStatus}).`);
      return { success: true, releaseId, mode: "check" };
    }

    // -----------------------
    // DEPLOY: store an immutable artifact, then put the candidate on the
    // target. The live site is untouched.
    // -----------------------

    await enterStage("DEPLOY");

    const artifactDirectory = path.join(releaseRoot, "artifact");
    const outputDirectory = await collectBuildOutput({
      sandbox,
      destination: artifactDirectory,
      output: settings.build.output,
    });

    // Untrusted code is finished: the sandbox is gone before any
    // deployment secret is decrypted.
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
      store,
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
      `Stored ${uploaded.fileCount} files in ${store.describe()}/${uploaded.artifactPath}`
    );

    const secretNames = target.requiredSecrets(settings.targetConfig);
    const secrets = secretNames.length
      ? await secretStore.resolve(project, secretNames)
      : {};
    secretValues = Object.values(secrets);

    const ctx = createTargetContext({
      project,
      releaseId,
      artifactPath: uploaded.artifactPath,
      settings,
      secrets,
      store,
      localArtifactDir: artifactDirectory,
      scratchDir: releaseRoot,
      log: stageLog("DEPLOY"),
    });

    const preparedTarget = await target.prepare(ctx);
    await log("DEPLOY", `Target "${target.name}": ${preparedTarget.detail}`);

    // -----------------------
    // VERIFY: check the candidate before it goes live.
    // -----------------------

    await enterStage("VERIFY");

    const candidate = await target.verifyCandidate(ctx);
    await log("VERIFY", `Candidate verified (${target.capabilities.candidateVerification}): ${candidate.detail}`);

    // -----------------------
    // ACTIVATE: switch the live release, then check the live site.
    // Cancellation is no longer honoured from here on.
    // -----------------------

    await throwIfCancelled();
    clearInterval(cancelWatch);
    cancelWatch = null;

    await enterStage("ACTIVATE", { cancellable: false });

    const activation = await activateRelease({
      project,
      releaseId,
      action: "DEPLOY",
      apply: () => target.activate(ctx),
    });

    let live;

    try {
      live = await target.verifyLive(ctx);
      await log("ACTIVATE", live.detail);
    } catch (error) {
      const reverted = await revertToPrevious({
        project,
        releaseId,
        previousReleaseId: activation.previousReleaseId,
        target,
        settings,
        secrets,
        store,
        scratchDir: releaseRoot,
        log: stageLog("ACTIVATE"),
      });

      throw new Error(
        `Live check failed after activation (${error.message}); ${reverted}`
      );
    }

    // -----------------------
    // SUCCESS
    // -----------------------

    await updateRelease(releaseId, {
      status: "SUCCESS",
      currentStage: "ACTIVATE",
      publicDeploymentUrl: target.liveUrl(ctx) ?? undefined,
    });

    await safeNotify(
      releaseId,
      "RELEASE_SUCCESS",
      `Release ${releaseId} deployed and verified (tests: ${tested.testStatus}).`
    );

    try {
      const pruned = await pruneArtifacts({ project, store });
      if (pruned.length > 0) {
        await log("ACTIVATE", `Retention: removed stored artifacts of ${pruned.length} old release(s)`);
      }
    } catch (error) {
      await log("ACTIVATE", `Retention cleanup failed: ${error.message}`, "WARN");
    }

    return {
      success: true,
      releaseId,
      previousReleaseId: activation.previousReleaseId,
    };
  } catch (error) {
    const isCancel = error instanceof CancelledError || cancelled;
    const errorMessage = isCancel ? "Cancelled by user" : redactAll(error.message, secretValues);

    if (error.result?.output && !isCancel) {
      await log(
        currentStage,
        `Command output (last ${OUTPUT_TAIL_ON_FAILURE} chars):\n${error.result.output.slice(
          -OUTPUT_TAIL_ON_FAILURE
        )}`,
        "ERROR"
      );
    }

    await log(currentStage, errorMessage, isCancel ? "WARN" : "ERROR");

    try {
      await updateRelease(releaseId, {
        status: isCancel ? "CANCELLED" : "FAILED",
        currentStage,
        errorMessage,
      });
    } catch (updateError) {
      console.error("Failed to mark release as failed:", updateError.message);
    }

    await safeNotify(
      releaseId,
      isCancel ? "RELEASE_CANCELLED" : release.mode === "check" ? "CHECK_FAILED" : "RELEASE_FAILED",
      `Release ${releaseId} ${isCancel ? "was cancelled" : "failed"} during ${currentStage}: ${errorMessage}`
    );

    if (isCancel) {
      return { cancelled: true, releaseId };
    }

    throw new Error(errorMessage);
  } finally {
    if (cancelWatch) clearInterval(cancelWatch);

    if (sandbox) {
      await sandbox.destroy().catch((error) =>
        console.error("Failed to remove sandbox:", error.message)
      );
    }

    secretValues = [];

    await fs
      .rm(releaseRoot, { recursive: true, force: true })
      .catch((error) =>
        console.error("Failed to clean workspace:", error.message)
      );
  }
}

async function safeNotify(releaseId, type, message) {
  try {
    await notifyRelease({ releaseId, type, message });
  } catch (error) {
    console.error(`Failed to create ${type} notification:`, error.message);
  }
}

/**
 * Switch a project back to `previousReleaseId` after a failed live check.
 * When nothing was live before (first deployment), take the failed release
 * offline instead, so it is never left serving. Returns a sentence
 * describing what happened.
 */
export async function revertToPrevious({
  project,
  releaseId,
  previousReleaseId,
  target,
  settings,
  secrets,
  store,
  scratchDir,
  log,
  revert = revertActivation,
  loadRelease = getRelease,
}) {
  if (!previousReleaseId) {
    try {
      const failedCtx = createTargetContext({
        project,
        releaseId,
        settings,
        secrets,
        store,
        scratchDir,
        log,
      });

      // Records a null pointer: the project has no live release.
      const reverted = await revert({
        project,
        releaseId,
        previousReleaseId: null,
        apply: () => target.deactivate(failedCtx),
      });

      return reverted
        ? `no earlier release existed, so ${releaseId} was taken offline and is not served`
        : "a newer activation has since replaced it";
    } catch (error) {
      return `no earlier release existed and taking ${releaseId} offline ALSO FAILED: ${error.message}`;
    }
  }

  try {
    const previous = await loadRelease(previousReleaseId);
    const previousCtx = createTargetContext({
      project,
      releaseId: previousReleaseId,
      artifactPath: previous?.artifact_path ?? artifactPrefix(previousReleaseId),
      settings,
      secrets,
      store,
      scratchDir,
      log,
    });

    const reverted = await revert({
      project,
      releaseId,
      previousReleaseId,
      apply: () => target.activate(previousCtx),
    });

    return reverted
      ? `restored previous release ${previousReleaseId}`
      : "a newer activation has since replaced it";
  } catch (error) {
    return `ALSO FAILED to restore ${previousReleaseId}: ${error.message}`;
  }
}

async function checkDiskSpace() {
  await fs.mkdir(config.workspaceRoot, { recursive: true });

  const stats = await fs.statfs(config.workspaceRoot);
  const freeMb = Math.floor((stats.bavail * stats.bsize) / (1024 * 1024));

  if (freeMb < config.minFreeDiskMb) {
    throw new Error(
      `Only ${freeMb} MB free in ${config.workspaceRoot}; need at least ${config.minFreeDiskMb} MB (SHIPFLOW_MIN_FREE_DISK_MB)`
    );
  }
}
