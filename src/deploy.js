import fs from "fs/promises";
import path from "path";

import {
  uploadFile,
  listS3Objects,
  copyS3Object,
  deleteS3Prefix,
} from "./aws.js";


async function directoryExists(directoryPath) {
  try {
    const stat = await fs.stat(directoryPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function getBuildDirectory(workspacePath) {
  const packageJsonPath = path.join(
    workspacePath,
    "package.json"
  );

  const packageJson = JSON.parse(
    await fs.readFile(packageJsonPath, "utf-8")
  );

  const distPath = path.join(
    workspacePath,
    "dist"
  );

  if (
    packageJson.scripts?.build?.includes("vite") &&
    await directoryExists(distPath)
  ) {
    return distPath;
  }

  if (await directoryExists(distPath)) {
    return distPath;
  }

  throw new Error(
    "Build output directory 'dist' not found"
  );
}

async function getAllFiles(folderPath) {
  const files = [];

  const entries = await fs.readdir(
    folderPath,
    {
      withFileTypes: true,
    }
  );

  for (const entry of entries) {
    const fullPath = path.join(
      folderPath,
      entry.name
    );

    if (entry.isDirectory()) {
      files.push(
        ...(await getAllFiles(fullPath))
      );
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

async function activateRelease(releaseId) {
  const sourcePrefix =
    `releases/${releaseId}/build/`;

  console.log(
    `Activating release ${releaseId}`
  );

  // Remove currently active deployment
  await deleteS3Prefix("active/");

  const objects =
    await listS3Objects(sourcePrefix);

  if (objects.length === 0) {
    throw new Error(
      `No build artifacts found at ${sourcePrefix}`
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

  console.log(
    `Release ${releaseId} is now active`
  );
}

export async function deployRelease({
  releaseId,
  workspacePath,
}) {
  console.log(
    `Deploying release ${releaseId}`
  );

  console.log(
    `Workspace: ${workspacePath}`
  );

  const buildDirectory =
    await getBuildDirectory(
      workspacePath
    );

  console.log(
    `Build directory: ${buildDirectory}`
  );

  const files = await getAllFiles(
    buildDirectory
  );

  console.log(
    `Found ${files.length} build files`
  );

  // Store immutable release artifact
for (const file of files) {
  const relativePath = path.relative(
    buildDirectory,
    file
  );

  const key =
    `releases/${releaseId}/build/${relativePath}`;

  await uploadFile(
    key,
    file
  );
}

  console.log(
    `Release artifact stored for ${releaseId}`
  );

  // Make this release active
  await activateRelease(releaseId);

  const deploymentUrl =
    process.env.INTERNAL_DEPLOYMENT_URL ||
    "http://api:8000/active/";

  return {
    releaseId,
    buildDirectory,
    fileCount: files.length,
    deploymentPath:
      `releases/${releaseId}/build`,
    deploymentUrl,
  };
}