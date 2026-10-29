// DEMO MODE ONLY. In-memory sample data with the same interface as the real
// API client, used to explore the dashboard without a ShipFlow server. It is
// reachable only through the explicit "Explore with sample data" entry (or
// ?demo=1), shows a permanent banner, and never mixes with live responses.
// Nothing here talks to a server, deploys anything or stores credentials.
import { requiredSecrets } from "@/lib/projectConfig";
import { createDemoRepoPilot } from "./demoRepopilot";
import type { ProjectConfig } from "@/lib/projectConfig";
import { ApiError } from "./errors";
import type { ApiClient } from "./client";
import type {
  CancelResult,
  Evidence,
  ListReleasesOptions,
  Project,
  ProjectDetail,
  ProjectSummary,
  Release,
  ReleaseLogRow,
  ReleaseLogs,
  ReleaseStage,
  ReleaseStatus,
  RollbackResult,
  SecretInfo,
  WhoAmI,
} from "./types";

const MIN = 60_000;
const HOUR = 60 * MIN;

const iso = (ms: number) => new Date(ms).toISOString();
const sha = (seed: string) => {
  let h = 2166136261;
  const out: string[] = [];

  for (let i = 0; i < 40; i += 1) {
    h = Math.imul(h ^ (seed.charCodeAt(i % seed.length) + i), 16777619) >>> 0;
    out.push((h & 15).toString(16));
  }

  return out.join("");
};
const digest = (seed: string) => `sha256:${(sha(seed) + sha(`${seed}!`)).slice(0, 64)}`;

const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
const BASE_BUILD = { install: "auto", command: "auto", output: "auto", test: "auto", env: {} } as const;
const GITHUB = { checkPullRequests: true, deployOnPush: true, deployBranch: "main" };
const VERIFY = { path: "/", expectStatus: 200 };

function config(partial: Partial<ProjectConfig> & Pick<ProjectConfig, "project" | "deployment">): ProjectConfig {
  return { version: 1, build: { ...BASE_BUILD }, verification: VERIFY, github: GITHUB, ...partial };
}

const NOW = Date.now();

const PROJECT_CONFIGS: ProjectConfig[] = [
  config({
    project: { name: "marketing-site", repository: "https://github.com/acme/marketing-site", branch: "main" },
    build: { ...BASE_BUILD, env: { VITE_API_URL: "https://api.acme.dev" } },
    deployment: { target: "shipflow", shipflow: { hostname: "www.acme.dev" } },
  }),
  config({
    project: { name: "docs-portal", repository: "https://github.com/acme/docs-portal", branch: "main" },
    deployment: {
      target: "ssh",
      ssh: { host: "vps.acme.dev", port: 22, user: "deploy", path: "/srv/docs", hostKey: HOST_KEY, privateKeySecret: "SSH_PRIVATE_KEY", url: "https://docs.acme.dev/" },
    },
  }),
  config({
    project: { name: "orders-api", repository: "https://github.com/acme/orders-api", branch: "main" },
    build: { ...BASE_BUILD, strategy: "node" },
    runtime: { port: 3000, env: { LOG_LEVEL: "info" }, secrets: ["DATABASE_URL"] },
    verification: { path: "/healthz", expectStatus: 200 },
    deployment: {
      target: "docker",
      docker: { host: "docker1.acme.dev", port: 22, user: "deploy", hostKey: HOST_KEY, privateKeySecret: "SSH_PRIVATE_KEY", publishPort: 80, url: "https://orders.acme.dev/" },
    },
  }),
  config({
    project: { name: "worker-app", repository: "https://github.com/acme/worker-app", branch: "main" },
    build: { ...BASE_BUILD, strategy: "dockerfile", dockerfile: "Dockerfile" },
    runtime: { port: 8080, env: {}, secrets: [] },
    deployment: {
      target: "docker",
      docker: { host: "docker1.acme.dev", port: 22, user: "deploy", hostKey: HOST_KEY, privateKeySecret: "SSH_PRIVATE_KEY", publishPort: 8081, url: "https://worker.acme.dev/" },
    },
  }),
  config({
    project: { name: "billing-service", repository: "https://github.com/acme/billing-service", branch: "main" },
    build: { ...BASE_BUILD, strategy: "dockerfile", dockerfile: "Dockerfile" },
    runtime: { port: 8080, env: { REGION: "eu-west-1" }, secrets: ["STRIPE_KEY"] },
    verification: { path: "/healthz", expectStatus: 200 },
    deployment: {
      target: "kubernetes",
      kubernetes: { kubeconfigSecret: "KUBECONFIG", namespace: "billing", registry: "registry.acme.dev/team", registryAuthSecret: "REGISTRY_AUTH", replicas: 2, url: "https://billing.acme.dev/" },
    },
  }),
];

interface Row {
  id: string;
  project: string;
  status: ReleaseStatus;
  stage: ReleaseStage;
  minutesAgo: number;
  durationMin: number;
  mode?: "deploy" | "check";
  ref?: string;
  trigger?: string;
  error?: string;
  active?: boolean;
  tests?: "PASSED" | "SKIPPED";
}

const ROWS: Row[] = [
  { id: "Rn4pQ7xA", project: "orders-api", status: "RUNNING", stage: "TEST", minutesAgo: 2, durationMin: 2, trigger: "webhook" },
  { id: "Kd8mW2vB", project: "orders-api", status: "SUCCESS", stage: "ACTIVATE", minutesAgo: 95, durationMin: 4, trigger: "webhook", active: true, tests: "PASSED" },
  { id: "Zp3tY9cE", project: "orders-api", status: "FAILED", stage: "ACTIVATE", minutesAgo: 300, durationMin: 5, trigger: "webhook", tests: "PASSED", error: "Live check failed after activation (https://orders.acme.dev/healthz returned HTTP 500, expected 200); restored previous release Vh6nL1sJ; its live check passed (https://orders.acme.dev/healthz returned HTTP 200)" },
  { id: "Vh6nL1sJ", project: "orders-api", status: "SUCCESS", stage: "ACTIVATE", minutesAgo: 1500, durationMin: 4, trigger: "cli", tests: "PASSED" },
  { id: "Cq2rF5gH", project: "orders-api", status: "SUCCESS", stage: "TEST", minutesAgo: 190, durationMin: 2, mode: "check", ref: "refs/pull/42/head", trigger: "webhook", tests: "PASSED" },
  { id: "Mb7sT0uN", project: "marketing-site", status: "SUCCESS", stage: "ACTIVATE", minutesAgo: 40, durationMin: 1, trigger: "webhook", active: true, tests: "SKIPPED" },
  { id: "Ja9eR4kD", project: "marketing-site", status: "SUCCESS", stage: "ACTIVATE", minutesAgo: 600, durationMin: 1, trigger: "webhook", tests: "SKIPPED" },
  { id: "Xw1yU6iO", project: "marketing-site", status: "FAILED", stage: "BUILD", minutesAgo: 1300, durationMin: 1, trigger: "cli", error: "Command failed: pnpm run build exited with code 1 (error TS2322 in src/Hero.tsx)" },
  { id: "Pf5hG8lS", project: "docs-portal", status: "SUCCESS", stage: "ACTIVATE", minutesAgo: 720, durationMin: 2, trigger: "cli", active: true, tests: "PASSED" },
  { id: "Tn3bV7qA", project: "docs-portal", status: "FAILED", stage: "DEPLOY", minutesAgo: 2900, durationMin: 2, trigger: "cli", error: "Host key of vps.acme.dev does not match deployment.ssh.hostKey." },
  { id: "Le0aK9wZ", project: "worker-app", status: "SUCCESS", stage: "ACTIVATE", minutesAgo: 410, durationMin: 6, trigger: "cli", active: true },
  { id: "Qy8dC2mX", project: "worker-app", status: "CANCELLED", stage: "BUILD", minutesAgo: 1000, durationMin: 1, trigger: "cli", error: "Cancelled by user" },
  { id: "Hs6jB4nR", project: "billing-service", status: "SUCCESS", stage: "ACTIVATE", minutesAgo: 1700, durationMin: 8, trigger: "webhook", active: true, tests: "PASSED" },
  { id: "Gu1oE3pT", project: "billing-service", status: "FAILED", stage: "VERIFY", minutesAgo: 3100, durationMin: 9, trigger: "webhook", error: "Candidate did not answer /healthz with HTTP 200 within 300s: pod shipflow-billing-service-gu1oe3pt-x7k2: ImagePullBackOff" },
  { id: "Wi7fA5vM", project: "billing-service", status: "QUEUED", stage: "RELEASE", minutesAgo: 0, durationMin: 0, trigger: "cli" },
];

const SCRIPTS: Record<ReleaseStage, string[]> = {
  RELEASE: [],
  PREPARE: ["PREPARE stage started", "Cloning {repo}", "Cloned commit {sha}", "Repository prepared successfully"],
  BUILD: [
    "BUILD stage started",
    "Sandbox runtime: daemon default runtime (gVisor not requested) [runc]",
    "Package manager: pnpm (reproducible install from lockfile)",
    "Install: pnpm install --frozen-lockfile",
    "Packages: +412",
    "Build command: pnpm run build",
    "vite v7 building for production...",
    "✓ 128 modules transformed.",
    "Build completed successfully",
  ],
  TEST: ["TEST stage started", "Running tests: pnpm test", "Test Files  14 passed (14)", "Tests  87 passed (87)", "Test stage finished: PASSED"],
  DEPLOY: ["DEPLOY stage started", "Validated dist/: 24 files, 1.2 MB", "Stored 24 files in s3://shipflow/releases/{id}/build", 'Target "{target}": candidate in place'],
  VERIFY: ["VERIFY stage started", "Candidate verified: / returned HTTP 200"],
  ACTIVATE: ["ACTIVATE stage started", "Switched live release", "https://{host}/ returned HTTP 200"],
};


function makeRelease(row: Row, projects: Map<string, Project>): Release {
  const project = projects.get(row.project)!;
  const started = NOW - row.minutesAgo * MIN;
  const isImage = ["docker", "kubernetes"].includes(project.target);
  const finished = row.status === "RUNNING" || row.status === "QUEUED" ? started : started + row.durationMin * MIN;
  const deployed = row.mode !== "check" && ["SUCCESS", "FAILED"].includes(row.status) && STAGE_ORDER(row.stage) >= STAGE_ORDER("DEPLOY");

  return {
    id: Math.floor(Math.random() * 1e6),
    release_id: row.id,
    repo_url: project.repo_url,
    status: row.status,
    current_stage: row.stage,
    created_at: iso(started),
    updated_at: iso(finished),
    error_message: row.error ?? null,
    deployment_url: deployed && !isImage ? `/preview/${row.id}/` : null,
    artifact_path: deployed ? `releases/${row.id}/${isImage ? "image" : "build"}` : null,
    public_deployment_url: row.status === "SUCCESS" && row.mode !== "check" ? urlOf(project) : null,
    commit_sha: row.status === "QUEUED" ? null : sha(row.id),
    test_status: row.tests ?? null,
    project: row.project,
    mode: row.mode ?? "deploy",
    ref: row.ref ?? "main",
    trigger: row.trigger ?? "cli",
    target: project.target,
    config: project.config,
    cancel_requested: false,
    artifacts_pruned: false,
    artifact_type: isImage ? "image" : "static",
    artifact: !deployed
      ? null
      : isImage
        ? { type: "image", key: `releases/${row.id}/image/image.tar`, digest: digest(row.id), sizeBytes: 98_000_000 + (row.id.charCodeAt(1) % 40) * 1_000_000, port: project.config.runtime?.port ?? 3000 }
        : { type: "static", path: `releases/${row.id}/build`, fileCount: 24 },
    build_strategy: row.status === "QUEUED" ? null : (project.config.build.strategy ?? (isImage ? "node" : "static")),
    deployment: null,
    is_active: Boolean(row.active),
  };
}

const ORDER: ReleaseStage[] = ["RELEASE", "PREPARE", "BUILD", "TEST", "DEPLOY", "VERIFY", "ACTIVATE"];
const STAGE_ORDER = (stage: ReleaseStage) => ORDER.indexOf(stage);

function urlOf(project: Project): string {
  const d = project.config.deployment;

  switch (d.target) {
    case "shipflow":
      return `https://${d.shipflow.hostname ?? "localhost:8080"}/`;
    case "ssh":
      return d.ssh.url;
    case "docker":
      return d.docker.url;
    case "kubernetes":
      return d.kubernetes.url;
  }
}

function logsFor(release: Release, upTo: ReleaseStage = release.current_stage, failed = release.status === "FAILED"): ReleaseLogRow[] {
  const rows: ReleaseLogRow[] = [];
  const start = Date.parse(release.created_at);
  const stages = ORDER.slice(1, STAGE_ORDER(upTo) + 1);
  let n = 0;

  const push = (stage: string, level: string, message: string) => {
    rows.push({ id: n, release_id: release.release_id, stage, level, message, created_at: iso(start + n * 4_000) });
    n += 1;
  };

  for (const stage of stages) {
    if (release.mode === "check" && STAGE_ORDER(stage) > STAGE_ORDER("TEST")) break;

    for (const line of SCRIPTS[stage]) {
      push(
        stage,
        "INFO",
        line.replace("{repo}", release.repo_url).replace("{sha}", release.commit_sha ?? "").replace("{id}", release.release_id).replace("{target}", release.target).replace("{host}", "app.example.dev")
      );
    }
  }

  if (failed && release.error_message) push(upTo, "ERROR", release.error_message);
  if (release.status === "CANCELLED") push(upTo, "WARN", "Cancelled by user");

  return rows;
}

function evidenceFor(release: Release, logs: ReleaseLogRow[]): Evidence {
  const failed = release.status === "FAILED";
  const message = release.error_message ?? "";
  const category = /Host key/.test(message) ? "ssh-host-key" : /ImagePull/.test(message) ? "image-pull" : /Live check/.test(message) ? "live-check-failed" : "build-failed";
  const diagnosis = {
    "ssh-host-key": { summary: "The server's SSH host key does not match the pinned hostKey.", suggestions: ["Confirm the server identity out of band, then update hostKey in shipflow.yml (`ssh-keyscan -t ed25519 <host>`)."] },
    "image-pull": { summary: "The target could not pull the release image.", suggestions: ["Check the registry address, that the registry credentials secret is set, and that the cluster nodes can reach the registry."] },
    "live-check-failed": { summary: "The release was activated but failed its health check, so ShipFlow switched back.", suggestions: ["Check that verification.path returns the expected status and that the application listens on runtime.port."] },
    "build-failed": { summary: "The build or dependency install failed.", suggestions: ["Reproduce locally with a clean checkout and the same Node version; check the command output in the logs."] },
  }[category] ?? { summary: "No known failure pattern matched.", suggestions: [] };
  const stages = [...new Set(logs.map((l) => l.stage))];

  return {
    releaseId: release.release_id,
    project: release.project,
    mode: release.mode,
    status: release.status,
    stage: release.current_stage,
    commitSha: release.commit_sha,
    ref: release.ref,
    trigger: release.trigger,
    target: release.target,
    buildStrategy: release.build_strategy,
    artifact: release.artifact ? (release.artifact.type === "image" ? { type: "image", digest: release.artifact.digest, sizeBytes: release.artifact.sizeBytes, port: release.artifact.port } : { type: "static", path: release.artifact.path }) : null,
    testStatus: release.test_status,
    createdAt: release.created_at,
    updatedAt: release.updated_at,
    timeline: stages.map((stage) => ({ stage, startedAt: logs.find((l) => l.stage === stage)?.created_at ?? null, lastAt: [...logs].reverse().find((l) => l.stage === stage)?.created_at ?? null, errors: logs.filter((l) => l.stage === stage && l.level === "ERROR").length, warnings: 0 })),
    failure: failed ? { stage: release.current_stage, message } : null,
    diagnosis: failed ? { category, ...diagnosis } : null,
  };
}

const delay = <T>(value: T, ms = 70): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), ms));
const clone = <T>(value: T): T => structuredClone(value);

/** An isolated, in-memory stand-in for the ShipFlow API. */
export function createDemoClient(): ApiClient {
  const projects = new Map<string, Project>();
  const secrets = new Map<string, Map<string, SecretInfo>>();
  const releases: Release[] = [];
  const progress = new Map<string, number>();

  for (const c of PROJECT_CONFIGS) {
    const name = c.project.name;
    projects.set(name, {
      name,
      repo_url: c.project.repository,
      target: c.deployment.target,
      hostname: c.deployment.target === "shipflow" ? (c.deployment.shipflow.hostname ?? null) : null,
      created_at: iso(NOW - 40 * 24 * HOUR),
      updated_at: iso(NOW - 3 * 24 * HOUR),
      config: c,
    });
    const have = new Map<string, SecretInfo>();
    for (const secretName of requiredSecrets(c)) have.set(secretName, { name: secretName, updated_at: iso(NOW - 10 * 24 * HOUR) });
    secrets.set(name, have);
  }

  // One deliberately missing secret, so the missing-secret state is visible.
  secrets.get("billing-service")?.delete("STRIPE_KEY");

  for (const row of ROWS) releases.push(makeRelease(row, projects));

  const summary = (p: Project): ProjectSummary => ({ name: p.name, repo_url: p.repo_url, target: p.target, hostname: p.hostname, created_at: p.created_at, updated_at: p.updated_at });
  const find = (id: string) => {
    const release = releases.find((r) => r.release_id === id);
    if (!release) throw new ApiError(`Release ${id} not found`, 404);
    return release;
  };

  // Queued and running releases advance a step every time they are read.
  function tick(release: Release) {
    if (release.status !== "QUEUED" && release.status !== "RUNNING") return;

    const count = (progress.get(release.release_id) ?? 0) + 1;
    progress.set(release.release_id, count);

    if (release.status === "QUEUED" && count >= 2) {
      release.status = "RUNNING";
      release.current_stage = "PREPARE";
      release.commit_sha = sha(release.release_id);
      release.build_strategy = release.config?.build.strategy ?? "static";
    } else if (release.status === "RUNNING") {
      const next = ORDER[Math.min(STAGE_ORDER(release.current_stage) + (count % 2 === 0 ? 1 : 0), ORDER.length - 1)]!;
      release.current_stage = next;

      if (next === "ACTIVATE" && release.mode === "deploy") {
        release.status = "SUCCESS";
        release.test_status = "PASSED";
        release.public_deployment_url = release.config ? urlOf({ config: release.config } as Project) : null;
        for (const other of releases) if (other.project === release.project) other.is_active = false;
        release.is_active = true;
      }
    }

    release.updated_at = iso(Date.now());
  }

  return {
    mode: "demo",
    repopilot: createDemoRepoPilot(),

    whoami: () =>
      delay<WhoAmI>({
        instance: "demo",
        targets: [
          { name: "shipflow", description: "Served by the ShipFlow site server from artifact storage", capabilities: { artifactTypes: ["static"], candidateVerification: "http", atomicActivation: true, rollback: true } },
          { name: "ssh", description: "Static files on your own server over SSH (versioned dirs + atomic symlink)", capabilities: { artifactTypes: ["static"], candidateVerification: "checksum", atomicActivation: true, rollback: true } },
          { name: "docker", description: "A container image on your own Docker host over SSH (managed nginx proxy, atomic switch)", capabilities: { artifactTypes: ["image"], candidateVerification: "http", atomicActivation: true, rollback: true, verifyAfterRevert: true } },
          { name: "kubernetes", description: "A container image on your own Kubernetes / K3s cluster", capabilities: { artifactTypes: ["image"], candidateVerification: "http", atomicActivation: true, rollback: true } },
        ],
        artifactStore: "s3://demo-bucket",
        secretsEnabled: true,
        githubWebhooks: true,
        allowedRepoPrefixes: ["https://github.com/acme/"],
      }),

    ready: () =>
      delay({
        ok: true,
        checks: [
          { name: "database", ok: true, detail: "ok" },
          { name: "queue", ok: true, detail: "ok" },
          { name: "artifact store", ok: true, detail: "s3://demo-bucket" },
          { name: "workers", ok: true, detail: "1 alive (sandbox docker, runtime: daemon default runtime (gVisor not requested), restricted network)" },
          { name: "secret storage", ok: true, detail: "ok" },
        ],
      }),

    listProjects: () => delay([...projects.values()].map(summary)),

    getProject: (name) => {
      const project = projects.get(name);
      if (!project) return Promise.reject(new ApiError(`Project ${name} not found`, 404));
      const active = releases.find((r) => r.project === name && r.is_active);
      return delay<ProjectDetail>(clone({ project, activeReleaseId: active?.release_id ?? null, secrets: [...(secrets.get(name)?.values() ?? [])] }));
    },

    saveProject: (c) => {
      const name = c.project.name;
      const existing = projects.get(name);
      const project: Project = {
        name,
        repo_url: c.project.repository,
        target: c.deployment.target,
        hostname: c.deployment.target === "shipflow" ? (c.deployment.shipflow.hostname ?? null) : null,
        created_at: existing?.created_at ?? iso(Date.now()),
        updated_at: iso(Date.now()),
        config: clone(c),
      };
      projects.set(name, project);
      if (!secrets.has(name)) secrets.set(name, new Map());
      const needed = requiredSecrets(c);
      const present = [...(secrets.get(name)?.keys() ?? [])];
      return delay({ project: clone(project), requiredSecrets: needed, missingSecrets: needed.filter((n) => !present.includes(n)) });
    },

    checkProject: (name) => {
      const project = projects.get(name);
      if (!project) return Promise.reject(new ApiError(`Project ${name} not found`, 404));
      const t = project.target;
      const checks =
        t === "shipflow"
          ? [{ name: "site server", ok: true, detail: "served by this ShipFlow instance (demo)" }]
          : [
              { name: "ssh connection", ok: true, detail: "deploy@host:22 (host key pinned) (demo)" },
              ...(t === "kubernetes" ? [{ name: "kubernetes API", ok: true, detail: "v1.30 reachable (demo)" }] : t === "docker" ? [{ name: "docker daemon", ok: true, detail: "server 27.0 (demo)" }] : [{ name: "remote path", ok: true, detail: "writable (demo)" }]),
            ];
      return delay({ ok: true, checks }, 600);
    },

    setSecret: (project, name, value) => {
      if (!projects.has(project)) return Promise.reject(new ApiError(`Project ${project} not found`, 404));
      if (!value) return Promise.reject(new ApiError("Secret values must be non-empty", 400));
      secrets.get(project)?.set(name, { name, updated_at: iso(Date.now()) });
      return delay(undefined);
    },

    removeSecret: (project, name) => {
      if (!secrets.get(project)?.delete(name)) return Promise.reject(new ApiError(`Secret ${name} not found`, 404));
      return delay(undefined);
    },

    listReleases: (options: ListReleasesOptions = {}) => {
      releases.forEach(tick);
      const list = releases
        .filter((r) => !options.project || r.project === options.project)
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
        .slice(0, options.limit ?? 50);
      return delay(clone({ activeReleaseId: options.project ? (list.find((r) => r.is_active)?.release_id ?? null) : null, releases: list }));
    },

    getRelease: (id) => {
      const release = find(id);
      tick(release);
      return delay(clone(release));
    },

    getReleaseLogs: (id): Promise<ReleaseLogs> => {
      const release = find(id);
      tick(release);
      const rows = logsFor(release, release.current_stage === "RELEASE" ? "PREPARE" : release.current_stage);
      return delay(
        clone({
          release: { release_id: release.release_id, project: release.project, status: release.status, current_stage: release.current_stage },
          logs: release.status === "QUEUED" ? [] : rows,
          notifications: release.status === "SUCCESS" ? [{ id: 1, release_id: id, type: release.mode === "check" ? "CHECK_SUCCESS" : "RELEASE_SUCCESS", message: `Release ${id} deployed and verified.`, created_at: release.updated_at }] : release.status === "FAILED" ? [{ id: 2, release_id: id, type: "RELEASE_FAILED", message: `Release ${id} failed during ${release.current_stage}.`, created_at: release.updated_at }] : [],
        })
      );
    },

    getEvidence: (id) => {
      const release = find(id);
      return delay(clone(evidenceFor(release, logsFor(release))));
    },

    deploy: ({ project, ref, mode }) => {
      const p = projects.get(project);
      if (!p) return Promise.reject(new ApiError(`Project ${project} not found`, 404));
      const missing = requiredSecrets(p.config).filter((n) => !secrets.get(project)?.has(n));
      if (missing.length > 0) return Promise.reject(new ApiError(`Missing secret(s) for ${project}: ${missing.join(", ")}.`, 409));
      const id = `Dm${Math.random().toString(36).slice(2, 8)}`;
      const release = makeRelease({ id, project, status: "QUEUED", stage: "RELEASE", minutesAgo: 0, durationMin: 0, mode: mode ?? "deploy", ref: ref ?? p.config.project.branch, trigger: "dashboard" }, projects);
      releases.unshift(release);
      return delay(clone(release));
    },

    cancelRelease: (id): Promise<CancelResult> => {
      const release = find(id);
      if (release.status !== "QUEUED" && release.status !== "RUNNING") return Promise.reject(new ApiError(`Release ${id} is already ${release.status}`, 409));
      release.status = "CANCELLED";
      release.error_message = "Cancelled by user";
      return delay({ status: "CANCELLED" });
    },

    rollback: (id): Promise<RollbackResult> => {
      const target = find(id);
      if (target.status !== "SUCCESS" || target.mode !== "deploy") return Promise.reject(new ApiError(`Release ${id} cannot be a rollback target`, 409));
      if (target.is_active) return Promise.reject(new ApiError(`Release ${id} is already active`, 409));
      const previous = releases.find((r) => r.project === target.project && r.is_active);
      for (const r of releases) if (r.project === target.project) r.is_active = false;
      target.is_active = true;
      return delay({ project: target.project, targetReleaseId: id, previousReleaseId: previous?.release_id ?? null, artifactPath: target.artifact_path ?? "", fileCount: 24, target: target.target }, 400);
    },
  };
}

