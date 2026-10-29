/**
 * Repository path policy for AI-proposed changes.
 *
 * Pure string checks. Paths are untrusted (they come from model output) and
 * must be rejected, never "cleaned up".
 */

export type PathIssueCode =
  | "invalid_path"
  | "absolute_path"
  | "path_traversal";

export type PathCheck =
  | { ok: true; path: string }
  | { ok: false; code: PathIssueCode; message: string };

const MAX_PATH_LENGTH = 300;

function fail(code: PathIssueCode, message: string): PathCheck {
  return { ok: false, code, message };
}

/** Control characters, line/paragraph separators and bidi/zero-width marks. */
function hasUnsafeCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;

    if (
      code < 0x20 ||
      code === 0x7f ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x2028 && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0xfeff
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Check that `value` is a plain, relative, forward-slash path inside the
 * repository: no traversal, no absolute or drive paths, no `.git`, no empty
 * or dot segments, no unusual characters.
 */
export function checkRepoPath(value: unknown): PathCheck {
  if (typeof value !== "string" || value === "") {
    return fail("invalid_path", "path must be a non-empty string");
  }

  if (value.length > MAX_PATH_LENGTH) {
    return fail("invalid_path", "path is too long");
  }

  if (hasUnsafeCharacter(value)) {
    return fail("invalid_path", "path contains control or invisible characters");
  }

  if (value.includes("\\")) {
    return fail("invalid_path", "path must use forward slashes");
  }

  if (value.startsWith('"')) {
    return fail("invalid_path", "quoted paths are not supported");
  }

  if (value.startsWith("/") || value.startsWith("~") || /^[A-Za-z]:/.test(value)) {
    return fail("absolute_path", "absolute paths are not allowed");
  }

  for (const segment of value.split("/")) {
    if (segment === "..") {
      return fail("path_traversal", "path traversal is not allowed");
    }

    if (segment === "." || segment === "") {
      return fail("invalid_path", "path has an empty or dot segment");
    }

    if (segment.toLowerCase() === ".git") {
      return fail("invalid_path", "paths inside .git are not allowed");
    }
  }

  return { ok: true, path: value };
}

// ------------------------------------------------------------- forbidden

/** Directories whose contents RepoPilot must never change. */
const FORBIDDEN_DIRECTORIES: ReadonlySet<string> = new Set([
  ".github",
  ".circleci",
  ".husky",
  ".ssh",
  ".yarn",
  ".pnpm-store",
  "node_modules",
]);

const FORBIDDEN_FILE_NAMES: ReadonlySet<string> = new Set([
  // lockfiles
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  // manifests and package-manager configuration (scripts, registries, hooks)
  "package.json",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pnpmfile.cjs",
  "pnpm-workspace.yaml",
  "bunfig.toml",
  // CI definitions
  "jenkinsfile",
  ".travis.yml",
  "appveyor.yml",
  ".drone.yml",
  "azure-pipelines.yml",
  "bitbucket-pipelines.yml",
  "cloudbuild.yaml",
  "cloudbuild.yml",
  // container builds
  ".dockerignore",
  // environment and secrets
  ".envrc",
]);

const FORBIDDEN_FILE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\.git/, "git metadata"],
  [/^dockerfile(\..+)?$/, "Dockerfile"],
  [/\.dockerfile$/, "Dockerfile"],
  [/^(docker-)?compose(\..+)?\.ya?ml$/, "compose file"],
  [/^docker-compose/, "compose file"],
  [/^\.env(\..+)?$/, "environment file"],
  [/\.env$/, "environment file"],
  [/\.(pem|key|p12|pfx|crt)$/, "key or certificate"],
  [/^id_(rsa|dsa|ecdsa|ed25519)/, "SSH key"],
  // Runner and build configuration can change what a test run measures
  // (excluding tests, loosening assertions), so a patch may not touch it.
  [
    /^(jest|vitest|vite|mocha|ava|babel|playwright|cypress|karma|nyc|c8)\.config\./,
    "test-runner or build configuration",
  ],
  [/^vitest\.workspace\./, "test-runner configuration"],
  [/^\.(mocharc|babelrc|nycrc|c8rc)/, "test-runner configuration"],
];

/**
 * Why a path may not be changed by RepoPilot, or null if it may.
 * `path` must already have passed checkRepoPath.
 */
export function forbiddenPathReason(path: string): string | null {
  const segments = path.toLowerCase().split("/");
  const baseName = segments[segments.length - 1] ?? "";

  for (const directory of segments.slice(0, -1)) {
    if (FORBIDDEN_DIRECTORIES.has(directory)) {
      return `${directory}/ is protected`;
    }
  }

  if (FORBIDDEN_DIRECTORIES.has(baseName)) {
    return `${baseName} is protected`;
  }

  if (FORBIDDEN_FILE_NAMES.has(baseName)) {
    return `${baseName} is protected`;
  }

  for (const [pattern, label] of FORBIDDEN_FILE_PATTERNS) {
    if (pattern.test(baseName)) {
      return `${label} files are protected`;
    }
  }

  return null;
}

// ------------------------------------------------- security-sensitive code

/**
 * Words that mark security-critical code. A source patch may not touch a
 * path with any of these as a whole word (split on - _ . and /), so an AI
 * model never edits authentication, authorisation, secret handling, crypto,
 * sandboxing or RepoPilot itself. Blocking is deliberately blunt: a human
 * must write these changes.
 */
const SENSITIVE_WORDS: ReadonlySet<string> = new Set([
  "auth", "authn", "authz", "authentication", "authorization", "authorisation", "oauth", "oidc", "saml", "sso",
  "login", "logout", "signin", "signup", "session", "sessions", "jwt", "token", "tokens", "csrf",
  "permission", "permissions", "acl", "rbac", "iam", "policy", "policies",
  "secret", "secrets", "credential", "credentials", "password", "passwords", "passwd", "keystore", "vault",
  "crypto", "cryptography", "encrypt", "decrypt", "encryption", "signature", "signing",
  "sandbox", "sandboxes", "isolation", "egress", "repopilot",
]);

/** Why a SOURCE patch may not change this path, or null if it may. */
export function sensitiveCodeReason(path: string): string | null {
  for (const segment of path.toLowerCase().split("/")) {
    const stem = segment.replace(/\.[a-z0-9]+$/, "");

    for (const word of stem.split(/[-_.]+/)) {
      if (SENSITIVE_WORDS.has(word)) {
        return `"${word}" marks security-sensitive code that needs a human author`;
      }
    }
  }

  return null;
}

// --------------------------------------------------------------- file kind

const CODE_EXTENSION = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const TEST_FILE_NAME = /\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/i;
const TEST_DIRECTORIES: ReadonlySet<string> = new Set([
  "test",
  "tests",
  "__tests__",
  "spec",
  "specs",
]);

/** JavaScript/TypeScript source or test files: the only types a patch may touch. */
export function isCodeFile(path: string): boolean {
  return CODE_EXTENSION.test(path);
}

export function isTestPath(path: string): boolean {
  const segments = path.toLowerCase().split("/");

  return (
    segments.slice(0, -1).some((segment) => TEST_DIRECTORIES.has(segment)) ||
    TEST_FILE_NAME.test(path)
  );
}
