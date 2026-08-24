import fs from "fs/promises";
import path from "path";
import simpleGit from "simple-git";

import { getAllFiles } from "./file.js";
import { uploadFile } from "./aws.js";

const git = simpleGit();

export async function prepareRelease({
  releaseId,
  repoUrl,
  workspaceRoot = path.join(process.cwd(), "output"),
}) {
  const workspacePath = path.join(
    workspaceRoot,
    releaseId
  );

  console.log(`Preparing release ${releaseId}`);
  console.log(`Workspace: ${workspacePath}`);

  await fs.mkdir(workspaceRoot, {
    recursive: true,
  });

  // Clone repository
  console.log("Cloning repository...");

  await git.clone(
    repoUrl,
    workspacePath
  );

  console.log("Repository cloned");

  // Scan files
  console.log("Scanning files...");

  const files = await getAllFiles(workspacePath);

  console.log(`Found ${files.length} files`);

  // Upload source artifacts
  console.log("Uploading artifacts...");

  for (const file of files) {
    const relativePath = path.relative(
      workspacePath,
      file
    );

    const key = `${releaseId}/${relativePath}`;

    await uploadFile(
      key,
      file
    );
  }

  console.log("Artifacts uploaded");

  // IMPORTANT:
  // Do NOT delete workspace here.
  // Build will reuse it.

  return {
    releaseId,
    workspacePath,
    fileCount: files.length,
  };
}