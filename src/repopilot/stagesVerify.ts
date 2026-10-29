/**
 * Verify stage: baseline / control / patched test runs through a
 * SandboxRunner, recorded one by one, then classified.
 *
 * Properties:
 *  - the test command is fixed ("npm test"); no command text from a model is
 *    ever executed;
 *  - every attempt is recorded with commit, patch digest, command and
 *    environment profile; infrastructure failures are recorded as such and
 *    never counted as passing or failing;
 *  - resumable and idempotent: attempts already recorded are skipped;
 *  - with no ready sandbox the patch gets an explicit "inconclusive" outcome
 *    rather than a fabricated result.
 */

import crypto from "crypto";

import type { RepoPilotConfig } from "./config.js";
import { StageError } from "./errors.js";
import type { EvidenceStore } from "./evidence.js";
import { evidenceKey, saveEvidence } from "./evidence.js";
import type { StageHandler } from "./orchestrator.js";
import { redactSensitive } from "./redact.js";
import { loadManifest } from "./stagesIngest.js";
import type { RepoPilotStore } from "./store.js";
import { parseSandboxResult } from "./verifySandbox.js";
import type { Arm, SandboxInput, SandboxRunner } from "./verifySandbox.js";

export interface VerifyDeps {
  store: RepoPilotStore;
  evidence: EvidenceStore;
  config: RepoPilotConfig;
  sandbox: SandboxRunner;
}

const ARM_APPLY: Record<Arm, SandboxInput["apply"]> = { baseline: "none", control: "tests_only", patched: "full" };

export const SANDBOX_LIMITS = { memoryMb: 1024, cpus: 1, pids: 256, outputBytes: 1024 * 1024 } as const;

export function createVerifyHandler(deps: VerifyDeps): StageHandler {
  return async ({ run, signal, log }) => {
    const patch = await deps.store.latestValidPatch(run.id);

    if (!patch) {
      throw new StageError("patch_missing", "There is no policy-valid patch to verify.", false);
    }

    const manifest = await loadManifest(deps, run);

    // Nothing to run: record WHY, so the outcome is explicit rather than absent.
    if (!manifest.verifiable.ok) {
      await log("WARN", `Verification skipped: ${manifest.verifiable.detail}`);

      return { persist: async (tx) => void (await tx.recordUnverified(patch.id, "unsupported_project")) };
    }

    if (deps.sandbox.status !== "ready") {
      await log("WARN", `Verification unavailable: ${deps.sandbox.reason ?? "no sandbox is configured"}`);

      return { persist: async (tx) => void (await tx.recordUnverified(patch.id, "verification_unavailable")) };
    }

    const arms: Arm[] = deps.sandbox.supportsControlArm ? ["baseline", "control", "patched"] : ["baseline", "patched"];
    const done = new Set((await deps.store.listVerifications(run.owner, run.id)).filter((v) => v.patchId === patch.id).map((v) => `${v.arm}:${v.attempt}`));
    const profile = { ...deps.sandbox.profile, mode: deps.config.sandboxMode, timeoutMs: deps.config.limits.verifyTimeoutMs, limits: SANDBOX_LIMITS, network: "none during tests", installScripts: "disabled" };

    for (const arm of arms) {
      for (let attempt = 1; attempt <= deps.config.limits.verifyAttempts; attempt += 1) {
        signal.throwIfAborted();

        if (done.has(`${arm}:${attempt}`)) {
          continue;
        }

        const input: SandboxInput = {
          repo: { owner: run.repoOwner, name: run.repoName },
          commitSha: patch.baseCommit,
          arm,
          attempt,
          apply: ARM_APPLY[arm],
          patch: arm === "baseline" ? null : { diff: patch.diff, testDiff: patch.testDiff },
          testCommand: "npm test",
          timeoutMs: deps.config.limits.verifyTimeoutMs,
          limits: SANDBOX_LIMITS,
        };

        let record;
        let logText = "";

        try {
          const result = parseSandboxResult(await deps.sandbox.run(input, signal), deps.config.limits.maxVerifyLogBytes);

          record = result.run;
          logText = result.log;
        } catch (error) {
          if (signal.aborted) throw error;

          // A runner failure or an invalid result is an infrastructure error:
          // recorded as such, never as a pass or a fail.
          record = { kind: "infra_error" as const, detail: redactSensitive(error instanceof Error ? error.message : "sandbox error").slice(0, 300) };
        }

        const key = evidenceKey({ runId: run.id, kind: "verification_log", patchId: patch.id, arm, attempt });

        const logBytes = Buffer.from(redactSensitive(logText || "(no output)"), "utf-8");

        await deps.evidence.put(key, logBytes, "text/plain");
        await deps.store.indexArtifact(run.id, { kind: "verification_log", objectKey: key, bytes: logBytes.length, sha256: crypto.createHash("sha256").update(logBytes).digest("hex"), patchId: patch.id });
        await deps.store.recordVerification({ runId: run.id, patchId: patch.id, arm, attempt, run: record, testCommand: "npm test", environmentProfile: profile, logKey: key });
        await log("INFO", `${arm} attempt ${attempt}: ${record.kind}${record.kind === "exited" ? ` (exit ${record.exitCode})` : ""}`);
      }
    }

    return {
      persist: async (tx) => {
        const outcome = await tx.computeOutcome(patch.id);

        await saveEvidence(tx, deps.evidence, { kind: "outcome", patchId: patch.id, data: JSON.stringify({ patchId: patch.id, diffSha256: patch.diffSha256, commitSha: patch.baseCommit, outcome: outcome.outcome, reasons: outcome.reasons, details: outcome.arms, note: "Tests passing is evidence, not proof of correctness." }, null, 2) });
      },
    };
  };
}
