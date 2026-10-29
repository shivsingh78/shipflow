/**
 * Ingest and manifest stages.
 *
 * Read-only: GitHub's REST API is the only source (no clone, no archive
 * extraction, no repository code executed). The commit SHA is resolved once
 * and then pinned for the whole run. A run is only ever reported as analysed
 * if these stages succeeded.
 */

import crypto from "crypto";

import type { RepoPilotConfig } from "./config.js";
import { StageError } from "./errors.js";
import type { EvidenceStore } from "./evidence.js";
import { saveEvidence } from "./evidence.js";
import type { GithubClient } from "./github.js";
import { buildManifest } from "./manifest.js";
import type { Manifest } from "./manifest.js";
import type { StageHandler } from "./orchestrator.js";
import type { RepoPilotStore, RunRow } from "./store.js";

export interface IngestDeps {
  store: RepoPilotStore;
  github: GithubClient | null;
  evidence: EvidenceStore;
  config: RepoPilotConfig;
}

const MAX_PACKAGE_JSON_BYTES = 256 * 1024;
const MAX_TREE_ENTRIES = 250_000;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

function requireGithub(deps: IngestDeps): GithubClient {
  if (!deps.github) {
    throw new StageError("github_not_configured", "REPOPILOT_GITHUB_TOKEN is not set on the worker, so repositories cannot be read.", false);
  }

  return deps.github;
}

export function createIngestHandler(deps: IngestDeps): StageHandler {
  return async ({ run, signal, log }) => {
    const github = requireGithub(deps);
    const repo = await github.getRepository(run.repoOwner, run.repoName, signal);

    if (repo.private && !deps.config.allowPrivate) {
      throw new StageError(
        "private_repository_not_allowed",
        "This repository is private. Private repositories are disabled because their code is sent to your AI provider; set REPOPILOT_ALLOW_PRIVATE=true to allow them.",
        false
      );
    }

    // The analysed commit never changes within a run: a retry re-verifies the
    // pinned SHA instead of following a branch that may have moved.
    const ref = run.commitSha ?? run.requestedRef ?? repo.default_branch;
    const sha = await github.resolveCommit(run.repoOwner, run.repoName, ref, signal);

    if (run.commitSha !== null && sha !== run.commitSha) {
      throw new StageError("revision_changed", "The pinned commit no longer resolves to the same revision.", false);
    }

    await log("INFO", `Resolved ${ref === sha ? "commit" : `"${ref}"`} to ${sha.slice(0, 12)} on ${run.repoOwner}/${run.repoName} (default branch ${repo.default_branch}).`);

    return { persist: (tx) => tx.setRunFacts({ commitSha: sha, defaultBranch: repo.default_branch }) };
  };
}

export function createManifestHandler(deps: IngestDeps): StageHandler {
  return async ({ run, signal, log }) => {
    const github = requireGithub(deps);

    if (run.commitSha === null || run.defaultBranch === null) {
      throw new StageError("revision_missing", "The ingest stage did not record a commit.", false);
    }

    const { entries, truncated } = await github.getTree(run.repoOwner, run.repoName, run.commitSha, signal);

    if (truncated || entries.length > MAX_TREE_ENTRIES) {
      throw new StageError("repository_too_large", "The repository has too many files to list safely.", false);
    }

    const rootPackage = entries.find((entry) => entry.path === "package.json" && entry.type === "blob" && entry.mode === "100644");
    let packageJson: string | null = null;

    if (rootPackage && (rootPackage.size ?? 0) <= MAX_PACKAGE_JSON_BYTES) {
      packageJson = (await github.getBlob(run.repoOwner, run.repoName, rootPackage.sha, signal)).toString("utf-8");
    }

    const manifest = buildManifest({
      repo: { owner: run.repoOwner, name: run.repoName },
      commitSha: run.commitSha,
      defaultBranch: run.defaultBranch,
      entries,
      packageJson,
      limits: { maxFiles: deps.config.limits.maxManifestFiles, maxFileBytes: deps.config.limits.maxSnapshotFileBytes, maxTotalBytes: deps.config.limits.maxSnapshotTotalBytes },
    });

    if (!manifest.files.some((file) => file.kind === "source")) {
      throw new StageError("no_supported_files", "No JavaScript or TypeScript source files were found within the size limits, so there is nothing to analyse.", false);
    }

    await log("INFO", `Manifest: ${manifest.totals.files} files kept, ${manifest.skipped.total} skipped; ${manifest.verifiable.ok ? "tests can be verified" : `verification unavailable (${manifest.verifiable.reason})`}.`);

    return { persist: async (tx) => void (await saveEvidence(tx, deps.evidence, { kind: "manifest", data: JSON.stringify(manifest, null, 2) })) };
  };
}

/**
 * Read the run's manifest back from evidence storage, verifying it against
 * the digest recorded in PostgreSQL so a tampered object is detected.
 */
export async function loadManifest(deps: Pick<IngestDeps, "store" | "evidence">, run: RunRow): Promise<Manifest> {
  const row = (await deps.store.listArtifacts(run.owner, run.id)).find((artifact) => artifact.kind === "manifest");

  if (!row) {
    throw new StageError("manifest_missing", "The run has no manifest.", false);
  }

  const bytes = await deps.evidence.get(row.objectKey, MAX_MANIFEST_BYTES);

  if (!bytes) {
    throw new StageError("manifest_missing", "The run's manifest is no longer in storage.", false);
  }

  if (crypto.createHash("sha256").update(bytes).digest("hex") !== row.sha256) {
    throw new StageError("evidence_tampered", "The stored manifest does not match its recorded digest.", false);
  }

  const manifest = JSON.parse(bytes.toString("utf-8")) as Manifest;

  if (manifest.version !== 1 || manifest.commitSha !== run.commitSha) {
    throw new StageError("manifest_mismatch", "The stored manifest does not belong to this run's commit.", false);
  }

  return manifest;
}
