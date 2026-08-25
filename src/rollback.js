import {
  getPreviousSuccessfulRelease,
} from "./releaseStore.js";

import {
  listS3Objects,
  copyS3Object,
  deleteS3Prefix,
} from "./aws.js";

export async function rollbackRelease(
  currentReleaseId
) {
  const stableRelease =
    await getPreviousSuccessfulRelease(
      currentReleaseId
    );

  if (!stableRelease) {
    throw new Error(
      "No previous stable release is available"
    );
  }

  if (!stableRelease.artifact_path) {
    throw new Error(
      `Stable release ${stableRelease.release_id} has no artifact path`
    );
  }

  console.log(
    `Rolling back ${currentReleaseId} to ${stableRelease.release_id}`
  );

  console.log(
    `Using artifact: ${stableRelease.artifact_path}`
  );

  await deleteS3Prefix("active/");

  const sourcePrefix =
    `${stableRelease.artifact_path}/`;

  const objects =
    await listS3Objects(
      sourcePrefix
    );

  if (objects.length === 0) {
    throw new Error(
      `No artifacts found at ${sourcePrefix}`
    );
  }

  for (const object of objects) {
    if (!object.Key) {
      continue;
    }

    const relativePath =
      object.Key.substring(
        sourcePrefix.length
      );

    const destinationKey =
      `active/${relativePath}`;

    await copyS3Object(
      object.Key,
      destinationKey
    );
  }

  return {
    currentReleaseId,
    targetReleaseId:
      stableRelease.release_id,
    artifactPath:
      stableRelease.artifact_path,
    activePath: "active/",
    fileCount: objects.length,
    deploymentUrl:
      process.env.INTERNAL_DEPLOYMENT_URL ||
      "http://api:8000/active/",
  };
}