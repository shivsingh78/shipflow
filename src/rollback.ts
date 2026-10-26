import fs from "fs/promises";
import os from "os";
import path from "path";

import { getRelease } from "./releaseStore.js";
import { getProject } from "./projectStore.js";
import { getArtifactStore } from "./artifactStore.js";
import { getActiveReleaseId, activateRelease } from "./activation.js";
import { getTarget } from "./targets/index.js";
import { createTargetContext, releaseSettings, revertToPrevious, redactAll, requiredSecretNames } from "./pipeline.js";
import { artifactOf, artifactLocation } from "./artifacts.js";
import { logRelease } from "./logStore.js";
import { notifyRelease } from "./notify.js";
import { isValidReleaseId } from "./validation.js";
import { errorMessage } from "./errors.js";
import type { SecretStore } from "./secrets.js";

export interface RollbackResult {
  project: string;
  targetReleaseId: string;
  previousReleaseId: string | null;
  artifactPath: string;
  fileCount: number;
  target: string;
}

/** HTTP status carried by an error, when it has one. */
function statusCodeOf(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    return typeof error.statusCode === "number" ? error.statusCode : undefined;
  }

  return undefined;
}

export class RollbackError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "RollbackError";
    this.statusCode = statusCode;
  }
}

async function record(
  releaseId: string,
  level: string,
  message: string,
  notificationType: string
): Promise<void> {
  try {
    await logRelease({ releaseId, stage: "ROLLBACK", level, message });
    await notifyRelease({ releaseId, type: notificationType, message });
  } catch (error) {
    console.error("Failed to record rollback outcome:", errorMessage(error));
  }
}

/**
 * Make an earlier successful release of a project live again. Nothing is
 * rebuilt: the release's stored artifact is put back on the project's
 * *current* deployment target, verified, and activated. If the live check
 * fails, the previous release is restored.
 */
export async function rollbackRelease(
  targetReleaseId: string,
  { secretStore }: { secretStore?: SecretStore } = {}
): Promise<RollbackResult> {
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

  const artifact = artifactOf(release);

  if (!artifact) {
    throw new RollbackError(`Release ${targetReleaseId} has no stored artifact`, 409);
  }

  const store = await getArtifactStore();
  const objects = await store.list(`${release.artifact_path}/`);
  const complete =
    artifact.type === "static"
      ? objects.some((object) => object.key === `${artifact.path}/index.html`)
      : objects.some((object) => object.key === artifact.key);

  if (!complete) {
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

  if (!target.capabilities.artifactTypes.includes(artifact.type)) {
    throw new RollbackError(
      `Release ${targetReleaseId} is a ${artifact.type} release, but the project's current target ` +
        `"${target.name}" runs ${target.capabilities.artifactTypes.join("/")} artifacts`,
      409
    );
  }

  let secretValues: string[] = [];
  const fail = async (message: string, statusCode = 502) => {
    const text = redactAll(message, secretValues);
    await record(targetReleaseId, "ERROR", text, "ROLLBACK_FAILED");
    return new RollbackError(text, statusCode);
  };

  const names = requiredSecretNames(target, settings);
  let secrets: Record<string, string>;

  try {
    if (names.length && !secretStore) {
      throw new Error("Secret store is not available");
    }

    secrets = names.length && secretStore ? await secretStore.resolve(project, names) : {};
  } catch (error) {
    throw await fail(errorMessage(error), statusCodeOf(error) ?? 502);
  }

  secretValues = Object.values(secrets);

  const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "shipflow-rollback-"));
  const log = (message: string, level = "INFO") =>
    logRelease({ releaseId: targetReleaseId, stage: "ROLLBACK", level, message: redactAll(message, secretValues) }).catch(() => {});

  try {
    const ctx = createTargetContext({
      project,
      releaseId: targetReleaseId,
      artifact,
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
      throw await fail(`Rollback to ${targetReleaseId} failed before activation: ${errorMessage(error)}`);
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

      throw await fail(`Rollback to ${targetReleaseId} failed its live check (${errorMessage(error)}); ${reverted}`);
    }

    const message = `Rolled back ${project} from ${activation.previousReleaseId ?? "(none)"} to ${targetReleaseId}; live site verified`;
    await record(targetReleaseId, "INFO", message, "ROLLBACK_SUCCESS");

    return {
      project,
      targetReleaseId,
      previousReleaseId: activation.previousReleaseId,
      artifactPath: artifactLocation(artifact),
      fileCount: objects.length,
      target: target.name,
    };
  } finally {
    secretValues = [];
    await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
  }
}
