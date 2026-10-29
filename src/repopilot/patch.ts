/**
 * Deterministic validation of AI-proposed patches.
 *
 * A proposal is two unified diffs: a source change and a regression test.
 * Both are untrusted text. Nothing here touches the filesystem or runs
 * anything; a diff that passes is only "well formed and within policy",
 * which says nothing about whether it is correct.
 *
 * Policy:
 *  - git-style unified diffs only (a/ and b/ prefixes); no binary patches,
 *    renames, copies, deletions, mode changes, symlinks or submodules;
 *  - hunk line counts must match their headers exactly;
 *  - only JavaScript/TypeScript files; never CI, Docker, env, lockfile,
 *    package manifest or test-runner configuration paths;
 *  - the source diff may not touch test files; the test diff may only
 *    ADD new test files (it cannot rewrite existing tests to make them pass);
 *  - bounded bytes, files, changed lines and line length.
 */

import crypto from "crypto";

import { checkRepoPath, forbiddenPathReason, isCodeFile, isTestPath, sensitiveCodeReason } from "./paths.js";

export type DiffRole = "source" | "test";

export type PatchIssueCode =
  | "empty_diff"
  | "not_text"
  | "too_large"
  | "too_many_files"
  | "too_many_changed_lines"
  | "line_too_long"
  | "nul_byte"
  | "malformed"
  | "binary_patch"
  | "rename_or_copy"
  | "delete_file"
  | "mode_change"
  | "symlink"
  | "submodule"
  | "invalid_path"
  | "absolute_path"
  | "path_traversal"
  | "forbidden_path"
  | "sensitive_code"
  | "unexpected_file_type"
  | "test_file_in_source_patch"
  | "non_test_file_in_test_patch"
  | "test_modifies_existing_file"
  | "add_existing_file"
  | "modify_missing_file"
  | "duplicate_path"
  | "missing_test_patch";

export interface PatchIssue {
  code: PatchIssueCode;
  message: string;
  role: DiffRole | "proposal";
  path?: string;
}

export interface PatchLimits {
  maxSourceBytes: number;
  maxSourceFiles: number;
  maxSourceChangedLines: number;
  maxTestBytes: number;
  maxTestFiles: number;
  maxTestChangedLines: number;
  maxLineLength: number;
}

export const DEFAULT_PATCH_LIMITS: Readonly<PatchLimits> = {
  maxSourceBytes: 64 * 1024,
  maxSourceFiles: 5,
  maxSourceChangedLines: 1000,
  maxTestBytes: 32 * 1024,
  maxTestFiles: 3,
  maxTestChangedLines: 600,
  maxLineLength: 1000,
};

export interface ValidateOptions {
  limits?: Partial<PatchLimits>;
  /** Files in the pinned snapshot. When given, adds/modifies are checked against it. */
  existingFiles?: ReadonlySet<string>;
  /** Snapshot paths that are symlinks; a patch may not touch them or anything beneath. */
  symlinkPaths?: ReadonlySet<string>;
}

export interface ParsedFile {
  path: string;
  kind: "add" | "modify";
  added: number;
  removed: number;
  hunks: number;
}

export interface ParsedPatch {
  role: DiffRole;
  files: ParsedFile[];
  bytes: number;
  added: number;
  removed: number;
}

export type DiffValidation =
  | { ok: true; patch: ParsedPatch }
  | { ok: false; issues: PatchIssue[] };

export type ProposalValidation =
  | {
      ok: true;
      source: ParsedPatch;
      test: ParsedPatch;
      /** Binds a later user authorization to these exact bytes. */
      digest: string;
    }
  | { ok: false; issues: PatchIssue[] };

// ------------------------------------------------------------------ parser

class DiffSyntaxError extends Error {
  constructor(
    readonly code: PatchIssueCode,
    message: string
  ) {
    super(message);
    this.name = "DiffSyntaxError";
  }
}

interface ParseLimits {
  maxFiles: number;
  maxChangedLines: number;
  maxLineLength: number;
}

const GIT_HEADER = /^diff --git a\/(\S+) b\/(\S+)$/;
const INDEX_LINE = /^index [0-9a-f]{7,64}\.\.[0-9a-f]{7,64}(?: (\d{6}))?$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;
const NO_NEWLINE_MARKER = "\\ No newline at end of file";

function malformed(message: string): DiffSyntaxError {
  return new DiffSyntaxError("malformed", message);
}

function checkMode(mode: string): void {
  if (mode === "100644") {
    return;
  }

  if (mode === "120000") {
    throw new DiffSyntaxError("symlink", "symlinks are not allowed");
  }

  if (mode === "160000") {
    throw new DiffSyntaxError("submodule", "submodule changes are not allowed");
  }

  throw new DiffSyntaxError("mode_change", `unsupported file mode ${mode}`);
}

/** Inspect one extended git header line. Returns true for "new file mode". */
function inspectExtendedHeader(line: string): boolean {
  if (line.startsWith("new file mode ")) {
    checkMode(line.slice("new file mode ".length));
    return true;
  }

  if (line.startsWith("deleted file mode")) {
    throw new DiffSyntaxError("delete_file", "deleting files is not allowed");
  }

  if (line.startsWith("old mode") || line.startsWith("new mode")) {
    throw new DiffSyntaxError("mode_change", "file mode changes are not allowed");
  }

  if (
    line.startsWith("rename ") ||
    line.startsWith("copy ") ||
    line.startsWith("similarity index") ||
    line.startsWith("dissimilarity index")
  ) {
    throw new DiffSyntaxError("rename_or_copy", "renames and copies are not allowed");
  }

  if (line.startsWith("GIT binary patch") || line.startsWith("Binary files")) {
    throw new DiffSyntaxError("binary_patch", "binary patches are not allowed");
  }

  const index = INDEX_LINE.exec(line);

  if (index) {
    if (index[1] !== undefined) {
      checkMode(index[1]);
    }

    return false;
  }

  throw malformed(`unexpected header line: ${JSON.stringify(line.slice(0, 80))}`);
}

function specPath(spec: string, prefix: "a/" | "b/"): string | null {
  if (spec === "/dev/null") {
    return null;
  }

  if (!spec.startsWith(prefix)) {
    throw malformed(`file header must start with ${prefix} or be /dev/null`);
  }

  return spec.slice(prefix.length);
}

/** One parsed hunk, kept so a validated diff can be applied exactly. */
export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** Body lines including their ' ', '-' or '+' marker. */
  lines: string[];
  /** "\\ No newline at end of file" followed a line present in the old text. */
  oldNoEol: boolean;
  /** ... followed a line present in the new text. */
  newNoEol: boolean;
}

// Hunk bodies of validated files, read only by the applier. Kept out of
// ParsedFile so that type (and the JSON stored with a patch) is unchanged.
const HUNK_DATA = new WeakMap<ParsedFile, Hunk[]>();

export function hunksOf(file: ParsedFile): readonly Hunk[] {
  return HUNK_DATA.get(file) ?? [];
}

function parseHunks(
  lines: string[],
  start: number,
  kind: "add" | "modify",
  limits: ParseLimits
): { added: number; removed: number; hunks: number; next: number; hunkData: Hunk[] } {
  const hunkData: Hunk[] = [];
  let index = start;
  let added = 0;
  let removed = 0;
  let hunks = 0;
  let previousOldEnd = 0;

  for (;;) {
    const header = lines[index];

    if (header === undefined || !header.startsWith("@@")) {
      break;
    }

    const match = HUNK_HEADER.exec(header);

    if (!match) {
      throw malformed(`bad hunk header: ${JSON.stringify(header.slice(0, 80))}`);
    }

    const oldStart = Number(match[1]);
    const oldCount = match[2] === undefined ? 1 : Number(match[2]);
    const newStart = Number(match[3]);
    const newCount = match[4] === undefined ? 1 : Number(match[4]);

    if (kind === "add") {
      if (hunks > 0 || oldStart !== 0 || oldCount !== 0 || newStart !== 1 || newCount < 1) {
        throw malformed("a new file must be a single hunk of the form @@ -0,0 +1,N @@");
      }
    } else if (
      (oldStart === 0 && oldCount !== 0) ||
      (newStart === 0 && newCount !== 0) ||
      oldStart < previousOldEnd
    ) {
      throw malformed("hunks overlap, are out of order, or start at line 0");
    }

    index += 1;
    let oldLeft = oldCount;
    let newLeft = newCount;
    const bodyStart = index;
    const hunk: Hunk = { oldStart, oldCount, newStart, newCount, lines: [], oldNoEol: false, newNoEol: false };

    const markNoEol = (previous: string | undefined): void => {
      if (previous === " " || previous === "-") hunk.oldNoEol = true;
      if (previous === " " || previous === "+") hunk.newNoEol = true;
    };

    while (oldLeft > 0 || newLeft > 0) {
      const line = lines[index];

      if (line === undefined) {
        throw malformed("hunk is truncated: fewer lines than its header declares");
      }

      const marker = line[0];

      if (marker === " ") {
        if (oldLeft === 0 || newLeft === 0) {
          throw malformed("hunk has more lines than its header declares");
        }

        oldLeft -= 1;
        newLeft -= 1;
        hunk.lines.push(line);
      } else if (marker === "-") {
        if (oldLeft === 0) {
          throw malformed("hunk has more lines than its header declares");
        }

        oldLeft -= 1;
        removed += 1;
        hunk.lines.push(line);
      } else if (marker === "+") {
        if (newLeft === 0) {
          throw malformed("hunk has more lines than its header declares");
        }

        if (line.length - 1 > limits.maxLineLength) {
          throw new DiffSyntaxError(
            "line_too_long",
            `an added line exceeds ${limits.maxLineLength} characters`
          );
        }

        newLeft -= 1;
        added += 1;
        hunk.lines.push(line);
      } else if (marker === "\\") {
        if (index === bodyStart || line !== NO_NEWLINE_MARKER) {
          throw malformed("misplaced or unrecognised '\\' line");
        }

        markNoEol(lines[index - 1]?.[0]);
      } else {
        throw malformed(
          line === ""
            ? "blank line inside hunk (context lines must start with a space)"
            : "line inside a hunk must start with ' ', '-', '+' or '\\'"
        );
      }

      index += 1;
    }

    // The no-newline marker may follow the final line of the hunk.
    if (lines[index] === NO_NEWLINE_MARKER) {
      markNoEol(lines[index - 1]?.[0]);
      index += 1;
    }

    hunkData.push(hunk);
    hunks += 1;
    previousOldEnd = oldStart + oldCount;

    if (added + removed > limits.maxChangedLines) {
      throw new DiffSyntaxError(
        "too_many_changed_lines",
        "diff exceeds the changed-line limit"
      );
    }
  }

  if (hunks === 0) {
    throw malformed("file change has no hunks");
  }

  return { added, removed, hunks, next: index, hunkData };
}

function parseUnifiedDiff(text: string, limits: ParseLimits): ParsedFile[] {
  if (text.includes("\0")) {
    throw new DiffSyntaxError("nul_byte", "diff contains a NUL byte");
  }

  if (text.trim() === "") {
    throw new DiffSyntaxError("empty_diff", "diff is empty");
  }

  const lines = text.split("\n");

  if (lines[lines.length - 1] === "") {
    lines.pop();
  }

  if (lines.length === 0) {
    throw new DiffSyntaxError("empty_diff", "diff is empty");
  }

  const files: ParsedFile[] = [];
  let index = 0;
  let changed = 0;

  while (index < lines.length) {
    const first = lines[index] ?? "";
    let git: { a: string; b: string } | null = null;
    let declaredNew = false;

    if (first.startsWith("diff --git ")) {
      const match = GIT_HEADER.exec(first);

      if (!match) {
        throw malformed("bad 'diff --git' header (paths with spaces are not supported)");
      }

      git = { a: match[1] ?? "", b: match[2] ?? "" };
      index += 1;

      for (;;) {
        const line = lines[index];

        if (line === undefined) {
          throw malformed("file header has no ---/+++ lines");
        }

        if (line.startsWith("--- ")) {
          break;
        }

        declaredNew = inspectExtendedHeader(line) || declaredNew;
        index += 1;
      }
    } else if (!first.startsWith("--- ")) {
      throw malformed(`unexpected line outside a file change: ${JSON.stringify(first.slice(0, 80))}`);
    }

    const oldLine = lines[index] ?? "";
    const newLine = lines[index + 1];

    if (newLine === undefined || !newLine.startsWith("+++ ")) {
      throw malformed("'--- ' line must be followed by a '+++ ' line");
    }

    index += 2;

    const oldPath = specPath(oldLine.slice(4), "a/");
    const newPath = specPath(newLine.slice(4), "b/");

    if (oldPath === null && newPath === null) {
      throw malformed("both sides of a file change are /dev/null");
    }

    if (newPath === null) {
      throw new DiffSyntaxError("delete_file", "deleting files is not allowed");
    }

    if (oldPath !== null && oldPath !== newPath) {
      throw new DiffSyntaxError("rename_or_copy", "renames and copies are not allowed");
    }

    const kind = oldPath === null ? "add" : "modify";

    if (git && (git.a !== newPath || git.b !== newPath)) {
      throw malformed("'diff --git' paths do not match the ---/+++ paths");
    }

    if (declaredNew !== (kind === "add")) {
      throw malformed("'new file mode' does not match the ---/+++ lines");
    }

    const hunks = parseHunks(lines, index, kind, {
      ...limits,
      maxChangedLines: limits.maxChangedLines - changed,
    });

    index = hunks.next;
    changed += hunks.added + hunks.removed;
    const entry: ParsedFile = {
      path: newPath,
      kind,
      added: hunks.added,
      removed: hunks.removed,
      hunks: hunks.hunks,
    };

    HUNK_DATA.set(entry, hunks.hunkData);
    files.push(entry);

    if (files.length > limits.maxFiles) {
      throw new DiffSyntaxError("too_many_files", `more than ${limits.maxFiles} files changed`);
    }
  }

  return files;
}

// ------------------------------------------------------------------ policy

function limitsFor(role: DiffRole, overrides?: Partial<PatchLimits>) {
  const limits = { ...DEFAULT_PATCH_LIMITS, ...overrides };

  return role === "source"
    ? {
        maxBytes: limits.maxSourceBytes,
        maxFiles: limits.maxSourceFiles,
        maxChangedLines: limits.maxSourceChangedLines,
        maxLineLength: limits.maxLineLength,
      }
    : {
        maxBytes: limits.maxTestBytes,
        maxFiles: limits.maxTestFiles,
        maxChangedLines: limits.maxTestChangedLines,
        maxLineLength: limits.maxLineLength,
      };
}

function underSymlink(path: string, symlinks: ReadonlySet<string>): boolean {
  for (const link of symlinks) {
    if (path === link || path.startsWith(`${link}/`)) {
      return true;
    }
  }

  return false;
}

function policyIssues(
  file: ParsedFile,
  role: DiffRole,
  options: ValidateOptions
): PatchIssue[] {
  const issue = (code: PatchIssueCode, message: string): PatchIssue => ({
    code,
    message,
    role,
    path: file.path,
  });

  const checked = checkRepoPath(file.path);

  if (!checked.ok) {
    return [issue(checked.code, checked.message)];
  }

  const issues: PatchIssue[] = [];
  const forbidden = forbiddenPathReason(file.path);

  if (forbidden) {
    issues.push(issue("forbidden_path", forbidden));
  }

  const sensitive = role === "source" ? sensitiveCodeReason(file.path) : null;

  if (sensitive) {
    issues.push(issue("sensitive_code", sensitive));
  }

  if (!isCodeFile(file.path)) {
    issues.push(
      issue("unexpected_file_type", "only JavaScript/TypeScript files may be changed")
    );
  }

  if (options.symlinkPaths && underSymlink(file.path, options.symlinkPaths)) {
    issues.push(issue("symlink", "path is, or is inside, a symlink in the snapshot"));
  }

  const isTest = isTestPath(file.path);

  if (role === "source" && isTest) {
    issues.push(
      issue("test_file_in_source_patch", "the source patch may not change test files")
    );
  }

  if (role === "test") {
    if (!isTest) {
      issues.push(
        issue("non_test_file_in_test_patch", "the test patch may only add test files")
      );
    }

    if (file.kind !== "add") {
      issues.push(
        issue("test_modifies_existing_file", "the test patch may only add new files")
      );
    }
  }

  if (options.existingFiles) {
    const exists = options.existingFiles.has(file.path);

    if (file.kind === "add" && exists) {
      issues.push(issue("add_existing_file", "file already exists in the snapshot"));
    }

    if (file.kind === "modify" && !exists) {
      issues.push(issue("modify_missing_file", "file does not exist in the snapshot"));
    }
  }

  return issues;
}

/** Validate one diff in isolation. */
export function validateUnifiedDiff(
  text: unknown,
  role: DiffRole,
  options: ValidateOptions = {}
): DiffValidation {
  const limits = limitsFor(role, options.limits);

  if (typeof text !== "string") {
    return { ok: false, issues: [{ code: "not_text", message: "diff must be a string", role }] };
  }

  const bytes = Buffer.byteLength(text, "utf-8");

  if (bytes > limits.maxBytes) {
    return {
      ok: false,
      issues: [
        { code: "too_large", message: `diff is larger than ${limits.maxBytes} bytes`, role },
      ],
    };
  }

  let files: ParsedFile[];

  try {
    files = parseUnifiedDiff(text, limits);
  } catch (error) {
    if (error instanceof DiffSyntaxError) {
      return { ok: false, issues: [{ code: error.code, message: error.message, role }] };
    }

    throw error;
  }

  const issues: PatchIssue[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const key = file.path.toLowerCase();

    if (seen.has(key)) {
      issues.push({
        code: "duplicate_path",
        message: "path appears more than once (case-insensitively)",
        role,
        path: file.path,
      });
    }

    seen.add(key);
    issues.push(...policyIssues(file, role, options));
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    patch: {
      role,
      files,
      bytes,
      added: files.reduce((sum, file) => sum + file.added, 0),
      removed: files.reduce((sum, file) => sum + file.removed, 0),
    },
  };
}

/** SHA-256 over the exact diff bytes, used to bind a user authorization. */
export function patchDigest(diff: string, testDiff: string): string {
  return crypto
    .createHash("sha256")
    .update(diff)
    .update("\0")
    .update(testDiff)
    .digest("hex");
}

/**
 * Validate a model proposal: one source diff plus one regression-test diff.
 * A regression test is mandatory.
 */
export function validatePatchProposal(
  proposal: { diff: unknown; testDiff: unknown },
  options: ValidateOptions = {}
): ProposalValidation {
  const source = validateUnifiedDiff(proposal.diff, "source", options);
  const test =
    typeof proposal.testDiff === "string" && proposal.testDiff.trim() === ""
      ? ({
          ok: false,
          issues: [
            {
              code: "missing_test_patch",
              message: "a regression test is required",
              role: "test",
            },
          ],
        } satisfies DiffValidation)
      : validateUnifiedDiff(proposal.testDiff, "test", options);

  const issues = [
    ...(source.ok ? [] : source.issues),
    ...(test.ok ? [] : test.issues),
  ];

  if (source.ok && test.ok) {
    const sourcePaths = new Set(source.patch.files.map((file) => file.path.toLowerCase()));

    for (const file of test.patch.files) {
      if (sourcePaths.has(file.path.toLowerCase())) {
        issues.push({
          code: "duplicate_path",
          message: "path appears in both the source and test patch",
          role: "proposal",
          path: file.path,
        });
      }
    }
  }

  if (issues.length > 0 || !source.ok || !test.ok) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    source: source.patch,
    test: test.patch,
    digest: patchDigest(proposal.diff as string, proposal.testDiff as string),
  };
}
