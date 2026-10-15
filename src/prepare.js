import fs from "fs/promises";
import os from "os";
import path from "path";

import { config } from "./config.js";
import { getAllFiles, toObjectKey } from "./file.js";
import { uploadFile } from "./aws.js";
import { runCommand, runCommandOrThrow } from "./runCommand.js";

// git needs nothing from the worker environment; in particular it must not
// see AWS, database or API credentials.
function gitEnvironment() {
  return {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: os.tmpdir(),
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

export async function prepareRelease({
  releaseId,
  repoUrl,
  workspaceRoot = config.workspaceRoot,
  log = async () => {},
}) {
  const releaseRoot = path.join(workspaceRoot, releaseId);
  const workspacePath = path.join(releaseRoot, "source");

  // A retried job must start from a clean directory.
  await fs.rm(releaseRoot, { recursive: true, force: true });
  await fs.mkdir(releaseRoot, { recursive: true });

  await log(`Cloning ${repoUrl}`);

  await runCommandOrThrow(
    "git clone",
    "git",
    [
      "-c", "protocol.file.allow=never",
      "clone",
      "--depth", "1",
      "--single-branch",
      "--no-tags",
      "--",
      repoUrl,
      workspacePath,
    ],
    {
      env: gitEnvironment(),
      timeoutMs: config.cloneTimeoutMs,
    }
  );

  const revision = await runCommand(
    "git",
    ["-C", workspacePath, "rev-parse", "HEAD"],
    { env: gitEnvironment(), timeoutMs: 10_000 }
  );

  if (revision.exitCode !== 0) {
    throw new Error("Repository is empty: no commit to deploy");
  }

  const commitSha = revision.output.trim();

  await log(`Cloned commit ${commitSha}`);

  // Store an immutable snapshot of the source next to the build artifact.
  const skipped = [];
  const files = await getAllFiles(workspacePath, {
    ignore: [".git", "node_modules"],
    skipped,
  });

  if (files.length > config.maxArtifactFiles) {
    throw new Error(
      `Repository has ${files.length} files; the limit is ${config.maxArtifactFiles}`
    );
  }

  for (const file of files) {
    await uploadFile(
      toObjectKey(`releases/${releaseId}/source`, workspacePath, file),
      file
    );
  }

  await log(
    `Uploaded source snapshot (${files.length} files` +
      (skipped.length ? `, ${skipped.length} symlinks skipped)` : ")")
  );

  return {
    releaseId,
    releaseRoot,
    workspacePath,
    commitSha,
    fileCount: files.length,
  };
}
