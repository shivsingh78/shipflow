// Deployment targets ("adapters"): where a built release is served from.
//
// Every adapter implements the same interface. The pipeline calls these in
// order and never needs target-specific code:
//
//   name, description
//   capabilities: {
//     candidateVerification: "http" | "checksum" | "none",
//     atomicActivation: boolean,   // switch is a single atomic operation
//     rollback: boolean,           // can re-activate an earlier release
//   }
//   requiredSecrets(targetConfig) -> string[]   names, never values
//   async check(ctx)            -> [{ name, ok, detail }]  (diagnostics)
//   async prepare(ctx)          -> { detail }   put the candidate in place, not live
//   async verifyCandidate(ctx)  -> { detail }   prove the candidate is intact
//   async activate(ctx)         -> void         make ctx.releaseId live (called
//                                               while the project's activation
//                                               lock is held)
//   async deactivate(ctx)       -> void         stop serving ctx.releaseId when
//                                               there is no earlier release to
//                                               switch back to (first deploy)
//   async verifyLive(ctx)       -> { url, detail }
//   liveUrl(ctx)                -> string | null
//
// ctx = { project, releaseId, targetConfig, verification, secrets,
//         ensureArtifactDir(): Promise<string>, log(message, level) }
//
// Adapters must not build shell commands from unvalidated input, and must
// throw Errors whose messages are safe to show to users (no secret values).
import { dockerTarget } from "./docker.js";
import { kubernetesTarget } from "./kubernetes.js";
import { shipflowTarget } from "./shipflow.js";
import { sshTarget } from "./ssh.js";
import type { DeploymentTarget, TargetSummary } from "./types.js";

export type * from "./types.js";

const TARGETS: Record<string, DeploymentTarget> = {
  [shipflowTarget.name]: shipflowTarget,
  [sshTarget.name]: sshTarget,
  [kubernetesTarget.name]: kubernetesTarget,
  [dockerTarget.name]: dockerTarget,
};

export function getTarget(name: string): DeploymentTarget {
  const target = TARGETS[name];

  if (!target) {
    throw new Error(
      `Unsupported deployment target "${name}" (supported: ${Object.keys(TARGETS).join(", ")})`
    );
  }

  return target;
}

export function listTargets(): TargetSummary[] {
  return Object.values(TARGETS).map(({ name, description, capabilities }) => ({
    name,
    description,
    capabilities,
  }));
}
