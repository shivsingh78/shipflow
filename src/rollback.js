import { getRelease } from "./releaseStore.js";
import { listS3Objects } from "./aws.js";
import {
  getActiveReleaseId,
  activateRelease,
  revertActivation,
} from "./activation.js";
import { verifyActive } from "./verify.js";
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
 * Make an earlier successful release live again. The target's immutable
 * artifact is never modified; only the active pointer moves, and it moves
 * back if the live check fails.
 */
export async function rollbackRelease(targetReleaseId) {
  if (!isValidReleaseId(targetReleaseId)) {
    throw new RollbackError("Invalid release ID", 400);
  }

  const release = await getRelease(targetReleaseId);

  if (!release) {
    throw new RollbackError(
      `Release ${targetReleaseId} not found`,
      404
    );
  }

  if (release.status !== "SUCCESS" || !release.artifact_path) {
    throw new RollbackError(
      `Release ${targetReleaseId} cannot be a rollback target: status is ${release.status}; only successful releases can be restored`,
      409
    );
  }

  const activeReleaseId = await getActiveReleaseId();

  if (activeReleaseId === targetReleaseId) {
    throw new RollbackError(
      `Release ${targetReleaseId} is already active`,
      409
    );
  }

  const objects = await listS3Objects(`${release.artifact_path}/`);

  if (
    !objects.some(
      (object) => object.Key === `${release.artifact_path}/index.html`
    )
  ) {
    throw new RollbackError(
      `Artifacts for release ${targetReleaseId} are missing from storage`,
      409
    );
  }

  const activation = await activateRelease({
    releaseId: targetReleaseId,
    action: "ROLLBACK",
  });

  try {
    await verifyActive({ releaseId: targetReleaseId });
  } catch (error) {
    const reverted = await revertActivation(activation);
    const message =
      `Rollback to ${targetReleaseId} failed its live check (${error.message}); ` +
      (reverted
        ? `restored ${activation.previousReleaseId ?? "previous state"}`
        : "a newer activation has since replaced it");

    await record(targetReleaseId, "ERROR", message, "ROLLBACK_FAILED");

    throw new RollbackError(message, 502);
  }

  const message = `Rolled back from ${
    activation.previousReleaseId ?? "(none)"
  } to ${targetReleaseId}; live site verified`;

  await record(targetReleaseId, "INFO", message, "ROLLBACK_SUCCESS");

  return {
    targetReleaseId,
    previousReleaseId: activation.previousReleaseId,
    artifactPath: release.artifact_path,
    fileCount: objects.length,
  };
}
