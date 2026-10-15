// shipflow.yml schema (version 1). Shared by the CLI (before upload) and the
// server (authoritative). Pure JavaScript, no dependencies.
//
// The file must never contain secrets: secret values are stored on the
// server with `shipflow secrets set` and referenced here by name.

export const CONFIG_VERSION = 1;
export const TARGETS = ["shipflow", "ssh"];

export class ProjectConfigError extends Error {
  constructor(errors) {
    super(
      `Invalid ShipFlow configuration:\n${errors
        .map((e) => `  - ${e.path}: ${e.message}`)
        .join("\n")}`
    );
    this.name = "ProjectConfigError";
    this.errors = errors;
    this.statusCode = 400;
  }
}

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;
const RELATIVE_DIR = /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9._/-]{1,200}$/;
const ABSOLUTE_DIR = /^\/(?!.*(^|\/)\.\.?(\/|$))[A-Za-z0-9._/-]{1,250}$/;
const HOSTNAME = /^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;
const SSH_USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const HOST_KEY = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com) [A-Za-z0-9+/]+={0,3}$/;

// Keys that look like they hold a secret value rather than a secret name.
const SECRETISH_KEY = /(password|passwd|secret|token|private_?key|privatekey|api_?key|access_?key)$/i;
const SECRETISH_VALUE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|github_pat_/;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function createContext() {
  const errors = [];

  const error = (path, message) => errors.push({ path, message });

  const object = (value, path, allowed, { required = false } = {}) => {
    if (value === undefined) {
      if (required) error(path, "is required");
      return undefined;
    }

    if (!isObject(value)) {
      error(path, "must be a mapping");
      return undefined;
    }

    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) {
        error(`${path}.${key}`, `unknown field (allowed: ${allowed.join(", ")})`);
      }
    }

    return value;
  };

  const string = (value, path, { pattern, required = false, hint, max = 500 } = {}) => {
    if (value === undefined || value === null || value === "") {
      if (required) error(path, "is required");
      return undefined;
    }

    if (typeof value !== "string") {
      error(path, "must be a string");
      return undefined;
    }

    if (value.length > max) {
      error(path, `must be at most ${max} characters`);
      return undefined;
    }

    if (pattern && !pattern.test(value)) {
      error(path, hint || "has an invalid format");
      return undefined;
    }

    return value;
  };

  return { errors, error, object, string };
}

function scanForSecrets(value, path, error) {
  if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (SECRETISH_KEY.test(key) && !/Secret$/.test(key)) {
        error(
          `${path}.${key}`,
          "looks like a secret; store it with `shipflow secrets set` and reference it by name"
        );
      }
      scanForSecrets(child, `${path}.${key}`, error);
    }
  } else if (Array.isArray(value)) {
    value.forEach((child, i) => scanForSecrets(child, `${path}[${i}]`, error));
  } else if (typeof value === "string" && SECRETISH_VALUE.test(value)) {
    error(path, "contains what looks like a credential; secrets must not be stored in shipflow.yml");
  }
}

function validateUrl(ctx, value, path, required) {
  const text = ctx.string(value, path, { required, max: 500 });

  if (!text) return undefined;

  try {
    const url = new URL(text);

    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
    if (url.username || url.password) {
      ctx.error(path, "must not contain credentials");
      return undefined;
    }

    return url.toString();
  } catch {
    ctx.error(path, "must be an http(s) URL");
    return undefined;
  }
}

/**
 * Validate a parsed configuration object and return a normalized copy with
 * defaults filled in. Throws ProjectConfigError listing every problem.
 */
export function validateProjectConfig(input) {
  const ctx = createContext();
  const { error, object, string } = ctx;

  if (!isObject(input)) {
    throw new ProjectConfigError([{ path: "(root)", message: "must be a mapping" }]);
  }

  scanForSecrets(input, "(root)", error);

  object(input, "(root)", ["version", "project", "build", "deployment", "verification", "github"]);

  if (input.version !== CONFIG_VERSION) {
    error(
      "version",
      input.version === undefined
        ? `is required (current version: ${CONFIG_VERSION})`
        : `unsupported version ${JSON.stringify(input.version)}; this ShipFlow understands version ${CONFIG_VERSION}`
    );
  }

  // ---- project
  const project = object(input.project, "project", ["name", "repository", "branch"], { required: true }) || {};
  const name = string(project.name, "project.name", {
    pattern: NAME,
    required: true,
    hint: "lowercase letters, digits and dashes, up to 63 characters",
  });
  const repository = validateUrl(ctx, project.repository, "project.repository", true);
  const branch = string(project.branch, "project.branch", { pattern: BRANCH, hint: "is not a valid branch name" }) || "main";

  // ---- build
  const build = object(input.build, "build", ["install", "command", "output", "test", "env"]) || {};

  const install = build.install ?? "auto";
  if (!["auto", "none"].includes(install)) error("build.install", 'must be "auto" or "none"');

  const command = string(build.command, "build.command", { max: 1000 }) || "auto";
  const output =
    build.output === undefined || build.output === "auto"
      ? "auto"
      : string(build.output, "build.output", {
          pattern: RELATIVE_DIR,
          hint: "must be a relative directory inside the repository (no '..')",
        });

  const test = string(build.test, "build.test", { max: 1000 }) || "auto";

  const env = {};
  if (build.env !== undefined) {
    if (!isObject(build.env)) {
      error("build.env", "must be a mapping of NAME: value");
    } else {
      for (const [key, value] of Object.entries(build.env)) {
        if (!ENV_NAME.test(key)) error(`build.env.${key}`, "is not a valid environment variable name");
        else if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
          error(`build.env.${key}`, "must be a string, number or boolean");
        } else env[key] = String(value);
      }
    }
  }

  // ---- deployment
  const deployment = object(input.deployment, "deployment", ["target", ...TARGETS], { required: true }) || {};
  const target = string(deployment.target, "deployment.target", { required: true });

  if (target && !TARGETS.includes(target)) {
    error("deployment.target", `unsupported target "${target}" (supported: ${TARGETS.join(", ")})`);
  }

  for (const other of TARGETS) {
    if (other !== target && deployment[other] !== undefined) {
      error(`deployment.${other}`, `settings for "${other}" given but target is "${target}"`);
    }
  }

  const targetConfig = {};

  if (target === "shipflow") {
    const shipflow = object(deployment.shipflow, "deployment.shipflow", ["hostname"]) || {};
    const hostname = string(shipflow.hostname, "deployment.shipflow.hostname", {
      pattern: HOSTNAME,
      hint: "must be a hostname such as site.example.com",
    });
    if (hostname) targetConfig.hostname = hostname.toLowerCase();
  }

  if (target === "ssh") {
    const ssh =
      object(
        deployment.ssh,
        "deployment.ssh",
        ["host", "port", "user", "path", "hostKey", "privateKeySecret", "url"],
        { required: true }
      ) || {};

    const host = string(ssh.host, "deployment.ssh.host", { required: true });
    if (host && !HOSTNAME.test(host) && !IPV4.test(host)) {
      error("deployment.ssh.host", "must be a hostname or IPv4 address");
    } else if (host) targetConfig.host = host;

    const port = ssh.port ?? 22;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      error("deployment.ssh.port", "must be an integer between 1 and 65535");
    } else targetConfig.port = port;

    targetConfig.user = string(ssh.user, "deployment.ssh.user", {
      pattern: SSH_USER,
      required: true,
      hint: "must be a plain Unix user name (use a dedicated deploy user, not root)",
    });
    if (targetConfig.user === "root") {
      error("deployment.ssh.user", "must not be root; create a dedicated deploy user");
    }

    targetConfig.path = string(ssh.path, "deployment.ssh.path", {
      pattern: ABSOLUTE_DIR,
      required: true,
      hint: "must be an absolute directory such as /srv/my-site (letters, digits, . _ - /; no '..')",
    });
    if (targetConfig.path && targetConfig.path.split("/").filter(Boolean).length < 2) {
      error("deployment.ssh.path", "must be at least two levels deep (e.g. /srv/my-site), never / or /srv");
      targetConfig.path = undefined;
    }

    targetConfig.hostKey = string(ssh.hostKey, "deployment.ssh.hostKey", {
      pattern: HOST_KEY,
      required: true,
      max: 2000,
      hint: 'must be the server\'s public host key, e.g. "ssh-ed25519 AAAA..." (from `ssh-keyscan -t ed25519 <host>`)',
    });

    targetConfig.privateKeySecret =
      string(ssh.privateKeySecret, "deployment.ssh.privateKeySecret", {
        pattern: SECRET_NAME,
        hint: "must be an UPPER_CASE secret name",
      }) || "SSH_PRIVATE_KEY";

    targetConfig.url = validateUrl(ctx, ssh.url, "deployment.ssh.url", true);
  }

  // ---- verification
  const verification = object(input.verification, "verification", ["path", "expectStatus"]) || {};
  const verifyPath = string(verification.path, "verification.path", {
    pattern: /^\/[A-Za-z0-9._~\-/?=&%]*$/,
    hint: "must start with /",
  }) || "/";
  const expectStatus = verification.expectStatus ?? 200;
  if (!Number.isInteger(expectStatus) || expectStatus < 200 || expectStatus > 399) {
    error("verification.expectStatus", "must be an HTTP status between 200 and 399");
  }

  // ---- github
  const github = object(input.github, "github", ["checkPullRequests", "deployOnPush", "deployBranch"]) || {};
  for (const key of ["checkPullRequests", "deployOnPush"]) {
    if (github[key] !== undefined && typeof github[key] !== "boolean") {
      error(`github.${key}`, "must be true or false");
    }
  }
  const deployBranch =
    string(github.deployBranch, "github.deployBranch", { pattern: BRANCH, hint: "is not a valid branch name" }) ||
    branch;

  if (ctx.errors.length > 0) {
    throw new ProjectConfigError(ctx.errors);
  }

  return {
    version: CONFIG_VERSION,
    project: { name, repository, branch },
    build: { install, command, output, test, env },
    deployment: { target, [target]: targetConfig },
    verification: { path: verifyPath, expectStatus },
    github: {
      checkPullRequests: github.checkPullRequests ?? true,
      deployOnPush: github.deployOnPush ?? false,
      deployBranch,
    },
  };
}

/**
 * Secret names a configuration needs on the server before it can deploy.
 */
export function requiredSecrets(config) {
  if (config.deployment.target === "ssh") {
    return [config.deployment.ssh.privateKeySecret];
  }

  return [];
}
