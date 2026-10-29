/**
 * Apply a VALIDATED proposal to an in-memory file set.
 *
 * Strict by design: hunks must match at exactly the line they name (no
 * fuzz, no offset search), added files must not already exist, modified
 * files must. A mismatch is a failure; nothing is "repaired", because a
 * patch that needs repairing is a patch nobody reviewed.
 *
 * Operates on strings only: no filesystem, no process, no archive handling.
 */

import { hunksOf, validatePatchProposal } from "./patch.js";
import type { ParsedFile, PatchIssue, ValidateOptions } from "./patch.js";

export type ApplyIssueCode =
  | "policy_rejected"
  | "file_missing"
  | "file_exists"
  | "context_mismatch"
  | "out_of_range"
  | "binary_content"
  | "result_too_large";

export interface ApplyIssue {
  code: ApplyIssueCode;
  message: string;
  path?: string;
}

export type ApplyResult =
  | {
      ok: true;
      /** Path -> full new content, for every file the proposal adds or modifies. */
      changed: Map<string, string>;
      /** Which paths came from the regression-test diff. */
      testPaths: Set<string>;
    }
  | { ok: false; issues: ApplyIssue[]; policyIssues?: PatchIssue[] };

export const MAX_RESULT_FILE_BYTES = 512 * 1024;

class ApplyError extends Error {
  constructor(
    readonly code: ApplyIssueCode,
    message: string,
    readonly path: string
  ) {
    super(message);
    this.name = "ApplyError";
  }
}

function splitLines(content: string): { lines: string[]; endsWithNewline: boolean } {
  if (content === "") {
    return { lines: [], endsWithNewline: false };
  }

  const endsWithNewline = content.endsWith("\n");
  const lines = content.split("\n");

  if (endsWithNewline) {
    lines.pop();
  }

  return { lines, endsWithNewline };
}

function applyToFile(file: ParsedFile, original: string | null): string {
  const hunks = hunksOf(file);

  if (file.kind === "add") {
    if (original !== null) {
      throw new ApplyError("file_exists", "file already exists", file.path);
    }

    const hunk = hunks[0];
    const body = (hunk?.lines ?? []).map((line) => line.slice(1));

    return body.length === 0 ? "" : body.join("\n") + (hunk?.newNoEol ? "" : "\n");
  }

  if (original === null) {
    throw new ApplyError("file_missing", "file does not exist", file.path);
  }

  if (original.includes("\0")) {
    throw new ApplyError("binary_content", "file is not text", file.path);
  }

  const { lines: source, endsWithNewline } = splitLines(original);
  const out: string[] = [];
  let cursor = 0; // index into `source` of the next unconsumed line
  let eof = endsWithNewline;

  for (const hunk of hunks) {
    // A hunk with no old lines inserts AFTER oldStart; otherwise it starts AT it.
    const startIndex = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;

    if (startIndex < cursor || startIndex > source.length) {
      throw new ApplyError("out_of_range", `hunk @@ -${hunk.oldStart} is outside the file`, file.path);
    }

    out.push(...source.slice(cursor, startIndex));
    cursor = startIndex;

    for (const line of hunk.lines) {
      const marker = line[0];
      const text = line.slice(1);

      if (marker === "+") {
        out.push(text);
        continue;
      }

      if (source[cursor] !== text) {
        throw new ApplyError("context_mismatch", `hunk @@ -${hunk.oldStart},${hunk.oldCount} does not match the file at line ${cursor + 1}`, file.path);
      }

      if (marker === " ") {
        out.push(text);
      }

      cursor += 1;
    }

    // The hunk reached the end of the old file: its marker decides the final newline.
    if (cursor === source.length) {
      eof = !hunk.newNoEol;
    }

    if (hunk.oldNoEol && endsWithNewline && cursor === source.length) {
      throw new ApplyError("context_mismatch", "patch expects no trailing newline but the file has one", file.path);
    }
  }

  out.push(...source.slice(cursor));

  return out.length === 0 ? "" : out.join("\n") + (eof ? "\n" : "");
}

/**
 * Validate (policy) and apply a source diff and a regression-test diff to
 * `files`. `files` is never mutated.
 */
export function applyProposal(
  files: ReadonlyMap<string, string>,
  proposal: { diff: string; testDiff: string },
  options: ValidateOptions = {}
): ApplyResult {
  const validated = validatePatchProposal(proposal, options);

  if (!validated.ok) {
    return {
      ok: false,
      issues: [{ code: "policy_rejected", message: "the proposal violates patch policy" }],
      policyIssues: validated.issues,
    };
  }

  const changed = new Map<string, string>();
  const testPaths = new Set<string>();
  const issues: ApplyIssue[] = [];

  for (const [patch, isTest] of [[validated.source, false], [validated.test, true]] as const) {
    for (const file of patch.files) {
      try {
        const content = applyToFile(file, files.get(file.path) ?? null);

        if (Buffer.byteLength(content, "utf-8") > MAX_RESULT_FILE_BYTES) {
          throw new ApplyError("result_too_large", "resulting file is too large", file.path);
        }

        changed.set(file.path, content);

        if (isTest) {
          testPaths.add(file.path);
        }
      } catch (error) {
        if (error instanceof ApplyError) {
          issues.push({ code: error.code, message: error.message, path: error.path });
        } else {
          throw error;
        }
      }
    }
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, changed, testPaths };
}
