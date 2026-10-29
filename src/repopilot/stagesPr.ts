/**
 * Pull-request stage: runs ONCE per authorisation (never auto-retried).
 *
 * Before anything is written to GitHub, every fact the human approved is
 * re-checked against stored data: the patch bytes and digest, the base
 * commit, the verification outcome, and the policy. Then:
 *   - a repopilot/* branch is created from the ANALYSED commit via the Git
 *     Data API (no clone, no push, never the default branch);
 *   - an existing branch or PR for the same authorisation is adopted rather
 *     than duplicated;
 *   - if the base branch moved and touched the patched files, the stage
 *     refuses instead of proposing a stale diff;
 *   - the PR is a draft by default and is never merged by RepoPilot.
 */

import { applyProposal } from "./apply.js";
import { StageError } from "./errors.js";
import type { GithubClient } from "./github.js";
import type { StageHandler } from "./orchestrator.js";
import { patchDigest, validatePatchProposal } from "./patch.js";
import { buildPullRequestBody, commitMessage, pullRequestTitle } from "./prBody.js";
import { loadManifest } from "./stagesIngest.js";
import type { IngestDeps } from "./stagesIngest.js";

const BRANCH = /^repopilot\/run-\d+-patch-\d+-[0-9a-f]{8}$/;

export function createPrHandler(deps: IngestDeps): StageHandler {
  return async ({ run, signal, log }) => {
    const github: GithubClient | null = deps.github;
    const actor = "system";

    if (!github) {
      throw new StageError("github_not_configured", "REPOPILOT_GITHUB_TOKEN is not set on the worker, so no pull request can be opened.", false);
    }

    const pr = await deps.store.getPullRequestForRun(run.id);

    if (!pr) {
      throw new StageError("authorization_missing", "There is no recorded human authorisation for this run.", false);
    }

    const failPr = async (code: string, detail: string): Promise<void> => {
      await deps.store.updatePullRequest({ runId: run.id, from: ["authorized", "creating"], to: "failed", actor, errorCode: code, errorDetail: detail }).catch(() => undefined);
    };

    try {
      // ---- 1. Re-validate the authorisation against stored truth.
      const patch = await deps.store.getPatchById(pr.patchId);

      if (!patch || patch.runId !== run.id || !patch.validationOk) {
        throw new StageError("authorization_mismatch", "The authorised patch is missing or no longer valid.", false);
      }

      const digest = patchDigest(patch.diff, patch.testDiff);

      if (digest !== pr.authorizedDiffSha256 || digest !== patch.diffSha256) {
        throw new StageError("authorization_mismatch", "The patch no longer matches the digest that was authorised.", false);
      }

      if (run.commitSha === null || pr.baseSha !== run.commitSha || patch.baseCommit !== pr.baseSha) {
        throw new StageError("authorization_mismatch", "The base commit no longer matches what was authorised.", false);
      }

      const outcome = (await deps.store.listOutcomes(run.owner, run.id)).find((o) => o.patchId === patch.id);

      if (!outcome || outcome.outcome !== pr.authorizedOutcome || outcome.outcome === "regressed") {
        throw new StageError("authorization_mismatch", "The verification outcome no longer matches what was authorised.", false);
      }

      if (!BRANCH.test(pr.branchName) || pr.branchName.startsWith(`${pr.baseBranch}/`) || pr.branchName === pr.baseBranch || run.defaultBranch !== pr.baseBranch) {
        throw new StageError("authorization_mismatch", "The target branch is not an allowed RepoPilot branch.", false);
      }

      const manifest = await loadManifest(deps, run);
      const existingFiles = new Set(manifest.files.map((file) => file.path));
      const symlinkPaths = new Set(manifest.symlinkPaths);
      const policy = validatePatchProposal({ diff: patch.diff, testDiff: patch.testDiff }, { existingFiles, symlinkPaths });

      if (!policy.ok) {
        throw new StageError("policy_rejected", "The patch no longer passes patch policy.", false);
      }

      // ---- 2. Claim the authorisation. A second job loses here.
      const claimed = await deps.store.updatePullRequest({ runId: run.id, from: ["authorized"], to: "creating", actor });

      if (!claimed) {
        throw new StageError("pr_already_in_progress", "A pull request for this authorisation is already being created or finished.", false);
      }

      const changedPaths = [...policy.source.files, ...policy.test.files].map((file) => file.path);

      // ---- 3. Adopt prior work instead of duplicating it.
      const existing = await github.findPullRequestForBranch(run.repoOwner, run.repoName, pr.branchName, signal);

      if (existing) {
        await log("INFO", `A pull request for ${pr.branchName} already exists (#${existing.number}); recording it instead of creating another.`);

        return { persist: async (tx) => void (await tx.openPullRequest({ prNumber: existing.number, prUrl: existing.html_url, headSha: existing.head.sha })) };
      }

      // ---- 4. Handle a moved base branch.
      const baseHead = await github.getBranchHead(run.repoOwner, run.repoName, pr.baseBranch, signal);

      if (baseHead === null) {
        throw new StageError("base_branch_missing", `The base branch ${pr.baseBranch} no longer exists.`, false);
      }

      let baseMoved: { aheadBy: number } | null = null;

      if (baseHead !== pr.baseSha) {
        const comparison = await github.compare(run.repoOwner, run.repoName, pr.baseSha, baseHead, signal);
        const touched = changedPaths.filter((path) => comparison.files.includes(path));

        if (touched.length > 0) {
          throw new StageError("base_moved_conflict", `${pr.baseBranch} changed ${touched.join(", ")} after the analysed commit, so the reviewed diff may be stale. Run a new analysis.`, false);
        }

        baseMoved = { aheadBy: comparison.aheadBy };
      }

      // ---- 5. Branch: adopt our own prior commit, never someone else's.
      let headSha = await github.getBranchHead(run.repoOwner, run.repoName, pr.branchName, signal);

      if (headSha !== null) {
        const mine = await github.compare(run.repoOwner, run.repoName, pr.baseSha, pr.branchName, signal);
        const sameFiles = mine.aheadBy === 1 && mine.files.length === changedPaths.length && changedPaths.every((path) => mine.files.includes(path));

        if (!sameFiles) {
          throw new StageError("branch_conflict", `The branch ${pr.branchName} already exists with different content.`, false);
        }
      } else {
        const originals = new Map<string, string>();

        for (const file of policy.source.files.filter((candidate) => candidate.kind === "modify")) {
          const entry = manifest.files.find((candidate) => candidate.path === file.path);

          if (entry) originals.set(file.path, (await github.getBlob(run.repoOwner, run.repoName, entry.blobSha, signal)).toString("utf-8"));
        }

        const applied = applyProposal(originals, { diff: patch.diff, testDiff: patch.testDiff }, { existingFiles, symlinkPaths });

        if (!applied.ok) {
          throw new StageError("patch_does_not_apply", "The patch no longer applies to the analysed commit.", false);
        }

        const entries: Array<{ path: string; sha: string }> = [];

        for (const [path, content] of [...applied.changed].sort(([a], [b]) => (a < b ? -1 : 1))) {
          entries.push({ path, sha: await github.createBlob(run.repoOwner, run.repoName, content, signal) });
        }

        const baseTree = await github.getCommitTree(run.repoOwner, run.repoName, pr.baseSha, signal);
        const tree = await github.createTree(run.repoOwner, run.repoName, baseTree, entries, signal);
        const finding = await deps.store.getFinding(run.owner, run.id, patch.findingId);

        headSha = await github.createCommit(run.repoOwner, run.repoName, { message: commitMessage(finding ?? { title: patch.title }, patch), tree, parent: pr.baseSha }, signal);
        await github.createBranch(run.repoOwner, run.repoName, pr.branchName, headSha, signal);
        await log("INFO", `Created branch ${pr.branchName} from the analysed commit ${pr.baseSha.slice(0, 12)}.`);
      }

      // ---- 6. Open the pull request (draft by default). Never merged here.
      const finding = await deps.store.getFinding(run.owner, run.id, patch.findingId);

      if (!finding) {
        throw new StageError("finding_missing", "The finding for this patch no longer exists.", false);
      }

      const verifications = (await deps.store.listVerifications(run.owner, run.id)).filter((v) => v.patchId === patch.id);
      const body = buildPullRequestBody({
        run, finding, patch,
        changedFiles: { source: policy.source.files.map((f) => f.path), tests: policy.test.files.map((f) => f.path) },
        outcome, verifications, authorizedBy: pr.authorizedBy, authorizedAt: pr.authorizedAt, baseMoved,
      });
      const opened = await github.createPullRequest(run.repoOwner, run.repoName, { title: pullRequestTitle(finding), body, head: pr.branchName, base: pr.baseBranch, draft: deps.config.prDraft }, signal);

      await log("INFO", `Opened ${deps.config.prDraft ? "draft " : ""}pull request #${opened.number}. It has not been merged and will not be.`);

      return { persist: async (tx) => void (await tx.openPullRequest({ prNumber: opened.number, prUrl: opened.html_url, headSha: opened.head.sha })) };
    } catch (error) {
      const stageError = error instanceof StageError ? error : new StageError("internal_error", error instanceof Error ? error.message : "unknown error", false);

      await failPr(stageError.code, stageError.message);

      // The PR stage is never retried automatically, whatever the cause.
      throw new StageError(stageError.code, stageError.message, false);
    }
  };
}
