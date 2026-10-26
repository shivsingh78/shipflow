import fs from "fs/promises";
import path from "path";

import { config } from "./config.js";
import { errorMessage } from "./errors.js";
import { prepareRelease } from "./prepare.js";
import { DEFAULT_BUILD } from "./build.js";
import type { BuildConfig, ReleaseLog } from "./build.js";
import { uploadArtifact, artifactPrefix } from "./deploy.js";
import { artifactOf, imageKey, imagePrefix } from "./artifacts.js";
import type { Artifact, ArtifactRecord } from "./artifacts.js";
import { detectStrategy, getStrategy } from "./strategies/index.js";
import type { LocalArtifact, StrategyInput } from "./strategies/types.js";
import { activateRelease, revertActivation } from "./activation.js";
import { createSandbox } from "./sandbox.js";
import { notifyRelease } from "./notify.js";
import { logRelease } from "./logStore.js";
import { redactSecrets } from "./runCommand.js";
import { getArtifactStore, downloadArtifact, downloadObject, contentTypeFor } from "./artifactStore.js";
import type { ArtifactStore } from "./artifactStore.js";
import type { SecretStore } from "./secrets.js";
import type { ProjectConfig, RuntimeConfig } from "../cli/lib/projectConfig.js";
import { getTarget } from "./targets/index.js";
import type {
  DeploymentTarget,
  TargetConfig,
  TargetContext,
  TargetSecrets,
  Verification,
} from "./targets/types.js";
import { pruneArtifacts } from "./retention.js";

import {
  getRelease,
  updateRelease,
  transitionRelease,
} from "./releaseStore.js";

const OUTPUT_TAIL_ON_FAILURE = 12_000;

/** Normalized per-release settings (see releaseSettings). */
export interface ReleaseSettings {
  build: BuildConfig;
  /** Container runtime settings (image targets only). */
  runtime: RuntimeConfig | null;
  target: string;
  targetConfig: TargetConfig;
  verification: Verification;
}

export interface TargetContextOptions {
  project: string;
  // Null only for diagnostics that run outside any release (shipflow doctor).
  releaseId: string | null;
  /** What is deployed; null for diagnostics that run outside any release. */
  artifact?: Artifact | null;
  settings: Pick<ReleaseSettings, "targetConfig" | "verification"> & { runtime?: RuntimeConfig | null };
  secrets: TargetSecrets;
  store: ArtifactStore;
  localArtifactDir?: string | null;
  localImageArchive?: string | null;
  scratchDir?: string;
  log: ReleaseLog;
}

export interface RevertToPreviousOptions {
  project: string;
  releaseId: string;
  previousReleaseId: string | null;
  target: DeploymentTarget;
  settings: ReleaseSettings;
  secrets: TargetSecrets;
  store: ArtifactStore;
  scratchDir: string;
  log: ReleaseLog;
  revert?: typeof revertActivation;
  loadRelease?: (releaseId: string) => Promise<ArtifactRecord | null | undefined>;
}

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
export function redactAll(text: string, secretValues: string[] = []): string {
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
export function releaseSettings(release: {
  config?: ProjectConfig | null;
}): ReleaseSettings {
  const stored = release.config;

  if (!stored) {
    return {
      build: DEFAULT_BUILD,
      runtime: null,
      target: "shipflow",
      targetConfig: {},
      verification: { path: "/", expectStatus: 200 },
    };
  }

  const { deployment } = stored;
  let targetConfig: TargetConfig;

  switch (deployment.target) {
    case "ssh":
      targetConfig = deployment.ssh;
      break;
    case "docker":
      targetConfig = deployment.docker;
      break;
    case "kubernetes":
      targetConfig = deployment.kubernetes;
      break;
    default:
      targetConfig = deployment.shipflow ?? {};
  }

  return {
    build: stored.build,
    runtime: stored.runtime ?? null,
    target: deployment.target,
    targetConfig,
    verification: stored.verification,
  };
}

/** Secret names a deployment needs: the target's own plus the application's runtime secrets. */
export function requiredSecretNames(
  target: DeploymentTarget,
  settings: Pick<ReleaseSettings, "targetConfig" | "runtime">
): string[] {
  const names = target.requiredSecrets(settings.targetConfig);

  for (const name of settings.runtime?.secrets ?? []) {
    if (!names.includes(name)) names.push(name);
  }

  return names;
}

/**
 * Context handed to deployment-target adapters (see src/targets/index.js).
 * `ensureArtifactDir` returns a local copy of the build output, downloading
 * it from artifact storage when the local one no longer exists (rollback).
 */
export function createTargetContext({
  project,
  releaseId,
  artifact = null,
  settings,
  secrets,
  store,
  localArtifactDir = null,
  localImageArchive = null,
  scratchDir,
  log,
}: TargetContextOptions): TargetContext {
  let artifactDir = localArtifactDir;
  let imageArchive = localImageArchive;

  return {
    project,
    // A null release ID only occurs for target diagnostics, which never read it.
    releaseId: releaseId as string,
    targetConfig: settings.targetConfig,
    verification: settings.verification,
    secrets,
    artifact,
    runtime: settings.runtime ?? null,
    log,
    async ensureArtifactDir() {
      if (!artifactDir) {
        if (artifact?.type !== "static") {
          throw new Error(`Release ${releaseId} has no static artifact`);
        }

        // Targets only call this with a release, so the scratch directory is always set.
        const dir = path.join(scratchDir as string, `artifact-${releaseId}`);
        artifactDir = dir;
        await fs.rm(dir, { recursive: true, force: true });
        await fs.mkdir(dir, { recursive: true });
        const count = await downloadArtifact(store, artifact.path, dir);

        if (count === 0) {
          throw new Error(`Artifacts for release ${releaseId} are missing from storage`);
        }
      }

      return artifactDir;
    },
    async ensureImageArchive() {
      if (!imageArchive) {
        if (artifact?.type !== "image") {
          throw new Error(`Release ${releaseId} has no image artifact`);
        }

        const file = path.join(scratchDir as string, `image-${releaseId}.tar`);
        await downloadObject(store, artifact.key, file);
        imageArchive = file;
      }

      return imageArchive;
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
export async function runPipeline({
  releaseId,
  secretStore,
}: {
  releaseId: string;
  secretStore: SecretStore;
}) {
  let currentStage = "RELEASE";
  let sandbox: Awaited<ReturnType<typeof createSandbox>> | null = null;
  let secretValues: string[] = [];
  let cancelWatch: ReturnType<typeof setInterval> | null = null;
  let cancelled = false;
  const releaseRoot = path.join(config.workspaceRoot, releaseId);

  // A failure to write a log line must never hide the real error.
  const log = async (stage: string, message: string, level = "INFO") => {
    const text = redactAll(message, secretValues);

    console.log(`[${releaseId}] [${stage}] [${level}] ${text}`);

    try {
      await logRelease({ releaseId, stage, level, message: text });
    } catch (error) {
      console.error(`Failed to persist log for ${releaseId}:`, errorMessage(error));
    }
  };

  const stageLog = (stage: string): ReleaseLog => (message, level) => log(stage, message, level);

  const throwIfCancelled = async () => {
    if (cancelled || (await getRelease(releaseId))?.cancel_requested) {
      cancelled = true;
      throw new CancelledError();
    }
  };

  const enterStage = async (stage: string, { cancellable = true } = {}) => {
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

    // The strategy (how to build) and the target (where it runs) are
    // independent; they only have to agree on the artifact type.
    const detection = await detectStrategy({
      workspacePath: prepared.workspacePath,
      build: settings.build,
      runtime: settings.runtime,
      targetName: target.name,
    });
    const strategy = getStrategy(detection.strategy);

    if (!target.capabilities.artifactTypes.includes(strategy.artifactType)) {
      throw new Error(
        `Target "${target.name}" cannot run ${strategy.artifactType} artifacts ` +
          `(it supports: ${target.capabilities.artifactTypes.join(", ")}); ` +
          `build strategy "${strategy.id}" produces ${strategy.artifactType}`
      );
    }

    await updateRelease(releaseId, { buildStrategy: strategy.id });
    await log("PREPARE", `Build strategy "${strategy.id}" (${strategy.artifactType}): ${detection.reason}`);

    const strategyInput: StrategyInput = {
      releaseId,
      workspacePath: prepared.workspacePath,
      build: settings.build,
      runtime: settings.runtime,
      scratchDir: releaseRoot,
      store,
      log: stageLog("BUILD"),
    };

    // -----------------------
    // BUILD
    // -----------------------

    await enterStage("BUILD");

    if (strategy.usesSandbox) {
      sandbox = await createSandbox({
        releaseId,
        workspacePath: prepared.workspacePath,
        buildEnv: settings.build.env,
      });
    }

    const built = await strategy.build(strategyInput, sandbox);

    await log("BUILD", "Build completed successfully");

    // -----------------------
    // TEST
    // -----------------------

    await enterStage("TEST");

    const tested = await strategy.test({ ...strategyInput, log: stageLog("TEST") }, sandbox, built);

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
    // target. The live release is untouched.
    // -----------------------

    await enterStage("DEPLOY");

    const local = await strategy.produce({ ...strategyInput, log: stageLog("DEPLOY") }, sandbox, built);

    // Untrusted code is finished: the sandbox is gone before any
    // deployment secret is decrypted.
    if (sandbox) {
      await sandbox.destroy();
      sandbox = null;
    }

    const stored = await storeArtifact({ store, releaseId, local, port: settings.runtime?.port, log: stageLog("DEPLOY") });

    await updateRelease(releaseId, {
      artifactPath: stored.path,
      artifact: stored.artifact,
      deploymentUrl: stored.artifact.type === "static" ? `/preview/${releaseId}/` : null,
    });

    const secretNames = requiredSecretNames(target, settings);
    const secrets = secretNames.length
      ? await secretStore.resolve(project, secretNames)
      : {};
    secretValues = Object.values(secrets);

    const ctx = createTargetContext({
      project,
      releaseId,
      artifact: stored.artifact,
      settings,
      secrets,
      store,
      localArtifactDir: local.type === "static" ? local.directory : null,
      localImageArchive: local.type === "image" ? local.archivePath : null,
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
        `Live check failed after activation (${errorMessage(error)}); ${reverted}`,
        { cause: error }
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
      await log("ACTIVATE", `Retention cleanup failed: ${errorMessage(error)}`, "WARN");
    }

    return {
      success: true,
      releaseId,
      previousReleaseId: activation.previousReleaseId,
    };
  } catch (error) {
    const isCancel = error instanceof CancelledError || cancelled;
    const failureMessage = isCancel ? "Cancelled by user" : redactAll(errorMessage(error), secretValues);
    const commandOutput = commandOutputOf(error);

    if (commandOutput && !isCancel) {
      await log(
        currentStage,
        `Command output (last ${OUTPUT_TAIL_ON_FAILURE} chars):\n${commandOutput.slice(
          -OUTPUT_TAIL_ON_FAILURE
        )}`,
        "ERROR"
      );
    }

    await log(currentStage, failureMessage, isCancel ? "WARN" : "ERROR");

    try {
      await updateRelease(releaseId, {
        status: isCancel ? "CANCELLED" : "FAILED",
        currentStage,
        errorMessage: failureMessage,
      });
    } catch (updateError) {
      console.error("Failed to mark release as failed:", errorMessage(updateError));
    }

    await safeNotify(
      releaseId,
      isCancel ? "RELEASE_CANCELLED" : release.mode === "check" ? "CHECK_FAILED" : "RELEASE_FAILED",
      `Release ${releaseId} ${isCancel ? "was cancelled" : "failed"} during ${currentStage}: ${failureMessage}`
    );

    if (isCancel) {
      return { cancelled: true, releaseId };
    }

    throw new Error(failureMessage, { cause: error });
  } finally {
    if (cancelWatch) clearInterval(cancelWatch);

    if (sandbox) {
      await sandbox.destroy().catch((error) =>
        console.error("Failed to remove sandbox:", errorMessage(error))
      );
    }

    secretValues = [];

    await fs
      .rm(releaseRoot, { recursive: true, force: true })
      .catch((error) =>
        console.error("Failed to clean workspace:", errorMessage(error))
      );
  }
}

/** Captured output of a failed command (CommandError.result), if any. */
function commandOutputOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("result" in error)) {
    return undefined;
  }

  const { result } = error;

  if (typeof result !== "object" || result === null || !("output" in result)) {
    return undefined;
  }

  return typeof result.output === "string" && result.output ? result.output : undefined;
}

async function safeNotify(releaseId: string, type: string, message: string) {
  try {
    await notifyRelease({ releaseId, type, message });
  } catch (error) {
    console.error(`Failed to create ${type} notification:`, errorMessage(error));
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
}: RevertToPreviousOptions): Promise<string> {
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
      return `no earlier release existed and taking ${releaseId} offline ALSO FAILED: ${errorMessage(error)}`;
    }
  }

  try {
    const previous = await loadRelease(previousReleaseId);
    const previousArtifact = previous
      ? artifactOf(previous)
      : { type: "static" as const, path: artifactPrefix(previousReleaseId), fileCount: 0 };

    if (previousArtifact && !target.capabilities.artifactTypes.includes(previousArtifact.type)) {
      return (
        `could not restore ${previousReleaseId}: it is a ${previousArtifact.type} release ` +
        `and target "${target.name}" runs ${target.capabilities.artifactTypes.join("/")} artifacts`
      );
    }

    const previousCtx = createTargetContext({
      project,
      releaseId: previousReleaseId,
      artifact: previousArtifact,
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
    return `ALSO FAILED to restore ${previousReleaseId}: ${errorMessage(error)}`;
  }
}

interface StoredArtifact {
  artifact: Artifact;
  /** Artifact-store prefix recorded in releases.artifact_path. */
  path: string;
}

/** Upload a produced artifact to its immutable, release-specific location. */
async function storeArtifact({
  store,
  releaseId,
  local,
  port,
  log,
}: {
  store: ArtifactStore;
  releaseId: string;
  local: LocalArtifact;
  port: number | undefined;
  log: ReleaseLog;
}): Promise<StoredArtifact> {
  if (local.type === "static") {
    await log(
      `Validated ${local.outputDirectory}/: ${local.files.length} files, ${local.totalBytes} bytes` +
        (local.skippedSymlinks ? `, ${local.skippedSymlinks} symlinks skipped` : "")
    );

    const uploaded = await uploadArtifact({
      store,
      releaseId,
      artifactDirectory: local.directory,
      files: local.files,
    });

    await log(`Stored ${uploaded.fileCount} files in ${store.describe()}/${uploaded.artifactPath}`);

    return {
      path: uploaded.artifactPath,
      artifact: { type: "static", path: uploaded.artifactPath, fileCount: uploaded.fileCount },
    };
  }

  if (port === undefined) {
    throw new Error("runtime.port is required to deploy a container image");
  }

  const key = imageKey(releaseId);

  await store.put(key, local.archivePath, contentTypeFor(local.archivePath));

  const uploaded = (await store.list(`${imagePrefix(releaseId)}/`)).find((object) => object.key === key);

  if (uploaded?.size !== local.sizeBytes) {
    throw new Error("Uploaded image archive is incomplete");
  }

  await log(`Stored image ${local.digest} (${local.sizeBytes} bytes) in ${store.describe()}/${key}`);

  return {
    path: imagePrefix(releaseId),
    artifact: { type: "image", key, digest: local.digest, sizeBytes: local.sizeBytes, port },
  };
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
