/**
 * Patch stage: ask the customer's AI provider for ONE patch + regression test
 * for ONE finding, then validate and dry-run it. The original bytes and every
 * verdict are stored for review; a rejected proposal is never edited or
 * "fixed up", and a passing validation never means "verified".
 */

import { applyProposal } from "./apply.js";
import { validatePatchProposal } from "./patch.js";
import { PatchProposalSchema, parseModelOutput } from "./schemas.js";
import { PATCH_MAX_OUTPUT_TOKENS, PATCH_TOOL, buildPatchPrompt } from "./patchGen.js";
import { ProviderError, createProviderForRun, providerFailureToStageError, toolSchemaFor } from "./ai.js";
import { StageError } from "./errors.js";
import { saveEvidence } from "./evidence.js";
import type { StageHandler } from "./orchestrator.js";
import type { AnalyzeDeps } from "./stagesAnalyze.js";
import { loadManifest } from "./stagesIngest.js";

const MAX_TARGET_FILE_BYTES = 256 * 1024;

export function createPatchHandler(deps: AnalyzeDeps): StageHandler {
  const limits = deps.config.limits;

  return async ({ run, params, signal, log }) => {
    if (!deps.github) {
      throw new StageError("github_not_configured", "REPOPILOT_GITHUB_TOKEN is not set on the worker, so repositories cannot be read.", false);
    }

    const github = deps.github;
    const findingId = params.findingId;

    if (typeof findingId !== "number") {
      throw new StageError("finding_missing", "The patch job did not say which finding to fix.", false);
    }

    const finding = await deps.store.getFinding(run.owner, run.id, findingId);

    if (!finding) {
      throw new StageError("finding_missing", "That finding does not belong to this run.", false);
    }

    const manifest = await loadManifest(deps, run);
    const entry = manifest.files.find((file) => file.path === finding.file);

    if (!entry || entry.kind !== "source") {
      throw new StageError("finding_not_patchable", "The finding's file is not a patchable source file in this snapshot.", false);
    }

    const readText = async (blobSha: string): Promise<string | null> => {
      const bytes = await github.getBlob(run.repoOwner, run.repoName, blobSha, signal);
      const text = bytes.toString("utf-8");

      return text.includes("\0") ? null : text;
    };

    const fileText = await readText(entry.blobSha);

    if (fileText === null) {
      throw new StageError("finding_not_patchable", "The finding's file is not text.", false);
    }

    const tests = manifest.files.filter((file) => file.kind === "test" && file.size < 8 * 1024).sort((a, b) => a.size - b.size || (a.path < b.path ? -1 : 1)).slice(0, 2);
    const testSamples: Array<{ path: string; content: string }> = [];

    for (const file of tests) {
      const text = await readText(file.blobSha);

      if (text !== null) testSamples.push({ path: file.path, content: text });
    }

    const prompt = buildPatchPrompt({ manifest, finding, file: { path: entry.path, content: fileText }, testSamples });

    const provider = await createProviderForRun({ ...deps.ai, store: deps.store }, run);
    const reserved = await deps.store.reserveAiRequest(run.id, { maxRequests: limits.maxAiRequestsPerRun, maxInputTokens: limits.maxAiInputTokensPerRun, maxOutputTokens: limits.maxAiOutputTokensPerRun });

    if (!reserved) {
      throw new StageError("ai_budget_exceeded", "This run has reached its AI usage limits. No further provider requests will be made for it.", false);
    }

    let response;

    try {
      response = await provider.complete({ system: prompt.system, user: prompt.user, tool: { ...PATCH_TOOL, inputSchema: toolSchemaFor(PatchProposalSchema) }, maxOutputTokens: PATCH_MAX_OUTPUT_TOKENS, signal });
    } catch (error) {
      throw error instanceof ProviderError ? providerFailureToStageError(error) : error;
    }

    await deps.store.recordAiUsage(run.id, response.usage);

    const parsed = parseModelOutput(PatchProposalSchema, response.toolInput);

    if (!parsed.ok) {
      throw new StageError(parsed.code === "authoritative_field" ? "ai_forbidden_field" : "ai_malformed_output", `The AI response was rejected (${parsed.code}): ${parsed.message}`, true);
    }

    const proposal = parsed.value;
    const existingFiles = new Set(manifest.files.map((file) => file.path));
    const symlinkPaths = new Set(manifest.symlinkPaths);

    // 1. Policy (cheap, no network).
    const policy = validatePatchProposal(proposal, { existingFiles, symlinkPaths });
    let apply: { ok: boolean; issues: Array<{ code: string; message: string; path?: string | undefined }> };

    if (!policy.ok) {
      apply = { ok: false, issues: [{ code: "not_applied", message: "Not dry-run: the proposal violates patch policy." }] };
    } else {
      // 2. Dry run against the pinned snapshot: fetch only the files the
      // validated diff modifies (hash-verified), apply in memory.
      const targets = new Map<string, string>();

      for (const file of policy.source.files.filter((candidate) => candidate.kind === "modify")) {
        const entry = manifest.files.find((candidate) => candidate.path === file.path);

        if (entry && entry.size <= MAX_TARGET_FILE_BYTES) {
          const text = await readText(entry.blobSha);

          if (text !== null) targets.set(file.path, text);
        }
      }

      const applied = applyProposal(targets, proposal, { existingFiles, symlinkPaths });

      apply = applied.ok ? { ok: true, issues: [] } : { ok: false, issues: applied.issues };
    }

    await log("INFO", `Patch proposed for finding #${finding.id} (${response.usage.inputTokens} in / ${response.usage.outputTokens} out tokens). Policy and dry-run results are recorded; nothing has been verified yet.`);

    return {
      persist: async (tx) => {
        const { patch, validation, usable } = await tx.insertPatch(findingId, proposal, { existingFiles, symlinkPaths, apply });

        await saveEvidence(tx, deps.evidence, { kind: "patch", patchId: patch.id, redact: false, data: JSON.stringify({ baseCommit: patch.baseCommit, findingId, diffSha256: patch.diffSha256, title: patch.title, explanation: patch.explanation, diff: proposal.diff, testDiff: proposal.testDiff }, null, 2) });
        await saveEvidence(tx, deps.evidence, { kind: "patch_validation", patchId: patch.id, data: JSON.stringify({ policy: validation, apply, usable, model: response.model, note: "Passing validation means well-formed and within policy. It does not mean correct or verified." }, null, 2) });

        return usable ? {} : { rejected: true };
      },
    };
  };
}
