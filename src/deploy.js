import fs from "fs/promises";
import path from "path";

import { uploadFile } from "./aws.js";



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

  // Vite / many frontend projects
  if (
    packageJson.scripts?.build?.includes("vite") &&
    await directoryExists(path.join(workspacePath, "dist"))
  ) {
    return path.join(workspacePath, "dist");
  }

  // Common fallback
  if (
    await directoryExists(path.join(workspacePath, "dist"))
  ) {
    return path.join(workspacePath, "dist");
  }

  throw new Error(
    "Build output directory 'dist' not found"
  );
}

async function getAllFiles(folderPath) {
  const files = [];

  const entries = await fs.readdir(folderPath, {
    withFileTypes: true,
  });

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

export async function deployRelease({
  releaseId,
  workspacePath,
}) {
    const deploymentUrl =
  `http://api:8000/deployments/`;

  console.log(`Deploying release ${releaseId}`);
  console.log(`Workspace: ${workspacePath}`);

  const buildDirectory =
    await getBuildDirectory(workspacePath);

  console.log(
    `Build directory: ${buildDirectory}`
  );

  const files = await getAllFiles(
    buildDirectory
  );

  console.log(
    `Found ${files.length} build files`
  );

  for (const file of files) {
    const relativePath = path.relative(
      buildDirectory,
      file
    );

    const key = `releases/${releaseId}/build/${relativePath}`;

    await uploadFile(
      key,
      file
    );
  }

  console.log(
    `Deployment artifacts uploaded for ${releaseId}`
  );

  return {
    releaseId,
    buildDirectory,
    fileCount: files.length,
    deploymentPath: `releases/${releaseId}/build`,
    //for testing use local url
    deploymentUrl,
  };
}