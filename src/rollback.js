import fs from "fs/promises";
import os from "os";
import path from "path";

import { getRelease } from "./releaseStore.js";
import { getProject } from "./projectStore.js";
import { getArtifactStore } from "./artifactStore.js";
import { getActiveReleaseId, activateRelease } from "./activation.js";
import { getTarget } from "./targets/index.js";
import { createTargetContext, releaseSettings, revertToPrevious, redactAll } from "./pipeline.js";
import { logRelease } from "./logStore.js";
import { notifyRelease } from "./notify.js";
import { isValidReleaseId } from "./validation.js";

export class RollbackError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "RollbackError";
    this.statusCode = statusCode;
  }
}

async function record(releaseId, level, message, notificationType) {
  try {
    await logRelease({ releaseId, stage: "ROLLBACK", level, message });
    await notifyRelease({ releaseId, type: notificationType, message });
  } catch (error) {
    console.error("Failed to record rollback outcome:", error.message);
  }
}

/**
 * Make an earlier successful release of a project live again. Nothing is
 * rebuilt: the release's stored artifact is put back on the project's
 * *current* deployment target, verified, and activated. If the live check
 * fails, the previous release is restored.
 */
export async function rollbackRelease(targetReleaseId, { secretStore } = {}) {
  if (!isValidReleaseId(targetReleaseId)) {
    throw new RollbackError("Invalid release ID", 400);
  }

  const release = await getRelease(targetReleaseId);

  if (!release) {
    throw new RollbackError(`Release ${targetReleaseId} not found`, 404);
  }

  if (release.mode !== "deploy" || release.status !== "SUCCESS" || !release.artifact_path) {
    throw new RollbackError(
      `Release ${targetReleaseId} cannot be a rollback target: ` +
        (release.mode !== "deploy"
          ? "it was a check-only run"
          : release.status !== "SUCCESS"
            ? `status is ${release.status}; only successful releases can be restored`
            : "its stored artifacts were removed by retention"),
      409
    );
  }

  const project = release.project;

  if ((await getActiveReleaseId(project)) === targetReleaseId) {
    throw new RollbackError(`Release ${targetReleaseId} is already active`, 409);
  }

  const store = await getArtifactStore();
  const objects = await store.list(`${release.artifact_path}/`);

  if (!objects.some((object) => object.key === `${release.artifact_path}/index.html`)) {
    throw new RollbackError(`Artifacts for release ${targetReleaseId} are missing from storage`, 409);
  }

  // The project's current target configuration decides where to deploy
  // (it may have moved since this release was built).
  const projectRow = await getProject(project);
  const settings = releaseSettings(projectRow ? { config: projectRow.config } : release);
  const target = getTarget(settings.target);

  if (!target.capabilities.rollback) {
    throw new RollbackError(`Target "${target.name}" does not support rollback`, 409);
  }

  let secretValues = [];
  const fail = async (message, statusCode = 502) => {
    const text = redactAll(message, secretValues);
    await record(targetReleaseId, "ERROR", text, "ROLLBACK_FAILED");
    return new RollbackError(text, statusCode);
  };

  const names = target.requiredSecrets(settings.targetConfig);
  let secrets = {};

  try {
    secrets = names.length ? await secretStore.resolve(project, names) : {};
  } catch (error) {
    throw await fail(error.message, error.statusCode ?? 502);
  }

  secretValues = Object.values(secrets);

  const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "shipflow-rollback-"));
  const log = (message, level = "INFO") =>
    logRelease({ releaseId: targetReleaseId, stage: "ROLLBACK", level, message: redactAll(message, secretValues) }).catch(() => {});

  try {
    const ctx = createTargetContext({
      project,
      releaseId: targetReleaseId,
      artifactPath: release.artifact_path,
      settings,
      secrets,
      store,
      scratchDir,
      log,
    });

    try {
      const prepared = await target.prepare(ctx);
      await log(`Target "${target.name}": ${prepared.detail}`);
      const verified = await target.verifyCandidate(ctx);
      await log(`Candidate verified: ${verified.detail}`);
    } catch (error) {
      throw await fail(`Rollback to ${targetReleaseId} failed before activation: ${error.message}`);
    }

    const activation = await activateRelease({
      project,
      releaseId: targetReleaseId,
      action: "ROLLBACK",
      apply: () => target.activate(ctx),
    });

    try {
      const live = await target.verifyLive(ctx);
      await log(live.detail);
    } catch (error) {
      const reverted = await revertToPrevious({
        project,
        releaseId: targetReleaseId,
        previousReleaseId: activation.previousReleaseId,
        target,
        settings,
        secrets,
        store,
        scratchDir,
        log,
      });

      throw await fail(`Rollback to ${targetReleaseId} failed its live check (${error.message}); ${reverted}`);
    }

    const message = `Rolled back ${project} from ${activation.previousReleaseId ?? "(none)"} to ${targetReleaseId}; live site verified`;
    await record(targetReleaseId, "INFO", message, "ROLLBACK_SUCCESS");

    return {
      project,
      targetReleaseId,
      previousReleaseId: activation.previousReleaseId,
      artifactPath: release.artifact_path,
      fileCount: objects.length,
      target: target.name,
    };
  } finally {
    secretValues = [];
    await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
  }
}
