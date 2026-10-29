/**
 * RepoPilot configuration, read from the environment.
 *
 * Everything unsafe is OFF unless explicitly enabled, and a half-configured
 * capability is reported as unavailable rather than guessed at:
 *   REPOPILOT=enabled            the feature (API routes, worker stages)
 *   REPOPILOT_SANDBOX=off|remote repository code execution (default off)
 * Secrets (GitHub token, credential private key) are read ONLY by the
 * orchestration worker via loadWorkerSecrets, never by the API.
 */

import fs from "fs";

import { parsePublicKeyPem } from "./credentials.js";

export type SandboxMode = "off" | "remote";

export interface RepoPilotConfig {
  enabled: boolean;
  /** Private repositories send their content to the AI provider; off unless chosen. */
  allowPrivate: boolean;
  /** Open pull requests as drafts (default). */
  prDraft: boolean;
  /** Model id sent to the provider. */
  aiModel: string;
  sandboxMode: SandboxMode;
  /** Sealed-box public key for customer credentials (API + worker). */
  credentialPublicKey: string | null;
  limits: {
    maxActiveRuns: number;
    maxSnapshotFiles: number;
    maxSnapshotFileBytes: number;
    maxSnapshotTotalBytes: number;
    maxManifestFiles: number;
    maxAiRequestsPerRun: number;
    maxAiInputTokensPerRun: number;
    maxAiOutputTokensPerRun: number;
    maxContextTokens: number;
    aiTimeoutMs: number;
    cloneTimeoutMs: number;
    evidenceRetentionDays: number;
    verifyAttempts: number;
    verifyTimeoutMs: number;
    maxVerifyLogBytes: number;
  };
  rateLimits: {
    read: { windowMs: number; max: number };
    write: { windowMs: number; max: number };
    credentials: { windowMs: number; max: number };
  };
  problems: string[];
}

function intFrom(env: NodeJS.ProcessEnv, name: string, fallback: number, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}): number {
  const raw = env[name];

  if (raw === undefined || raw === "") {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }

  return value;
}

/** A PEM from VAR, or from the file named by VAR_FILE. */
function pemFrom(env: NodeJS.ProcessEnv, name: string): string | null {
  const file = env[`${name}_FILE`];

  if (file) {
    return fs.readFileSync(file, "utf-8");
  }

  const inline = env[name];

  // Environments cannot hold newlines easily; accept "\n" escapes.
  return inline ? inline.replace(/\\n/g, "\n") : null;
}

export function loadRepoPilotConfig(env: NodeJS.ProcessEnv = process.env): RepoPilotConfig {
  const problems: string[] = [];
  const enabled = env.REPOPILOT === "enabled";
  const sandboxRaw = env.REPOPILOT_SANDBOX || "off";
  let sandboxMode: SandboxMode = "off";

  if (sandboxRaw === "remote") {
    sandboxMode = "remote";
  } else if (sandboxRaw !== "off") {
    problems.push(`REPOPILOT_SANDBOX="${sandboxRaw}" is not supported (use "off" or "remote"); sandbox verification stays off`);
  }

  let credentialPublicKey: string | null = null;

  try {
    const pem = pemFrom(env, "REPOPILOT_CREDENTIAL_PUBLIC_KEY");

    if (pem) {
      credentialPublicKey = parsePublicKeyPem(pem);
    }
  } catch (error) {
    problems.push(error instanceof Error ? error.message : "REPOPILOT_CREDENTIAL_PUBLIC_KEY is invalid");
  }

  const rate = (name: string, windowMs: number, max: number) => ({
    windowMs,
    max: intFrom(env, `REPOPILOT_RATE_${name}_PER_MIN`, max, { min: 1, max: 100_000 }),
  });

  return {
    enabled,
    allowPrivate: env.REPOPILOT_ALLOW_PRIVATE === "true",
    prDraft: env.REPOPILOT_PR_DRAFT !== "false",
    aiModel: /^[A-Za-z0-9._-]{1,80}$/.test(env.REPOPILOT_AI_MODEL ?? "") ? (env.REPOPILOT_AI_MODEL as string) : "claude-sonnet-5-5",
    sandboxMode,
    credentialPublicKey,
    limits: {
      maxActiveRuns: intFrom(env, "REPOPILOT_MAX_ACTIVE_RUNS", 3, { max: 100 }),
      maxSnapshotFiles: intFrom(env, "REPOPILOT_MAX_SNAPSHOT_FILES", 5000, { max: 100_000 }),
      maxSnapshotFileBytes: intFrom(env, "REPOPILOT_MAX_FILE_BYTES", 256 * 1024, { max: 10 * 1024 * 1024 }),
      maxSnapshotTotalBytes: intFrom(env, "REPOPILOT_MAX_SNAPSHOT_BYTES", 25 * 1024 * 1024, { max: 1024 * 1024 * 1024 }),
      maxManifestFiles: intFrom(env, "REPOPILOT_MAX_MANIFEST_FILES", 2000, { max: 100_000 }),
      maxAiRequestsPerRun: intFrom(env, "REPOPILOT_MAX_AI_REQUESTS", 8, { max: 100 }),
      maxAiInputTokensPerRun: intFrom(env, "REPOPILOT_MAX_AI_INPUT_TOKENS", 200_000, { max: 5_000_000 }),
      maxAiOutputTokensPerRun: intFrom(env, "REPOPILOT_MAX_AI_OUTPUT_TOKENS", 40_000, { max: 1_000_000 }),
      maxContextTokens: intFrom(env, "REPOPILOT_MAX_CONTEXT_TOKENS", 60_000, { max: 1_000_000 }),
      aiTimeoutMs: intFrom(env, "REPOPILOT_AI_TIMEOUT_MS", 120_000, { min: 1000, max: 600_000 }),
      cloneTimeoutMs: intFrom(env, "REPOPILOT_CLONE_TIMEOUT_MS", 120_000, { min: 1000, max: 1_800_000 }),
      evidenceRetentionDays: intFrom(env, "REPOPILOT_EVIDENCE_RETENTION_DAYS", 90, { max: 3650 }),
      verifyAttempts: intFrom(env, "REPOPILOT_VERIFY_ATTEMPTS", 2, { max: 5 }),
      verifyTimeoutMs: intFrom(env, "REPOPILOT_VERIFY_TIMEOUT_MS", 300_000, { min: 1000, max: 3_600_000 }),
      maxVerifyLogBytes: intFrom(env, "REPOPILOT_MAX_VERIFY_LOG_BYTES", 256 * 1024, { min: 1024, max: 4 * 1024 * 1024 }),
    },
    rateLimits: {
      read: rate("READ", 60_000, 240),
      write: rate("WRITE", 60_000, 30),
      credentials: rate("CREDENTIALS", 60_000, 5),
    },
    problems,
  };
}

/** Secrets only the orchestration worker may read. Never call this in the API. */
export interface WorkerSecrets {
  githubToken: string | null;
  credentialPrivateKey: string | null;
}

export function loadWorkerSecrets(env: NodeJS.ProcessEnv = process.env): WorkerSecrets {
  return {
    githubToken: env.REPOPILOT_GITHUB_TOKEN || null,
    credentialPrivateKey: pemFrom(env, "REPOPILOT_CREDENTIAL_PRIVATE_KEY"),
  };
}

/**
 * The API process must never hold worker-only secrets. If the GitHub token
 * or the credential private key is visible in the API's environment (for
 * example because both services share one env file), RepoPilot refuses to
 * start there rather than quietly widening the blast radius of an API compromise.
 */
export function workerSecretsLeakedInto(env: NodeJS.ProcessEnv = process.env): string[] {
  const names = ["REPOPILOT_GITHUB_TOKEN", "REPOPILOT_CREDENTIAL_PRIVATE_KEY", "REPOPILOT_CREDENTIAL_PRIVATE_KEY_FILE"];

  return names.filter((name) => Boolean(env[name]));
}
