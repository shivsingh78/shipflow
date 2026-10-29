/**
 * Analyze stage: select context within a token budget, ask the customer's AI
 * provider for structured findings, validate them strictly, ground them in
 * the files that were actually sent, and store them as suggestions.
 */

import { AnalysisOutputSchema, parseModelOutput } from "./schemas.js";
import { ANALYSIS_TOOL, buildAnalysisPrompt, groundFindings, looksLikeSecretMaterial, prioritizeAndDedupe } from "./analysis.js";
import type { Dropped } from "./analysis.js";
import { ProviderError, createProviderForRun, providerFailureToStageError, toolSchemaFor } from "./ai.js";
import type { ProviderFactoryDeps } from "./ai.js";
import { StageError } from "./errors.js";
import { saveEvidence } from "./evidence.js";
import { estimateTokens, selectContext } from "./manifest.js";
import type { StageHandler } from "./orchestrator.js";
import { loadManifest } from "./stagesIngest.js";
import type { IngestDeps } from "./stagesIngest.js";

export interface AnalyzeDeps extends IngestDeps {
  ai: Omit<ProviderFactoryDeps, "store">;
}

export const ANALYSIS_MAX_OUTPUT_TOKENS = 4096;
const FETCH_CONCURRENCY = 4;

async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T);
    }
  }));

  return results;
}

export function createAnalyzeHandler(deps: AnalyzeDeps): StageHandler {
  const limits = deps.config.limits;

  return async ({ run, signal, log }) => {
    if (!deps.github) {
      throw new StageError("github_not_configured", "REPOPILOT_GITHUB_TOKEN is not set on the worker, so repositories cannot be read.", false);
    }

    const github = deps.github;
    const manifest = await loadManifest(deps, run);
    const selection = selectContext(manifest, { budgetTokens: limits.maxContextTokens });

    if (selection.files.length === 0) {
      throw new StageError("no_context", "No source files fit the analysis budget.", false);
    }

    // Fetch exactly the selected blobs at the pinned commit; keep them in memory only.
    const fetched = await mapLimited([...selection.files, ...selection.testSamples], FETCH_CONCURRENCY, async (file) => {
      const bytes = await github.getBlob(run.repoOwner, run.repoName, file.blobSha, signal);

      return { path: file.path, content: bytes.toString("utf-8"), isTest: file.kind === "test" };
    });

    const usable = fetched.filter((file) => !file.content.includes("\0") && !looksLikeSecretMaterial(file.content));
    const skipped = fetched.length - usable.length;
    const sources = usable.filter((file) => !file.isTest);

    if (sources.length === 0) {
      throw new StageError("no_context", "No readable source files were available for analysis.", false);
    }

    const prompt = buildAnalysisPrompt({ manifest, files: sources, testSamples: usable.filter((file) => file.isTest) });
    const promptTokens = estimateTokens(Buffer.byteLength(prompt.user, "utf-8"));

    await log("INFO", `Analysing ${sources.length} files (~${promptTokens} tokens)${skipped > 0 ? `; ${skipped} withheld from the model (binary or key material)` : ""}.`);

    const provider = await createProviderForRun({ ...deps.ai, store: deps.store }, run);
    const reserved = await deps.store.reserveAiRequest(run.id, { maxRequests: limits.maxAiRequestsPerRun, maxInputTokens: limits.maxAiInputTokensPerRun, maxOutputTokens: limits.maxAiOutputTokensPerRun });

    if (!reserved) {
      throw new StageError("ai_budget_exceeded", "This run has reached its AI usage limits. No further provider requests will be made for it.", false);
    }

    let response;

    try {
      response = await provider.complete({
        system: prompt.system,
        user: prompt.user,
        tool: { ...ANALYSIS_TOOL, inputSchema: toolSchemaFor(AnalysisOutputSchema) },
        maxOutputTokens: ANALYSIS_MAX_OUTPUT_TOKENS,
        signal,
      });
    } catch (error) {
      throw error instanceof ProviderError ? providerFailureToStageError(error) : error;
    }

    await deps.store.recordAiUsage(run.id, response.usage);
    await log("INFO", `AI analysis used ${response.usage.inputTokens} input and ${response.usage.outputTokens} output tokens (${response.model}).`);

    const parsed = parseModelOutput(AnalysisOutputSchema, response.toolInput);

    if (!parsed.ok) {
      // Retryable: the next attempt may produce a valid answer; attempts and
      // the per-run request cap bound the cost.
      throw new StageError(parsed.code === "authoritative_field" ? "ai_forbidden_field" : "ai_malformed_output", `The AI response was rejected (${parsed.code}): ${parsed.message}`, true);
    }

    const grounded = groundFindings(parsed.value.findings, prompt.lineCounts);
    const ranked = prioritizeAndDedupe(grounded.kept);
    const dropped: Dropped[] = [...grounded.dropped, ...ranked.dropped];

    await log("INFO", `${ranked.kept.length} findings kept (suggestions, not confirmed defects); ${dropped.length} dropped as ungrounded or duplicate.`);

    return {
      persist: async (tx) => {
        await tx.insertFindings(ranked.kept);
        await saveEvidence(tx, deps.evidence, {
          kind: "findings",
          data: JSON.stringify({ commitSha: run.commitSha, model: response.model, usage: response.usage, notice: "Findings are AI suggestions, not confirmed defects.", findings: ranked.kept, dropped }, null, 2),
        });
      },
    };
  };
}
