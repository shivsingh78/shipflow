/**
 * Deterministic repository manifest and context selection.
 *
 * Built from a git tree listing (names, sizes, object ids) plus the root
 * package.json. No repository code is executed and no file is read from disk;
 * the same tree always yields byte-identical output (sorted, no timestamps).
 */

import { z } from "zod";

import { checkRepoPath, isCodeFile, isTestPath } from "./paths.js";

export type SkipReason =
  | "unsafe_path"
  | "symlink"
  | "submodule"
  | "excluded_directory"
  | "sensitive_file"
  | "binary"
  | "lockfile"
  | "generated"
  | "too_large"
  | "too_many_files";

export type FileKind = "source" | "test" | "config" | "doc" | "other";

export interface ManifestFile {
  path: string;
  size: number;
  blobSha: string;
  kind: FileKind;
}

export type UnverifiableReason =
  | "no_package_json"
  | "invalid_package_json"
  | "no_test_script"
  | "placeholder_test_script"
  | "unsupported_package_manager"
  | "no_lockfile"
  | "monorepo_unsupported";

export interface PackageInfo {
  name: string | null;
  type: string | null;
  /** Detected from lockfiles and the packageManager field. */
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | "ambiguous" | "none";
  testScript: string | null;
  hasWorkspaces: boolean;
  entryPoints: string[];
}

export interface Manifest {
  version: 1;
  repo: { owner: string; name: string };
  commitSha: string;
  defaultBranch: string;
  package: PackageInfo | null;
  verifiable: { ok: true } | { ok: false; reason: UnverifiableReason; detail: string };
  files: ManifestFile[];
  skipped: { total: number; byReason: Partial<Record<SkipReason, number>>; samples: Array<{ path: string; reason: SkipReason }> };
  totals: { treeEntries: number; files: number; bytes: number };
  /** Paths in the snapshot that are symlinks, so patches can refuse them. */
  symlinkPaths: string[];
}

export interface TreeItem {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number | undefined;
}

export interface ManifestLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

const EXCLUDED_DIRECTORIES = new Set([
  ".git", "node_modules", "dist", "build", "out", "coverage", ".next", ".nuxt", ".svelte-kit", ".turbo", ".cache",
  "vendor", "bower_components", ".yarn", ".pnpm-store", ".idea", ".vscode", "__pycache__", "storybook-static",
]);

const SENSITIVE_NAME = [
  /^\.env(\..+)?$/i, /\.env$/i, /^\.npmrc$/i, /^\.netrc$/i, /^\.pypirc$/i, /^\.htpasswd$/i,
  /\.(pem|key|p12|pfx|jks|keystore|crt|cer)$/i, /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^(credentials?|secrets?)(\..+)?$/i, /^service-?account.*\.json$/i, /^\.aws$/i,
];

const LOCKFILES = new Set(["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock"]);

const BINARY_EXTENSION = /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|svgz|pdf|zip|gz|tgz|tar|bz2|xz|7z|rar|jar|war|class|so|dll|dylib|exe|bin|wasm|woff2?|ttf|otf|eot|mp[34]|mov|avi|webm|ogg|wav|flac|sqlite3?|db|pyc|o|a|node)$/i;
const GENERATED = /(\.min\.(js|css)|\.map|\.bundle\.js|\.d\.ts\.map)$/i;

function classify(path: string): FileKind {
  if (isCodeFile(path)) {
    return isTestPath(path) ? "test" : "source";
  }

  if (/\.(md|mdx|markdown|txt|rst)$/i.test(path)) return "doc";
  if (/(^|\/)(tsconfig[^/]*\.json|\.eslintrc[^/]*|eslint\.config\.[cm]?js|\.prettierrc[^/]*|jest\.config\.[^/]+|vitest\.config\.[^/]+|package\.json)$/i.test(path)) return "config";

  return "other";
}

function skipReasonFor(entry: TreeItem, limits: ManifestLimits): SkipReason | null {
  if (entry.type === "commit" || entry.mode === "160000") return "submodule";
  if (entry.mode === "120000") return "symlink";
  if (!checkRepoPath(entry.path).ok) return "unsafe_path";

  const segments = entry.path.split("/");
  const name = segments[segments.length - 1] ?? "";

  if (segments.slice(0, -1).some((segment) => EXCLUDED_DIRECTORIES.has(segment.toLowerCase()))) return "excluded_directory";
  if (SENSITIVE_NAME.some((pattern) => pattern.test(name))) return "sensitive_file";
  if (LOCKFILES.has(name)) return "lockfile";
  if (BINARY_EXTENSION.test(name)) return "binary";
  if (GENERATED.test(name)) return "generated";
  if ((entry.size ?? 0) > limits.maxFileBytes) return "too_large";

  return null;
}

// ------------------------------------------------------------------ package

const PackageJsonSchema = z.looseObject({
  name: z.string().optional(),
  type: z.string().optional(),
  packageManager: z.string().optional(),
  scripts: z.record(z.string(), z.unknown()).optional(),
  workspaces: z.unknown().optional(),
  main: z.string().optional(),
  bin: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
});

/** npm's default placeholder for `scripts.test`. */
const PLACEHOLDER_TEST = /no test specified/i;

function detectPackageManager(names: ReadonlySet<string>, declared: string | undefined): PackageInfo["packageManager"] {
  const fromLock = new Set<string>();

  if (names.has("package-lock.json") || names.has("npm-shrinkwrap.json")) fromLock.add("npm");
  if (names.has("pnpm-lock.yaml")) fromLock.add("pnpm");
  if (names.has("yarn.lock")) fromLock.add("yarn");
  if (names.has("bun.lockb") || names.has("bun.lock")) fromLock.add("bun");

  const declaredName = declared?.split("@")[0];

  if (declaredName && ["npm", "pnpm", "yarn", "bun"].includes(declaredName)) {
    fromLock.add(declaredName);
  }

  if (fromLock.size === 0) return "none";
  if (fromLock.size > 1) return "ambiguous";

  return [...fromLock][0] as PackageInfo["packageManager"];
}

function entryPointsOf(pkg: z.infer<typeof PackageJsonSchema>): string[] {
  const out: string[] = [];

  if (pkg.main) out.push(pkg.main);
  if (typeof pkg.bin === "string") out.push(pkg.bin);
  else if (pkg.bin) out.push(...Object.values(pkg.bin));

  return out.map((p) => p.replace(/^\.\//, "")).filter((p) => checkRepoPath(p).ok).slice(0, 10);
}

/** Parse package.json text. Returns null info plus the reason when unusable. */
export function readPackageInfo(
  packageJson: string | null,
  rootNames: ReadonlySet<string>
): { info: PackageInfo | null; verifiable: Manifest["verifiable"] } {
  if (packageJson === null) {
    return { info: null, verifiable: { ok: false, reason: "no_package_json", detail: "No package.json at the repository root." } };
  }

  let parsed: z.infer<typeof PackageJsonSchema>;

  try {
    parsed = PackageJsonSchema.parse(JSON.parse(packageJson));
  } catch {
    return { info: null, verifiable: { ok: false, reason: "invalid_package_json", detail: "The root package.json is not valid." } };
  }

  const rawTest = parsed.scripts?.test;
  const testScript = typeof rawTest === "string" ? rawTest.slice(0, 300) : null;
  const info: PackageInfo = {
    name: parsed.name?.slice(0, 214) ?? null,
    type: parsed.type ?? null,
    packageManager: detectPackageManager(rootNames, parsed.packageManager),
    testScript,
    hasWorkspaces: parsed.workspaces !== undefined && parsed.workspaces !== null,
    entryPoints: entryPointsOf(parsed),
  };

  const no = (reason: UnverifiableReason, detail: string): { info: PackageInfo; verifiable: Manifest["verifiable"] } => ({ info, verifiable: { ok: false, reason, detail } });

  if (info.hasWorkspaces) return no("monorepo_unsupported", "Workspaces/monorepos are not supported yet.");
  if (testScript === null) return no("no_test_script", "package.json has no scripts.test.");
  if (PLACEHOLDER_TEST.test(testScript)) return no("placeholder_test_script", "scripts.test is npm's default placeholder.");
  if (info.packageManager === "none") return no("no_lockfile", "No lockfile was found; installs would not be reproducible.");
  if (info.packageManager !== "npm") return no("unsupported_package_manager", `Only npm projects are supported for verification (found: ${info.packageManager}).`);

  return { info, verifiable: { ok: true } };
}

// ---------------------------------------------------------------- manifest

export interface BuildManifestInput {
  repo: { owner: string; name: string };
  commitSha: string;
  defaultBranch: string;
  entries: readonly TreeItem[];
  packageJson: string | null;
  limits: ManifestLimits;
}

const SKIP_SAMPLES = 50;

export function buildManifest(input: BuildManifestInput): Manifest {
  const byReason: Partial<Record<SkipReason, number>> = {};
  const samples: Array<{ path: string; reason: SkipReason }> = [];
  const symlinkPaths: string[] = [];
  const kept: ManifestFile[] = [];
  const rootNames = new Set<string>();
  let bytes = 0;
  let skippedTotal = 0;

  const skip = (path: string, reason: SkipReason): void => {
    skippedTotal += 1;
    byReason[reason] = (byReason[reason] ?? 0) + 1;

    if (samples.length < SKIP_SAMPLES) {
      samples.push({ path: path.slice(0, 300), reason });
    }
  };

  const blobs = input.entries.filter((entry) => entry.type !== "tree").sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  for (const entry of blobs) {
    if (!entry.path.includes("/")) {
      rootNames.add(entry.path);
    }

    if (entry.mode === "120000") {
      symlinkPaths.push(entry.path);
    }

    const reason = skipReasonFor(entry, input.limits);

    if (reason) {
      skip(entry.path, reason);
      continue;
    }

    const size = entry.size ?? 0;

    if (kept.length >= input.limits.maxFiles || bytes + size > input.limits.maxTotalBytes) {
      skip(entry.path, "too_many_files");
      continue;
    }

    bytes += size;
    kept.push({ path: entry.path, size, blobSha: entry.sha, kind: classify(entry.path) });
  }

  const { info, verifiable } = readPackageInfo(input.packageJson, rootNames);

  return {
    version: 1,
    repo: input.repo,
    commitSha: input.commitSha,
    defaultBranch: input.defaultBranch,
    package: info,
    verifiable,
    files: kept,
    skipped: { total: skippedTotal, byReason, samples },
    totals: { treeEntries: input.entries.length, files: kept.length, bytes },
    symlinkPaths,
  };
}

// ---------------------------------------------------------------- selection

/** Rough, deliberately conservative token estimate for source code. */
export function estimateTokens(bytes: number): number {
  return Math.ceil(bytes / 3.5);
}

const ENTRY_NAME = /^(index|main|app|server|cli|bin|handler|router|routes)\.[cm]?[jt]sx?$/i;

function score(file: ManifestFile, entryPoints: ReadonlySet<string>): number {
  const segments = file.path.split("/");
  const name = segments[segments.length - 1] ?? "";
  let value = 0;

  if (entryPoints.has(file.path)) value += 100;
  if (ENTRY_NAME.test(name)) value += 40;
  value += Math.max(0, 30 - (segments.length - 1) * 6);
  if (/^(src|lib|app|server)\//.test(file.path)) value += 15;
  if (file.size < 16 * 1024) value += 10;
  if (file.size < 600) value -= 10; // trivial files carry little signal

  return value;
}

export interface ContextSelection {
  files: ManifestFile[];
  /** Existing tests to show as conventions for the regression test. */
  testSamples: ManifestFile[];
  estimatedTokens: number;
  omitted: number;
}

/**
 * Choose which files go into the model prompt within a token budget.
 * Deterministic: score, then path. Secrets-like files were already excluded
 * by the manifest; content is scrubbed again before it reaches a prompt.
 */
export function selectContext(manifest: Manifest, { budgetTokens, maxFiles = 60 }: { budgetTokens: number; maxFiles?: number }): ContextSelection {
  const entryPoints = new Set(manifest.package?.entryPoints ?? []);
  const sources = manifest.files.filter((file) => file.kind === "source");
  const ranked = [...sources].sort((a, b) => score(b, entryPoints) - score(a, entryPoints) || (a.path < b.path ? -1 : 1));
  const chosen: ManifestFile[] = [];
  let tokens = 0;

  for (const file of ranked) {
    const cost = estimateTokens(file.size);

    if (chosen.length >= maxFiles || tokens + cost > budgetTokens) {
      continue;
    }

    chosen.push(file);
    tokens += cost;
  }

  const testSamples = manifest.files
    .filter((file) => file.kind === "test" && file.size < 8 * 1024)
    .sort((a, b) => a.size - b.size || (a.path < b.path ? -1 : 1))
    .filter((file) => tokens + estimateTokens(file.size) <= budgetTokens)
    .slice(0, 2);

  tokens += testSamples.reduce((sum, file) => sum + estimateTokens(file.size), 0);

  return {
    files: chosen.sort((a, b) => (a.path < b.path ? -1 : 1)),
    testSamples,
    estimatedTokens: tokens,
    omitted: sources.length - chosen.length,
  };
}
