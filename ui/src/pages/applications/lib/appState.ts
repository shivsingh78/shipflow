// What the applications list shows, derived from real records only.
import type { ProjectWithState } from "@/data/hooks";
import type { Release, SecretInfo } from "@/api/types";
import { latestByProject } from "@/lib/derive";
import { requiredSecrets } from "@/lib/projectConfig";
import type { ProjectConfig } from "@/lib/projectConfig";
import { isActiveStatus } from "@/lib/status";

/** Required secret names that have no stored value yet. */
export function missingSecrets(config: ProjectConfig, secrets: Pick<SecretInfo, "name">[]): string[] {
  const present = new Set(secrets.map((s) => s.name));

  return requiredSecrets(config).filter((name) => !present.has(name));
}

export type AppStatus = "healthy" | "failed" | "running" | "never";

export const APP_STATUS_LABEL: Record<AppStatus, string> = {
  healthy: "Healthy",
  failed: "Failed",
  running: "Running",
  never: "Never deployed",
};

/**
 * Status of the latest real deployment (check runs from pull requests are
 * ignored; cancelled runs do not change it). "Healthy" means that deployment
 * succeeded and passed its live check at deploy time: ShipFlow does not monitor.
 */
export function appStatus(latestDeploy: Release | undefined): AppStatus {
  if (!latestDeploy) return "never";
  if (isActiveStatus(latestDeploy.status)) return "running";

  return latestDeploy.status === "SUCCESS" ? "healthy" : "failed";
}

export interface AppRow {
  details: ProjectWithState;
  name: string;
  status: AppStatus;
  /** Newest release of any kind (shown as "latest release"). */
  latest: Release | undefined;
  missing: string[];
}

export function deriveAppRows(details: ProjectWithState[], releases: Release[]): AppRow[] {
  const latestAny = latestByProject(releases);
  const latestDeploy = latestByProject(releases.filter((r) => r.mode === "deploy" && r.status !== "CANCELLED"));

  return details.map((d) => ({
    details: d,
    name: d.project.name,
    status: appStatus(latestDeploy.get(d.project.name)),
    latest: latestAny.get(d.project.name),
    missing: missingSecrets(d.project.config, d.secrets),
  }));
}

export type SortKey = "name" | "recent" | "status";

export interface AppFilters {
  search: string;
  target: string;
  status: AppStatus | "all";
}

export function filterRows(rows: AppRow[], { search, target, status }: AppFilters): AppRow[] {
  const q = search.trim().toLowerCase();

  return rows.filter((row) => {
    if (target !== "all" && row.details.project.target !== target) return false;
    if (status !== "all" && row.status !== status) return false;
    if (!q) return true;

    const p = row.details.project;

    return [p.name, p.repo_url, p.config.project.branch, p.target].some((v) => v.toLowerCase().includes(q));
  });
}

const STATUS_ORDER: Record<AppStatus, number> = { failed: 0, running: 1, never: 2, healthy: 3 };

export function sortRows(rows: AppRow[], key: SortKey): AppRow[] {
  const copy = [...rows];

  if (key === "name") return copy.sort((a, b) => a.name.localeCompare(b.name));
  if (key === "status") return copy.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name));

  return copy.sort((a, b) => (b.latest ? Date.parse(b.latest.created_at) : 0) - (a.latest ? Date.parse(a.latest.created_at) : 0) || a.name.localeCompare(b.name));
}

export interface SecretRow {
  name: string;
  required: boolean;
  /** What the configuration uses it for (null when nothing references it). */
  usage: string | null;
  set: boolean;
  updatedAt: string | null;
}

function secretUsage(config: ProjectConfig): Map<string, string> {
  const usage = new Map<string, string>();
  const d = config.deployment;

  if (d.target === "ssh") usage.set(d.ssh.privateKeySecret, "SSH private key for the deployment target");
  if (d.target === "docker") usage.set(d.docker.privateKeySecret, "SSH private key for the Docker host");
  if (d.target === "kubernetes") {
    usage.set(d.kubernetes.kubeconfigSecret, "Kubeconfig for the cluster");
    if (d.kubernetes.registryAuthSecret) usage.set(d.kubernetes.registryAuthSecret, "Registry credentials (Docker config.json)");
  }

  for (const name of config.runtime?.secrets ?? []) if (!usage.has(name)) usage.set(name, "Injected as an environment variable at run time");

  return usage;
}

/** Every secret the configuration needs plus any stored ones; required-but-missing first. */
export function secretRows(config: ProjectConfig, secrets: SecretInfo[]): SecretRow[] {
  const usage = secretUsage(config);
  const required = new Set(requiredSecrets(config));
  const stored = new Map(secrets.map((s) => [s.name, s]));
  const names = new Set([...required, ...stored.keys()]);

  const rank = (r: SecretRow) => (r.required && !r.set ? 0 : r.required ? 1 : 2);

  return [...names]
    .map((name) => ({ name, required: required.has(name), usage: usage.get(name) ?? null, set: stored.has(name), updatedAt: stored.get(name)?.updated_at ?? null }))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
