/**
 * Zod schemas for RepoPilot.
 *
 * Three families with different trust levels:
 *
 *  1. Client requests (CreateRunRequest, AuthorizePrRequest): from an
 *     authenticated human through the API.
 *  2. Model output (AnalysisOutputSchema, PatchProposalSchema): UNTRUSTED.
 *     Strict objects with no field for test results, verification status,
 *     sandbox outcome or authorization, so none can be smuggled in.
 *     Always parse through parseModelOutput.
 *  3. Sandbox records (SandboxRunSchema): written only by the sandbox
 *     result path. Never accepted from a model or a client.
 */

import { z } from "zod";

import { checkRepoPath } from "./paths.js";

// ----------------------------------------------------------------- shared

export const MAX_MODEL_OUTPUT_BYTES = 256 * 1024;
export const MAX_FINDINGS = 20;

export const CommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/, "must be a 40-character lowercase commit SHA");

export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase SHA-256 hex digest");

export interface GithubRepo {
  owner: string;
  name: string;
  /** Canonical https://github.com/<owner>/<name> (no .git, no trailing slash). */
  url: string;
}

const GITHUB_URL =
  /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/;

/**
 * Accept only https://github.com/<owner>/<repo>[.git]. The input is matched
 * as a whole string rather than parsed with URL, so ./.. segments, userinfo,
 * ports, queries, fragments and other hosts cannot be normalised into a
 * valid-looking address.
 */
export function parseGithubRepoUrl(
  value: unknown
): { ok: true; value: GithubRepo } | { ok: false; message: string } {
  if (typeof value !== "string") {
    return { ok: false, message: "repoUrl must be a string" };
  }

  const match = GITHUB_URL.exec(value.trim());
  const owner = match?.[1];
  const name = match?.[2];

  if (!owner || !name || name === "." || name === "..") {
    return {
      ok: false,
      message: "repoUrl must look like https://github.com/<owner>/<repo>",
    };
  }

  return {
    ok: true,
    value: { owner, name, url: `https://github.com/${owner}/${name}` },
  };
}

export const GithubRepoUrlSchema = z
  .string()
  .max(300)
  .transform((value, context) => {
    const parsed = parseGithubRepoUrl(value);

    if (!parsed.ok) {
      context.addIssue({ code: "custom", message: parsed.message });
      return z.NEVER;
    }

    return parsed.value;
  });

const RepoPathSchema = z.string().superRefine((value, context) => {
  const checked = checkRepoPath(value);

  if (!checked.ok) {
    context.addIssue({ code: "custom", message: checked.message });
  }
});

// -------------------------------------------------------- client requests

export const CreateRunRequestSchema = z.strictObject({
  repoUrl: GithubRepoUrlSchema,
});

/**
 * A human's explicit authorization to open a pull request. It names the
 * patch and the digest of the exact diff reviewed, so approval cannot be
 * replayed against a different patch. Only the API may build this from an
 * authenticated user request, never from model output.
 */
export const AuthorizePrRequestSchema = z.strictObject({
  patchId: z.number().int().positive(),
  diffSha256: Sha256Schema,
  confirm: z.literal(true),
});

// ----------------------------------------------------------- model output

export const FINDING_CATEGORIES = [
  "bug",
  "security",
  "error-handling",
  "correctness",
  "performance",
  "maintainability",
] as const;

export const FindingSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(160),
    category: z.enum(FINDING_CATEGORIES),
    file: RepoPathSchema,
    lineStart: z.number().int().min(1).max(10_000_000),
    lineEnd: z.number().int().min(1).max(10_000_000),
    evidence: z.string().trim().min(1).max(2000),
    // A suggestion about the model's own certainty, never ground truth.
    confidence: z.number().min(0).max(1),
  })
  .refine((finding) => finding.lineEnd >= finding.lineStart, {
    message: "lineEnd must not be before lineStart",
    path: ["lineEnd"],
  });

export const AnalysisOutputSchema = z.strictObject({
  findings: z.array(FindingSchema).max(MAX_FINDINGS),
});

export const PatchProposalSchema = z.strictObject({
  title: z.string().trim().min(1).max(160),
  explanation: z.string().trim().min(1).max(2000),
  /** Unified diff of the source change. Validated byte-for-byte by patch.ts. */
  diff: z.string().min(1).max(200_000),
  /** Unified diff that adds the regression test(s). */
  testDiff: z.string().min(1).max(200_000),
});

export type Finding = z.infer<typeof FindingSchema>;
export type AnalysisOutput = z.infer<typeof AnalysisOutputSchema>;
export type PatchProposal = z.infer<typeof PatchProposalSchema>;

/**
 * Keys a model must never supply, normalised (lower-case, letters and
 * digits only). The strict schemas already reject unknown keys; this deep
 * scan also catches them nested inside otherwise valid values and gives a
 * specific failure reason for audit.
 */
const AUTHORITATIVE_KEYS: ReadonlySet<string> = new Set([
  "verified", "verification", "verificationstatus", "verificationresult",
  "outcome", "result", "results", "testresult", "testresults", "testspassed",
  "testspassing", "testsstatus", "teststatus", "passed", "failed", "exitcode",
  "sandbox", "sandboxresult", "sandboxstatus", "status", "validated",
  "validation", "validationresult", "authorized", "authorization", "approved",
  "approval", "confirm", "confirmed", "prauthorized", "merge", "automerge",
  "baseline", "patched", "control",
]);

const MAX_SCAN_DEPTH = 20;

function findAuthoritativeKey(value: unknown, depth = 0): string | null {
  if (depth > MAX_SCAN_DEPTH) {
    return "(nesting too deep)";
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findAuthoritativeKey(item, depth + 1);

      if (found) return found;
    }

    return null;
  }

  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (AUTHORITATIVE_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, ""))) {
        return key;
      }

      const found = findAuthoritativeKey(child, depth + 1);

      if (found) return found;
    }
  }

  return null;
}

export type ModelParseFailure =
  | "too_large"
  | "not_json"
  | "authoritative_field"
  | "schema";

export type ModelParse<T> =
  | { ok: true; value: T }
  | { ok: false; code: ModelParseFailure; message: string };

/**
 * Parse a model response (JSON text or an already-decoded value) against a
 * strict schema. Never throws: every failure is a typed result.
 */
export function parseModelOutput<T>(
  schema: z.ZodType<T>,
  raw: unknown
): ModelParse<T> {
  let value = raw;

  if (typeof raw === "string") {
    if (Buffer.byteLength(raw, "utf-8") > MAX_MODEL_OUTPUT_BYTES) {
      return { ok: false, code: "too_large", message: "model output is too large" };
    }

    try {
      value = JSON.parse(raw);
    } catch {
      return { ok: false, code: "not_json", message: "model output is not valid JSON" };
    }
  }

  const forbidden = findAuthoritativeKey(value);

  if (forbidden) {
    return {
      ok: false,
      code: "authoritative_field",
      message: `model output may not include "${forbidden}"`,
    };
  }

  const parsed = schema.safeParse(value);

  if (!parsed.success) {
    return {
      ok: false,
      code: "schema",
      message: parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; "),
    };
  }

  return { ok: true, value: parsed.data };
}

// ---------------------------------------------------------- sandbox record

/**
 * One execution of the repository's test script inside the sandbox.
 * The ONLY input to outcome classification. Built from sandbox worker
 * results; it is deliberately not reachable from any model-output schema.
 */
export const SandboxRunSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("exited"),
    exitCode: z.number().int().min(0).max(255),
    durationMs: z.number().int().min(0),
  }),
  z.strictObject({ kind: z.literal("timeout"), durationMs: z.number().int().min(0) }),
  z.strictObject({ kind: z.literal("infra_error"), detail: z.string().max(500).optional() }),
  z.strictObject({ kind: z.literal("resource_limit"), detail: z.string().max(500).optional() }),
  z.strictObject({ kind: z.literal("no_test_script") }),
]);

export type SandboxRun = z.infer<typeof SandboxRunSchema>;
