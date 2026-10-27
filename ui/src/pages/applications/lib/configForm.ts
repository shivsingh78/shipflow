// The editable form model for a ShipFlow project configuration. The wizard and
// the "Edit configuration" screen share it, and both validate with the SAME
// validator the server runs (lib/projectConfig), so they never disagree.
import { ProjectConfigError, validateProjectConfig } from "@/lib/projectConfig";
import type { BuildStrategyName, ProjectConfig, ProjectConfigIssue, TargetName } from "@/lib/projectConfig";

export interface EnvRow {
  key: string;
  value: string;
}

export interface ConfigDraft {
  name: string;
  repository: string;
  branch: string;
  deployOnPush: boolean;
  checkPullRequests: boolean;
  deployBranch: string;
  target: TargetName;
  /** "" = detect automatically. */
  strategy: "" | BuildStrategyName;
  dockerfile: string;
  install: "auto" | "none";
  command: string;
  output: string;
  test: string;
  buildEnv: EnvRow[];
  runtimePort: string;
  runtimeStart: string;
  runtimeEnv: EnvRow[];
  /** Secret NAMES (never values), separated by commas, spaces or new lines. */
  runtimeSecrets: string;
  hostname: string;
  ssh: Record<"host" | "port" | "user" | "path" | "hostKey" | "privateKeySecret" | "url", string>;
  docker: Record<"host" | "port" | "user" | "hostKey" | "privateKeySecret" | "publishPort" | "url", string>;
  kubernetes: Record<"kubeconfigSecret" | "namespace" | "registry" | "registryAuthSecret" | "replicas" | "url", string>;
  verifyPath: string;
  expectStatus: string;
}

export const STEPS = ["Repository", "Branch & source", "Deployment method", "Build & runtime", "Review", "Create"] as const;
export type StepNumber = 1 | 2 | 3 | 4 | 5 | 6;

export function emptyDraft(): ConfigDraft {
  return {
    name: "",
    repository: "",
    branch: "main",
    deployOnPush: false,
    checkPullRequests: true,
    deployBranch: "",
    target: "shipflow",
    strategy: "",
    dockerfile: "",
    install: "auto",
    command: "",
    output: "",
    test: "",
    buildEnv: [],
    runtimePort: "",
    runtimeStart: "",
    runtimeEnv: [],
    runtimeSecrets: "",
    hostname: "",
    ssh: { host: "", port: "22", user: "deploy", path: "", hostKey: "", privateKeySecret: "SSH_PRIVATE_KEY", url: "" },
    docker: { host: "", port: "22", user: "deploy", hostKey: "", privateKeySecret: "SSH_PRIVATE_KEY", publishPort: "80", url: "" },
    kubernetes: { kubeconfigSecret: "KUBECONFIG", namespace: "", registry: "", registryAuthSecret: "", replicas: "1", url: "" },
    verifyPath: "/",
    expectStatus: "200",
  };
}

const rows = (record: Record<string, string>): EnvRow[] => Object.entries(record).map(([key, value]) => ({ key, value }));

/** Load a stored configuration into the form. */
export function draftFromConfig(config: ProjectConfig): ConfigDraft {
  const draft = emptyDraft();
  const d = config.deployment;

  draft.name = config.project.name;
  draft.repository = config.project.repository;
  draft.branch = config.project.branch;
  draft.deployOnPush = config.github.deployOnPush;
  draft.checkPullRequests = config.github.checkPullRequests;
  draft.deployBranch = config.github.deployBranch;
  draft.target = d.target;
  draft.strategy = config.build.strategy ?? "";
  draft.dockerfile = config.build.dockerfile ?? "";
  draft.install = config.build.install;
  draft.command = config.build.command === "auto" ? "" : config.build.command;
  draft.output = config.build.output === "auto" ? "" : config.build.output;
  draft.test = config.build.test === "auto" ? "" : config.build.test;
  draft.buildEnv = rows(config.build.env);
  draft.verifyPath = config.verification.path;
  draft.expectStatus = String(config.verification.expectStatus);

  if (config.runtime) {
    draft.runtimePort = String(config.runtime.port);
    draft.runtimeStart = config.runtime.start ?? "";
    draft.runtimeEnv = rows(config.runtime.env);
    draft.runtimeSecrets = config.runtime.secrets.join("\n");
  }

  if (d.target === "shipflow") draft.hostname = d.shipflow.hostname ?? "";
  if (d.target === "ssh") draft.ssh = { ...d.ssh, port: String(d.ssh.port) };
  if (d.target === "docker") draft.docker = { ...d.docker, port: String(d.docker.port), publishPort: String(d.docker.publishPort) };
  if (d.target === "kubernetes") {
    draft.kubernetes = { ...d.kubernetes, registryAuthSecret: d.kubernetes.registryAuthSecret ?? "", replicas: String(d.kubernetes.replicas) };
  }

  return draft;
}

const text = (value: string): string | undefined => (value.trim() === "" ? undefined : value.trim());

/** A number when the text is a number; otherwise the raw text so the validator reports it. */
function numeric(value: string): number | string | undefined {
  const trimmed = value.trim();

  if (trimmed === "") return undefined;

  const parsed = Number(trimmed);

  return Number.isFinite(parsed) ? parsed : trimmed;
}

function compact<T extends Record<string, unknown>>(record: T): Partial<T> {
  return Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export const parseSecretNames = (value: string): string[] => value.split(/[\s,]+/).filter(Boolean);

function envObject(list: EnvRow[]): Record<string, string> {
  const out: Record<string, string> = {};

  for (const row of list) if (row.key.trim() !== "") out[row.key.trim()] = row.value;

  return out;
}

export const isImageTargetName = (target: string): boolean => target === "docker" || target === "kubernetes";

/** The raw object the validator checks. Only the selected target's settings are included. */
export function draftToInput(draft: ConfigDraft): unknown {
  const image = isImageTargetName(draft.target);
  const input: Record<string, unknown> = {
    version: 1,
    project: compact({ name: text(draft.name), repository: text(draft.repository), branch: text(draft.branch) }),
    build: compact({
      install: draft.install,
      command: text(draft.command),
      output: text(draft.output),
      test: text(draft.test),
      env: envObject(draft.buildEnv),
      strategy: draft.strategy === "" ? undefined : draft.strategy,
      dockerfile: draft.strategy === "dockerfile" ? text(draft.dockerfile) : undefined,
    }),
    verification: compact({ path: text(draft.verifyPath), expectStatus: numeric(draft.expectStatus) }),
    github: compact({ checkPullRequests: draft.checkPullRequests, deployOnPush: draft.deployOnPush, deployBranch: text(draft.deployBranch) }),
  };

  if (image) {
    input.runtime = compact({
      port: numeric(draft.runtimePort),
      start: text(draft.runtimeStart),
      env: envObject(draft.runtimeEnv),
      secrets: parseSecretNames(draft.runtimeSecrets),
    });
  }

  const t = draft.target;

  if (t === "shipflow") input.deployment = { target: t, shipflow: compact({ hostname: text(draft.hostname) }) };
  if (t === "ssh") {
    const s = draft.ssh;

    input.deployment = { target: t, ssh: compact({ host: text(s.host), port: numeric(s.port), user: text(s.user), path: text(s.path), hostKey: text(s.hostKey), privateKeySecret: text(s.privateKeySecret), url: text(s.url) }) };
  }
  if (t === "docker") {
    const s = draft.docker;

    input.deployment = { target: t, docker: compact({ host: text(s.host), port: numeric(s.port), user: text(s.user), hostKey: text(s.hostKey), privateKeySecret: text(s.privateKeySecret), publishPort: numeric(s.publishPort), url: text(s.url) }) };
  }
  if (t === "kubernetes") {
    const s = draft.kubernetes;

    input.deployment = {
      target: t,
      kubernetes: compact({ kubeconfigSecret: text(s.kubeconfigSecret), namespace: text(s.namespace), registry: text(s.registry), registryAuthSecret: text(s.registryAuthSecret), replicas: numeric(s.replicas), url: text(s.url) }),
    };
  }

  return input;
}

/** "(root).build.env.X" -> "build.env.X". */
export const normalizePath = (path: string): string => path.replace(/^\(root\)\.?/, "");

export type BuildResult = { ok: true; config: ProjectConfig; issues: [] } | { ok: false; issues: ProjectConfigIssue[] };

export function repoUrlIssue(value: string, allowedPrefixes: readonly string[]): string | null {
  const url = value.trim();

  if (!url) return "is required";

  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return "must be a full http(s) URL such as https://github.com/acme/app";
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "must be an http(s) URL";
  if (parsed.username || parsed.password) return "must not contain credentials (ShipFlow never needs a token in the URL)";

  if (allowedPrefixes.length > 0 && !allowedPrefixes.some((prefix) => url.toLowerCase().startsWith(prefix.toLowerCase()))) {
    return `is not allowed on this server (allowed: ${allowedPrefixes.join(", ")})`;
  }

  return null;
}

/** Validate a draft with the shared validator plus the checks only the form can do. */
export function buildConfig(draft: ConfigDraft, allowedPrefixes: readonly string[] = []): BuildResult {
  const issues: ProjectConfigIssue[] = [];

  const seen = new Set<string>();

  for (const [prefix, list] of [["build.env", draft.buildEnv], ["runtime.env", draft.runtimeEnv]] as const) {
    if (prefix === "runtime.env" && !isImageTargetName(draft.target)) continue;

    for (const row of list) {
      const key = row.key.trim();

      if (key === "" && row.value !== "") issues.push({ path: prefix, message: "a value needs a variable name" });
      else if (key !== "" && seen.has(`${prefix}.${key}`)) issues.push({ path: `${prefix}.${key}`, message: "is defined twice" });

      seen.add(`${prefix}.${key}`);
    }
  }

  try {
    const config = validateProjectConfig(draftToInput(draft));
    const repo = repoUrlIssue(config.project.repository, allowedPrefixes);

    if (repo) issues.push({ path: "project.repository", message: repo });
    if (issues.length === 0) return { ok: true, config, issues: [] };
  } catch (error) {
    if (!(error instanceof ProjectConfigError)) throw error;

    for (const issue of error.errors) issues.push({ path: normalizePath(issue.path), message: issue.message });

    // The validator rejects URLs with credentials already; add the allow-list check for a parseable URL.
    const repo = draft.repository.trim() ? repoUrlIssue(draft.repository, allowedPrefixes) : null;

    if (repo && !issues.some((i) => i.path === "project.repository")) issues.push({ path: "project.repository", message: repo });
  }

  const unique = new Map<string, ProjectConfigIssue>();

  for (const issue of issues) unique.set(`${issue.path}|${issue.message}`, issue);

  return { ok: false, issues: [...unique.values()] };
}

/** Which wizard step owns a configuration path (so errors can send you to the right place). */
export function stepOfPath(path: string): StepNumber {
  const p = normalizePath(path);

  if (p === "project.name" || p === "project.repository" || p === "version" || p === "(root)") return 1;
  if (p === "project.branch" || p.startsWith("github")) return 2;
  if (p === "deployment.target" || p === "build.strategy" || p === "build.dockerfile") return 3;

  return 4;
}

export type FieldErrors = ReadonlyMap<string, string>;

export function errorMap(issues: readonly ProjectConfigIssue[]): FieldErrors {
  const map = new Map<string, string>();

  for (const issue of issues) {
    const path = normalizePath(issue.path);
    const existing = map.get(path);

    map.set(path, existing ? `${existing}; ${issue.message}` : issue.message);
  }

  return map;
}

/** Errors for a step, whether they come from the validator or the server. */
export function issuesForStep(issues: readonly ProjectConfigIssue[], step: StepNumber): ProjectConfigIssue[] {
  return issues.filter((issue) => stepOfPath(issue.path) === step);
}

const FIELD_PATHS: Array<string | RegExp> = [
  "project.name",
  "project.repository",
  "project.branch",
  "github.deployBranch",
  "github.deployOnPush",
  "github.checkPullRequests",
  "deployment.target",
  "build.strategy",
  "build.dockerfile",
  "build.install",
  "build.command",
  "build.output",
  "build.test",
  "build.env",
  "runtime",
  "runtime.port",
  "runtime.start",
  "runtime.env",
  "runtime.secrets",
  "verification.path",
  "verification.expectStatus",
  /^build\.env\./,
  /^runtime\.env\./,
  /^runtime\.secrets\[/,
  /^deployment\.(shipflow|ssh|docker|kubernetes)\.[A-Za-z]+$/,
];

/** True when some form control displays errors for this path inline. */
export const isFieldPath = (path: string): boolean => FIELD_PATHS.some((f) => (typeof f === "string" ? f === path : f.test(path)));

export function setDraftTarget<K extends "ssh" | "docker" | "kubernetes">(draft: ConfigDraft, key: K, field: keyof ConfigDraft[K], value: string): ConfigDraft {
  return { ...draft, [key]: { ...draft[key], [field]: value } };
}

/** Switch deployment method, dropping a build strategy the new method cannot use. */
export function withTarget(draft: ConfigDraft, target: TargetName): ConfigDraft {
  const image = isImageTargetName(target);
  const strategy = image ? (draft.strategy === "static" ? "" : draft.strategy) : draft.strategy === "node" || draft.strategy === "dockerfile" ? "" : draft.strategy;

  return { ...draft, target, strategy };
}
