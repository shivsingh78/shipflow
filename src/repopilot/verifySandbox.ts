/**
 * The boundary between RepoPilot and whatever executes repository tests.
 *
 * NOTHING in the ShipFlow API, worker or this module runs repository code.
 * Execution belongs to a SandboxRunner that lives on a dedicated, isolated
 * host or VM (see docs/repopilot.md "Sandbox requirements"). This repository
 * ships only the interface, strict result validation, and a runner that is
 * permanently "off": with it, verification reports "unavailable" instead of
 * inventing a result.
 *
 * What a conforming runner MUST guarantee (and what no test here can prove):
 *  - a fresh disposable environment per call, destroyed afterwards;
 *  - no network during the test phase; no secrets, no host mounts, no Docker
 *    socket, no cloud metadata access; unprivileged, caps dropped,
 *    no-new-privileges;
 *  - CPU, memory, disk, process, output and wall-clock limits;
 *  - dependency install with lifecycle scripts disabled (--ignore-scripts);
 *  - safe archive extraction (no symlink/traversal escapes) if it downloads
 *    the snapshot itself, and public repositories only (it holds no token).
 */

import { SandboxRunSchema } from "./schemas.js";
import type { SandboxRun } from "./schemas.js";

export type SandboxStatus = "off" | "ready" | "unavailable";

export type Arm = "baseline" | "control" | "patched";

/** What the runner is asked to run. Built by us; never by the model. */
export interface SandboxInput {
  repo: { owner: string; name: string };
  commitSha: string;
  arm: Arm;
  attempt: number;
  /** baseline: no changes; control: only the new test file; patched: source change and test. */
  apply: "none" | "tests_only" | "full";
  patch: { diff: string; testDiff: string } | null;
  /** Always the project's own `npm test`; never text supplied by a model. */
  testCommand: "npm test";
  timeoutMs: number;
  limits: { memoryMb: number; cpus: number; pids: number; outputBytes: number };
}

export interface SandboxResult {
  /** Parsed against SandboxRunSchema: the only shape the classifier accepts. */
  run: SandboxRun;
  /** Combined test output, untrusted. Bounded and redacted before storage. */
  log: string;
}

export interface SandboxRunner {
  readonly status: SandboxStatus;
  /** Human-readable environment profile, recorded with every attempt. */
  readonly profile: Record<string, unknown>;
  /** Whether the runner can apply only the new test to the original code (control arm). */
  readonly supportsControlArm: boolean;
  /** Why the runner is not ready, shown to the user. */
  readonly reason?: string;
  run(input: SandboxInput, signal: AbortSignal): Promise<SandboxResult>;
}

/** Strictly validate whatever a runner returned. */
export function parseSandboxResult(value: unknown, maxLogBytes: number): SandboxResult {
  const candidate = value as { run?: unknown; log?: unknown } | null;
  const run = SandboxRunSchema.parse(candidate?.run);
  const log = typeof candidate?.log === "string" ? candidate.log : "";

  return { run, log: Buffer.byteLength(log, "utf-8") > maxLogBytes ? `${Buffer.from(log, "utf-8").subarray(0, maxLogBytes).toString("utf-8")}\n[log truncated]` : log };
}

/** The shipped runner: refuses to execute anything. */
export function createDisabledSandbox(reason = "Sandbox verification is off (REPOPILOT_SANDBOX=off)."): SandboxRunner {
  return {
    status: "off",
    profile: { runner: "disabled" },
    supportsControlArm: false,
    reason,
    run() {
      return Promise.reject(new Error("The sandbox is disabled; no repository code is ever executed."));
    },
  };
}

/**
 * REPOPILOT_SANDBOX=remote asks for a remote runner. None is implemented in
 * this repository, so the honest answer is "unavailable", not a fake "ready".
 */
export function createSandboxRunner(mode: "off" | "remote"): SandboxRunner {
  if (mode === "remote") {
    return {
      ...createDisabledSandbox(),
      status: "unavailable",
      profile: { runner: "remote", configured: false },
      reason: "REPOPILOT_SANDBOX=remote is set, but no remote runner implementation is installed. Provision and validate an isolated runner first (docs/repopilot.md), then plug it in.",
    };
  }

  return createDisabledSandbox();
}
