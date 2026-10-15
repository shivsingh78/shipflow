import fs from "fs/promises";
import os from "os";
import path from "path";

import { config } from "./config.js";
import { getAllFiles, toObjectKey } from "./file.js";
import { contentTypeFor } from "./artifactStore.js";
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

const PULL_REF = /^refs\/pull\/\d{1,9}\/head$/;
const COMMIT = /^[0-9a-f]{40}$/;
const BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;

/**
 * Classify a ref: a branch name, a GitHub pull-request head
 * (refs/pull/<n>/head), or a full commit SHA. Anything else is rejected.
 */
export function classifyRef(ref) {
  if (!ref) return { kind: "default" };
  if (PULL_REF.test(ref) || COMMIT.test(ref)) return { kind: "fetch", ref };
  if (BRANCH.test(ref) && !ref.startsWith("refs/")) return { kind: "branch", ref };
  throw new Error(`Invalid git ref ${JSON.stringify(ref)}`);
}

export async function prepareRelease({
  releaseId,
  repoUrl,
  ref = null,
  store,
  snapshot = true,
  workspaceRoot = config.workspaceRoot,
  log = async () => {},
}) {
  const refInfo = classifyRef(ref);
  const releaseRoot = path.join(workspaceRoot, releaseId);
  const workspacePath = path.join(releaseRoot, "source");

  // A retried job must start from a clean directory.
  await fs.rm(releaseRoot, { recursive: true, force: true });
  await fs.mkdir(releaseRoot, { recursive: true });

  await log(`Cloning ${repoUrl}${ref ? ` (${ref})` : ""}`);

  const git = (label, args) =>
    runCommandOrThrow(label, "git", ["-c", "protocol.file.allow=never", ...args], {
      env: gitEnvironment(),
      timeoutMs: config.cloneTimeoutMs,
    });

  await git("git clone", [
    "clone",
    "--depth", "1",
    "--single-branch",
    "--no-tags",
    ...(refInfo.kind === "branch" ? ["--branch", refInfo.ref] : []),
    "--",
    repoUrl,
    workspacePath,
  ]);

  if (refInfo.kind === "fetch") {
    // Pull-request heads and exact commits are fetched after the clone.
    await git("git fetch", ["-C", workspacePath, "fetch", "--depth", "1", "--no-tags", "origin", refInfo.ref]);
    await git("git checkout", ["-C", workspacePath, "checkout", "--quiet", "--detach", "FETCH_HEAD"]);
  }

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

  if (!snapshot) {
    return { releaseId, releaseRoot, workspacePath, commitSha, fileCount: 0 };
  }

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
    await store.put(
      toObjectKey(`releases/${releaseId}/source`, workspacePath, file),
      file,
      contentTypeFor(file)
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
