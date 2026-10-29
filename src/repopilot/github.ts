/**
 * GitHub REST client (read side; pull-request writes live in githubPr.ts).
 *
 * Security properties:
 *  - the API host is a constant: callers cannot point it elsewhere (no SSRF);
 *  - redirects are refused, never followed;
 *  - owner/repo are validated before they reach a URL;
 *  - every response is size-capped and validated with Zod: GitHub's JSON is
 *    treated as untrusted input;
 *  - blob contents are checked against their git SHA, so a tampered or
 *    truncated blob is detected;
 *  - the token is only ever placed in the Authorization header. It is never
 *    in a URL, a command line or an error message.
 * The token belongs to the orchestration worker; the API process has none.
 */

import crypto from "crypto";
import { z } from "zod";

import { StageError } from "./errors.js";
import { redactSensitive } from "./redact.js";
import { CommitShaSchema } from "./schemas.js";

export const GITHUB_API = "https://api.github.com";

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; redirect: "error" | "manual"; signal: AbortSignal }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
}>;

export interface GithubClientOptions {
  token: string | null;
  fetch?: FetchLike;
  timeoutMs?: number;
}

const RepoSchema = z.object({
  full_name: z.string(),
  default_branch: z.string().min(1).max(255),
  private: z.boolean(),
  archived: z.boolean().optional().default(false),
  fork: z.boolean().optional().default(false),
  // Kilobytes, as reported by GitHub.
  size: z.number().int().min(0),
  permissions: z.object({ push: z.boolean().optional(), pull: z.boolean().optional() }).partial().optional(),
});

const CommitSchema = z.object({ sha: CommitShaSchema });

const TreeEntrySchema = z.object({
  path: z.string(),
  mode: z.string(),
  type: z.enum(["blob", "tree", "commit"]),
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  size: z.number().int().min(0).optional(),
});

const TreeSchema = z.object({ sha: z.string(), truncated: z.boolean(), tree: z.array(TreeEntrySchema) });

const BlobSchema = z.object({ sha: z.string(), encoding: z.string(), content: z.string(), size: z.number().int().min(0) });

const RefSchema = z.object({ ref: z.string(), object: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }) });
const GitCommitSchema = z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/), tree: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }) });
const ShaOnlySchema = z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) });
const CompareSchema = z.object({ ahead_by: z.number().int().min(0), behind_by: z.number().int().min(0).optional(), files: z.array(z.object({ filename: z.string() })).optional().default([]) });
const PullSchema = z.object({ number: z.number().int().positive(), html_url: z.string().url(), state: z.string().optional(), head: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }) });

export type PullInfo = z.infer<typeof PullSchema>;
export type RepoInfo = z.infer<typeof RepoSchema>;
export type TreeEntry = z.infer<typeof TreeEntrySchema>;

export const MAX_TREE_RESPONSE_BYTES = 24 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_BLOB_RESPONSE_BYTES = 2 * 1024 * 1024;

/** git's blob object id: sha1("blob <len>\0<content>"). */
export function gitBlobSha(content: Buffer): string {
  return crypto.createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}

async function readCapped(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Buffer> {
  if (!body) {
    return Buffer.alloc(0);
  }

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    total += value.byteLength;

    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new StageError("github_response_too_large", "GitHub returned more data than RepoPilot allows", false);
    }

    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks);
}

/** Translate an HTTP failure into a stable, actionable StageError. */
export function githubFailure(status: number, headers: { get(name: string): string | null }, bodyText: string): StageError {
  const remaining = headers.get("x-ratelimit-remaining");
  const retryAfter = headers.get("retry-after");
  const reset = headers.get("x-ratelimit-reset");
  const message = redactSensitive(bodyText.slice(0, 200));

  if (status === 401) {
    return new StageError("github_auth_failed", "GitHub rejected the configured token (REPOPILOT_GITHUB_TOKEN is missing, expired or revoked).", false);
  }

  if (status === 429 || (status === 403 && (remaining === "0" || retryAfter !== null || /rate limit|abuse|secondary/i.test(bodyText)))) {
    const when = reset && /^[0-9]+$/.test(reset) ? ` Resets at ${new Date(Number(reset) * 1000).toISOString()}.` : "";

    return new StageError("github_rate_limited", `GitHub API rate limit reached.${when}`, true);
  }

  if (status === 403) {
    return new StageError("github_forbidden", "The configured token is not allowed to read this repository.", false);
  }

  if (status === 404) {
    return new StageError("repository_not_accessible", "The repository, ref or object was not found, or the configured token cannot access it.", false);
  }

  if (status === 409) {
    return new StageError("repository_empty", "The repository has no commits to analyse.", false);
  }

  if (status === 422) {
    return new StageError("invalid_ref", "GitHub could not resolve that ref.", false);
  }

  if (status === 451) {
    return new StageError("repository_unavailable", "GitHub has made this repository unavailable for legal reasons.", false);
  }

  if (status === 301 || status === 302 || status === 307 || status === 308) {
    return new StageError("repository_moved", "The repository was renamed or moved; authorise its new name.", false);
  }

  if (status >= 500) {
    return new StageError("github_unavailable", `GitHub is unavailable (HTTP ${status}).`, true);
  }

  return new StageError("github_error", `Unexpected GitHub response (HTTP ${status}): ${message}`, false);
}

export function createGithubClient(options: GithubClientOptions) {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? 30_000;

  function assertRepo(owner: string, name: string): void {
    if (!OWNER.test(owner) || !NAME.test(name) || name === "." || name === "..") {
      throw new StageError("invalid_repository", "Invalid repository name.", false);
    }
  }

  async function request(method: string, path: string, { body, maxBytes = MAX_JSON_BYTES, signal }: { body?: unknown; maxBytes?: number; signal?: AbortSignal } = {}): Promise<unknown> {
    if (!options.token) {
      throw new StageError("github_not_configured", "REPOPILOT_GITHUB_TOKEN is not set on the worker, so GitHub cannot be read.", false);
    }

    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Awaited<ReturnType<FetchLike>>;

    try {
      response = await doFetch(`${GITHUB_API}${path}`, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${options.token}`,
          "User-Agent": "ShipFlow-RepoPilot",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        // A redirect would send the token to whatever host the response names.
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new StageError("cancelled", "The run was cancelled.", false);
      }

      const causeMessage = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
      const redirect = error instanceof Error && /redirect/i.test(`${error.message} ${causeMessage}`);

      // Network errors and timeouts are transient. Never include the error text:
      // it can contain the request URL.
      throw redirect
        ? new StageError("repository_moved", "The repository was renamed or moved; authorise its new name.", false)
        : new StageError("github_unavailable", "Could not reach GitHub (network error or timeout).", true);
    }

    const bytes = await readCapped(response.body, maxBytes);
    const text = bytes.toString("utf-8");

    if (response.status < 200 || response.status >= 300) {
      throw githubFailure(response.status, response.headers, text);
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new StageError("github_bad_response", "GitHub returned a response that is not valid JSON.", true);
    }
  }

  function parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);

    if (!result.success) {
      throw new StageError("github_bad_response", "GitHub returned an unexpected response shape.", false);
    }

    return result.data;
  }

  return {
    request,
    parse,
    assertRepo,

    async getRepository(owner: string, name: string, signal?: AbortSignal): Promise<RepoInfo> {
      assertRepo(owner, name);

      return parse(RepoSchema, await request("GET", `/repos/${owner}/${name}`, signal ? { signal } : {}));
    },

    /** Resolve a branch, tag or commit to an exact 40-character commit SHA. */
    async resolveCommit(owner: string, name: string, ref: string, signal?: AbortSignal): Promise<string> {
      assertRepo(owner, name);

      return parse(CommitSchema, await request("GET", `/repos/${owner}/${name}/commits/${encodeURIComponent(ref)}`, signal ? { signal } : {})).sha;
    },

    async getTree(owner: string, name: string, commitSha: string, signal?: AbortSignal): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
      assertRepo(owner, name);
      CommitShaSchema.parse(commitSha);

      const tree = parse(TreeSchema, await request("GET", `/repos/${owner}/${name}/git/trees/${commitSha}?recursive=1`, { maxBytes: MAX_TREE_RESPONSE_BYTES, ...(signal ? { signal } : {}) }));

      return { entries: tree.tree, truncated: tree.truncated };
    },

    /** File content, verified against its git object id. */
    async getBlob(owner: string, name: string, blobSha: string, signal?: AbortSignal): Promise<Buffer> {
      assertRepo(owner, name);

      if (!/^[0-9a-f]{40}$/.test(blobSha)) {
        throw new StageError("invalid_object", "Invalid object id.", false);
      }

      const blob = parse(BlobSchema, await request("GET", `/repos/${owner}/${name}/git/blobs/${blobSha}`, { maxBytes: MAX_BLOB_RESPONSE_BYTES, ...(signal ? { signal } : {}) }));

      if (blob.encoding !== "base64") {
        throw new StageError("github_bad_response", "Unexpected blob encoding.", false);
      }

      const content = Buffer.from(blob.content, "base64");

      if (gitBlobSha(content) !== blobSha || content.length !== blob.size) {
        throw new StageError("github_integrity_failed", "A downloaded file did not match its git object id.", false);
      }

      return content;
    },

    // ----------------------------------------------------------- write side
    // Used only by the pull-request stage, after explicit human authorisation.

    /** The commit a branch points at, or null if the branch does not exist. */
    async getBranchHead(owner: string, name: string, branch: string, signal?: AbortSignal): Promise<string | null> {
      assertRepo(owner, name);

      try {
        return parse(RefSchema, await request("GET", `/repos/${owner}/${name}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`, signal ? { signal } : {})).object.sha;
      } catch (error) {
        if (error instanceof StageError && error.code === "repository_not_accessible") return null;
        throw error;
      }
    },

    async getCommitTree(owner: string, name: string, commitSha: string, signal?: AbortSignal): Promise<string> {
      assertRepo(owner, name);
      CommitShaSchema.parse(commitSha);

      return parse(GitCommitSchema, await request("GET", `/repos/${owner}/${name}/git/commits/${commitSha}`, signal ? { signal } : {})).tree.sha;
    },

    /** How far `head` is ahead of `base`, and which files differ. */
    async compare(owner: string, name: string, base: string, head: string, signal?: AbortSignal): Promise<{ aheadBy: number; files: string[] }> {
      assertRepo(owner, name);
      CommitShaSchema.parse(base);

      const result = parse(CompareSchema, await request("GET", `/repos/${owner}/${name}/compare/${base}...${encodeURIComponent(head)}`, { maxBytes: 4 * 1024 * 1024, ...(signal ? { signal } : {}) }));

      return { aheadBy: result.ahead_by, files: result.files.map((file) => file.filename) };
    },

    async createBlob(owner: string, name: string, content: string, signal?: AbortSignal): Promise<string> {
      assertRepo(owner, name);

      return parse(ShaOnlySchema, await request("POST", `/repos/${owner}/${name}/git/blobs`, { body: { content, encoding: "utf-8" }, ...(signal ? { signal } : {}) })).sha;
    },

    async createTree(owner: string, name: string, baseTree: string, entries: ReadonlyArray<{ path: string; sha: string }>, signal?: AbortSignal): Promise<string> {
      assertRepo(owner, name);

      return parse(ShaOnlySchema, await request("POST", `/repos/${owner}/${name}/git/trees`, {
        body: { base_tree: baseTree, tree: entries.map((e) => ({ path: e.path, mode: "100644", type: "blob", sha: e.sha })) },
        ...(signal ? { signal } : {}),
      })).sha;
    },

    async createCommit(owner: string, name: string, input: { message: string; tree: string; parent: string }, signal?: AbortSignal): Promise<string> {
      assertRepo(owner, name);

      return parse(ShaOnlySchema, await request("POST", `/repos/${owner}/${name}/git/commits`, { body: { message: input.message, tree: input.tree, parents: [input.parent] }, ...(signal ? { signal } : {}) })).sha;
    },

    /** Create a NEW branch. Refuses anything outside refs/heads/repopilot/. */
    async createBranch(owner: string, name: string, branch: string, commitSha: string, signal?: AbortSignal): Promise<void> {
      assertRepo(owner, name);

      if (!/^repopilot\/[A-Za-z0-9._-]{1,200}$/.test(branch)) {
        throw new StageError("invalid_branch", "RepoPilot only creates branches under repopilot/.", false);
      }

      await request("POST", `/repos/${owner}/${name}/git/refs`, { body: { ref: `refs/heads/${branch}`, sha: commitSha }, ...(signal ? { signal } : {}) });
    },

    async findPullRequestForBranch(owner: string, name: string, branch: string, signal?: AbortSignal): Promise<PullInfo | null> {
      assertRepo(owner, name);

      const list = parse(z.array(PullSchema), await request("GET", `/repos/${owner}/${name}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}`, signal ? { signal } : {}));

      return list[0] ?? null;
    },

    async createPullRequest(owner: string, name: string, input: { title: string; body: string; head: string; base: string; draft: boolean }, signal?: AbortSignal): Promise<PullInfo> {
      assertRepo(owner, name);

      if (input.head === input.base) {
        throw new StageError("invalid_branch", "A pull request needs a head branch different from its base.", false);
      }

      return parse(PullSchema, await request("POST", `/repos/${owner}/${name}/pulls`, { body: input, ...(signal ? { signal } : {}) }));
    },
  };
}

export type GithubClient = ReturnType<typeof createGithubClient>;
