// shipflow.yml schema (version 1). Shared by the CLI (before upload) and the
// server (authoritative). Pure JavaScript, no dependencies.
//
// The file must never contain secrets: secret values are stored on the
// server with `shipflow secrets set` and referenced here by name.

export const CONFIG_VERSION = 1;
export const TARGETS: string[] = ["shipflow", "ssh", "docker", "kubernetes"];

export type TargetName = "shipflow" | "ssh" | "docker" | "kubernetes";

/** Targets that run container images (the others serve static files). */
export const IMAGE_TARGETS: string[] = ["docker", "kubernetes"];

export const BUILD_STRATEGIES: string[] = ["static", "node", "dockerfile"];

export type BuildStrategyName = "static" | "node" | "dockerfile";

export interface ProjectConfigIssue {
  path: string;
  message: string;
}

export interface ShipflowTarget {
  hostname?: string;
}

export interface SshTarget {
  host: string;
  port: number;
  user: string;
  path: string;
  hostKey: string;
  privateKeySecret: string;
  url: string;
}

/** Docker host reached over SSH, running the release as a container behind a managed proxy. */
export interface DockerTarget {
  host: string;
  port: number;
  user: string;
  hostKey: string;
  privateKeySecret: string;
  /** Host port the managed proxy publishes. */
  publishPort: number;
  /** Public URL of the application (used for the live check). */
  url: string;
}

/** Kubernetes / K3s cluster; images are pushed to `registry` and referenced by digest. */
export interface KubernetesTarget {
  kubeconfigSecret: string;
  namespace: string;
  /** Registry repository prefix, e.g. registry.example.com/team (no scheme). */
  registry: string;
  /** Optional secret holding a Docker config.json for pushing to / pulling from the registry. */
  registryAuthSecret?: string;
  replicas: number;
  /** Public URL of the application (used for the live check). */
  url: string;
}

export type DeploymentConfig =
  | { target: "shipflow"; shipflow: ShipflowTarget }
  | { target: "ssh"; ssh: SshTarget }
  | { target: "docker"; docker: DockerTarget }
  | { target: "kubernetes"; kubernetes: KubernetesTarget };

export interface BuildConfig {
  install: "auto" | "none";
  command: string;
  output: string;
  test: string;
  env: Record<string, string>;
  /** Omitted = detect automatically (see src/strategies). */
  strategy?: BuildStrategyName;
  /** Dockerfile path relative to the repository (dockerfile strategy). */
  dockerfile?: string;
}

/** How a container image runs. Only valid for image targets. */
export interface RuntimeConfig {
  port: number;
  /** Start command for the node strategy (default: the package.json "start" script). */
  start?: string;
  /** Public, non-secret environment values. */
  env: Record<string, string>;
  /** Names of ShipFlow project secrets injected as environment variables at run time. */
  secrets: string[];
}

/** A configuration returned by validateProjectConfig (normalized, defaults filled in). */
export interface ProjectConfig {
  version: number;
  project: { name: string; repository: string; branch: string };
  build: BuildConfig;
  runtime?: RuntimeConfig;
  deployment: DeploymentConfig;
  verification: { path: string; expectStatus: number };
  github: {
    checkPullRequests: boolean;
    deployOnPush: boolean;
    deployBranch: string;
  };
}

export type ValidatedConfig = ProjectConfig;

type Fail = (path: string, message: string) => void;

interface StringOptions {
  pattern?: RegExp;
  required?: boolean;
  hint?: string;
  max?: number;
}

export class ProjectConfigError extends Error {
  errors: ProjectConfigIssue[];
  statusCode: number;

  constructor(errors: ProjectConfigIssue[]) {
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
const K8S_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const REGISTRY = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:\d{1,5})?(\/[a-z0-9]+([._-][a-z0-9]+)*)*$/;
const HOST_KEY = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com) [A-Za-z0-9+/]+={0,3}$/;

// Keys that look like they hold a secret value rather than a secret name.
const SECRETISH_KEY = /(password|passwd|secret|token|private_?key|privatekey|api_?key|access_?key)$/i;
const SECRETISH_VALUE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|github_pat_/;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type ValidationContext = ReturnType<typeof createContext>;

function createContext() {
  const errors: ProjectConfigIssue[] = [];

  const error: Fail = (path, message) => {
    errors.push({ path, message });
  };

  const object = (
    value: unknown,
    path: string,
    allowed: string[],
    { required = false }: { required?: boolean } = {}
  ): Record<string, unknown> | undefined => {
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

  const string = (
    value: unknown,
    path: string,
    { pattern, required = false, hint, max = 500 }: StringOptions = {}
  ): string | undefined => {
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

function scanForSecrets(value: unknown, path: string, error: Fail): void {
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

function validateUrl(
  ctx: ValidationContext,
  value: unknown,
  path: string,
  required: boolean
): string | undefined {
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
export function validateProjectConfig(input: unknown): ProjectConfig {
  const ctx = createContext();
  const { error, object, string } = ctx;

  if (!isObject(input)) {
    throw new ProjectConfigError([{ path: "(root)", message: "must be a mapping" }]);
  }

  scanForSecrets(input, "(root)", error);

  object(input, "(root)", ["version", "project", "build", "runtime", "deployment", "verification", "github"]);

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
  const build = object(input.build, "build", ["install", "command", "output", "test", "env", "strategy", "dockerfile"]) || {};

  const install = build.install ?? "auto";
  if (typeof install !== "string" || !["auto", "none"].includes(install)) error("build.install", 'must be "auto" or "none"');

  const command = string(build.command, "build.command", { max: 1000 }) || "auto";
  const output =
    build.output === undefined || build.output === "auto"
      ? "auto"
      : string(build.output, "build.output", {
          pattern: RELATIVE_DIR,
          hint: "must be a relative directory inside the repository (no '..')",
        });

  const test = string(build.test, "build.test", { max: 1000 }) || "auto";

  const strategy = string(build.strategy, "build.strategy");
  if (strategy && !BUILD_STRATEGIES.includes(strategy)) {
    error("build.strategy", `must be one of: ${BUILD_STRATEGIES.join(", ")} (omit to detect automatically)`);
  }

  const dockerfile = string(build.dockerfile, "build.dockerfile", {
    pattern: RELATIVE_DIR,
    hint: "must be a relative file path inside the repository (no '..')",
  });
  if (dockerfile && strategy !== undefined && strategy !== "dockerfile") {
    error("build.dockerfile", 'only applies to build.strategy "dockerfile"');
  }

  const env: Record<string, string> = {};
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

  const targetConfig: Partial<SshTarget & DockerTarget & KubernetesTarget> & ShipflowTarget = {};

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
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
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

  if (target === "docker") {
    const docker =
      object(
        deployment.docker,
        "deployment.docker",
        ["host", "port", "user", "hostKey", "privateKeySecret", "publishPort", "url"],
        { required: true }
      ) || {};

    const host = string(docker.host, "deployment.docker.host", { required: true });
    if (host && !HOSTNAME.test(host) && !IPV4.test(host)) {
      error("deployment.docker.host", "must be a hostname or IPv4 address");
    } else if (host) targetConfig.host = host;

    const port = docker.port ?? 22;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
      error("deployment.docker.port", "must be an integer between 1 and 65535");
    } else targetConfig.port = port;

    targetConfig.user = string(docker.user, "deployment.docker.user", {
      pattern: SSH_USER,
      required: true,
      hint: "must be a plain Unix user name (a dedicated user in the docker group, not root)",
    });
    if (targetConfig.user === "root") {
      error("deployment.docker.user", "must not be root; use a dedicated user that can run docker");
    }

    targetConfig.hostKey = string(docker.hostKey, "deployment.docker.hostKey", {
      pattern: HOST_KEY,
      required: true,
      max: 2000,
      hint: 'must be the server\'s public host key, e.g. "ssh-ed25519 AAAA..." (from `ssh-keyscan -t ed25519 <host>`)',
    });

    targetConfig.privateKeySecret =
      string(docker.privateKeySecret, "deployment.docker.privateKeySecret", {
        pattern: SECRET_NAME,
        hint: "must be an UPPER_CASE secret name",
      }) || "SSH_PRIVATE_KEY";

    const publishPort = docker.publishPort ?? 80;
    if (typeof publishPort !== "number" || !Number.isInteger(publishPort) || publishPort < 1 || publishPort > 65535) {
      error("deployment.docker.publishPort", "must be an integer between 1 and 65535");
    } else targetConfig.publishPort = publishPort;

    targetConfig.url = validateUrl(ctx, docker.url, "deployment.docker.url", true);
  }

  if (target === "kubernetes") {
    const k8s =
      object(
        deployment.kubernetes,
        "deployment.kubernetes",
        ["kubeconfigSecret", "namespace", "registry", "registryAuthSecret", "replicas", "url"],
        { required: true }
      ) || {};

    targetConfig.kubeconfigSecret =
      string(k8s.kubeconfigSecret, "deployment.kubernetes.kubeconfigSecret", {
        pattern: SECRET_NAME,
        hint: "must be an UPPER_CASE secret name",
      }) || "KUBECONFIG";

    targetConfig.namespace = string(k8s.namespace, "deployment.kubernetes.namespace", {
      pattern: K8S_NAME,
      required: true,
      hint: "must be a Kubernetes namespace name (lowercase letters, digits, dashes)",
    });

    targetConfig.registry = string(k8s.registry, "deployment.kubernetes.registry", {
      pattern: REGISTRY,
      required: true,
      hint: "must be a registry repository prefix such as registry.example.com/team (no scheme, no tag)",
    });

    const registryAuthSecret = string(k8s.registryAuthSecret, "deployment.kubernetes.registryAuthSecret", {
      pattern: SECRET_NAME,
      hint: "must be an UPPER_CASE secret name",
    });
    if (registryAuthSecret) targetConfig.registryAuthSecret = registryAuthSecret;

    const replicas = k8s.replicas ?? 1;
    if (typeof replicas !== "number" || !Number.isInteger(replicas) || replicas < 1 || replicas > 20) {
      error("deployment.kubernetes.replicas", "must be an integer between 1 and 20");
    } else targetConfig.replicas = replicas;

    targetConfig.url = validateUrl(ctx, k8s.url, "deployment.kubernetes.url", true);

    // Kubernetes object names are derived from the project name (63-character limit).
    if (name && name.length > 35) {
      error("project.name", "must be at most 35 characters for the kubernetes target (object names are derived from it)");
    }
  }

  // ---- runtime (image targets only)
  const imageTarget = target !== undefined && IMAGE_TARGETS.includes(target);
  const runtimeInput = object(input.runtime, "runtime", ["port", "start", "env", "secrets"]);
  let runtime: RuntimeConfig | undefined;

  if (imageTarget && strategy === "static") {
    error("build.strategy", `"static" produces files, but target "${target}" runs container images`);
  }

  if (!imageTarget) {
    if (runtimeInput !== undefined) {
      error("runtime", `only applies to image targets (${IMAGE_TARGETS.join(", ")}), not "${target}"`);
    }
    if (strategy === "node" || strategy === "dockerfile") {
      error("build.strategy", `"${strategy}" produces a container image; target "${target}" serves static files`);
    }
  } else {
    const rt = runtimeInput ?? {};
    if (runtimeInput === undefined) error("runtime", `is required for target "${target}" (at least runtime.port)`);

    const port = rt.port;
    let validPort: number | undefined;
    if (port === undefined) {
      if (runtimeInput !== undefined) error("runtime.port", "is required");
    } else if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
      error("runtime.port", "must be an integer between 1 and 65535");
    } else validPort = port;

    const start = string(rt.start, "runtime.start", { max: 1000 });

    const runtimeEnv: Record<string, string> = {};
    if (rt.env !== undefined) {
      if (!isObject(rt.env)) {
        error("runtime.env", "must be a mapping of NAME: value");
      } else {
        for (const [key, value] of Object.entries(rt.env)) {
          if (!ENV_NAME.test(key)) error(`runtime.env.${key}`, "is not a valid environment variable name");
          else if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
            error(`runtime.env.${key}`, "must be a string, number or boolean");
          } else runtimeEnv[key] = String(value);
        }
      }
    }

    const runtimeSecrets: string[] = [];
    if (rt.secrets !== undefined) {
      if (!Array.isArray(rt.secrets)) {
        error("runtime.secrets", "must be a list of UPPER_CASE secret names");
      } else {
        rt.secrets.forEach((name: unknown, i: number) => {
          if (typeof name !== "string" || !SECRET_NAME.test(name)) {
            error(`runtime.secrets[${i}]`, "must be an UPPER_CASE secret name");
          } else if (!runtimeSecrets.includes(name)) runtimeSecrets.push(name);
        });
      }
    }

    if (validPort !== undefined) {
      runtime = { port: validPort, env: runtimeEnv, secrets: runtimeSecrets };
      if (start) runtime.start = start;
    }
  }

  // ---- verification
  const verification = object(input.verification, "verification", ["path", "expectStatus"]) || {};
  const verifyPath = string(verification.path, "verification.path", {
    pattern: /^\/[A-Za-z0-9._~\-/?=&%]*$/,
    hint: "must start with /",
  }) || "/";
  const expectStatus = verification.expectStatus ?? 200;
  if (typeof expectStatus !== "number" || !Number.isInteger(expectStatus) || expectStatus < 200 || expectStatus > 399) {
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

  // No errors were recorded, so every required field above is present and valid.
  return {
    version: CONFIG_VERSION,
    project: { name, repository, branch },
    build: {
      install,
      command,
      output,
      test,
      env,
      ...(strategy ? { strategy } : {}),
      ...(dockerfile ? { dockerfile } : {}),
    },
    ...(runtime ? { runtime } : {}),
    deployment: { target, [String(target)]: targetConfig },
    verification: { path: verifyPath, expectStatus },
    github: {
      checkPullRequests: github.checkPullRequests ?? true,
      deployOnPush: github.deployOnPush ?? false,
      deployBranch,
    },
  } as ProjectConfig;
}

/**
 * Secret names a configuration needs on the server before it can deploy.
 */
export function requiredSecrets(config: ProjectConfig): string[] {
  const names: string[] = [];
  const { deployment } = config;

  if (deployment.target === "ssh") {
    names.push(deployment.ssh.privateKeySecret);
  } else if (deployment.target === "docker") {
    names.push(deployment.docker.privateKeySecret);
  } else if (deployment.target === "kubernetes") {
    names.push(deployment.kubernetes.kubeconfigSecret);
    if (deployment.kubernetes.registryAuthSecret) names.push(deployment.kubernetes.registryAuthSecret);
  }

  for (const name of config.runtime?.secrets ?? []) {
    if (!names.includes(name)) names.push(name);
  }

  return names;
}
