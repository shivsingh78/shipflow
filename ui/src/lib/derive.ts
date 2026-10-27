// Pure helpers that turn API data into what the pages show. Everything here is
// derived from real records; nothing is invented.
import type { Project, Release } from "@/api/types";
import { isActiveStatus } from "./status";

/** Wall-clock duration of a release: finished ones use updated_at, running ones use now. */
export function releaseDurationMs(release: Release, now = Date.now()): number | null {
  const start = Date.parse(release.created_at);
  const end = isActiveStatus(release.status) ? now : Date.parse(release.updated_at);

  if (Number.isNaN(start) || Number.isNaN(end)) return null;

  return release.status === "QUEUED" ? null : Math.max(0, end - start);
}

export interface ReleaseSummary {
  total: number;
  succeeded: number;
  failed: number;
  running: number;
  queued: number;
  cancelled: number;
  deployments: number;
  checks: number;
}

export function summarizeReleases(releases: Release[]): ReleaseSummary {
  const summary: ReleaseSummary = { total: releases.length, succeeded: 0, failed: 0, running: 0, queued: 0, cancelled: 0, deployments: 0, checks: 0 };

  for (const release of releases) {
    if (release.status === "SUCCESS") summary.succeeded += 1;
    else if (release.status === "FAILED") summary.failed += 1;
    else if (release.status === "RUNNING") summary.running += 1;
    else if (release.status === "QUEUED") summary.queued += 1;
    else if (release.status === "CANCELLED") summary.cancelled += 1;

    if (release.mode === "check") summary.checks += 1;
    else summary.deployments += 1;
  }

  return summary;
}

/** The newest release of a project (releases arrive newest first). */
export function latestByProject(releases: Release[]): Map<string, Release> {
  const latest = new Map<string, Release>();

  for (const release of releases) if (!latest.has(release.project)) latest.set(release.project, release);

  return latest;
}

export function activeByProject(releases: Release[]): Map<string, Release> {
  const active = new Map<string, Release>();

  for (const release of releases) if (release.is_active) active.set(release.project, release);

  return active;
}

/** The URL a deployed project answers on, from its configuration. */
export function projectUrl(project: Pick<Project, "config">): string | null {
  const d = project.config.deployment;

  switch (d.target) {
    case "shipflow":
      return d.shipflow.hostname ? `https://${d.shipflow.hostname}/` : null;
    case "ssh":
      return d.ssh.url;
    case "docker":
      return d.docker.url;
    case "kubernetes":
      return d.kubernetes.url;
  }
}

export interface ServerEntry {
  /** host[:port] for ssh/docker, API server namespace for kubernetes. */
  id: string;
  kind: "ssh" | "docker" | "kubernetes";
  host: string;
  detail: string;
  projects: string[];
}

/** Servers are not first-class in ShipFlow: they exist inside project configurations. */
export function deriveServers(projects: Project[]): ServerEntry[] {
  const map = new Map<string, ServerEntry>();

  for (const project of projects) {
    const d = project.config.deployment;
    let key: string;
    let entry: Omit<ServerEntry, "projects">;

    if (d.target === "ssh") {
      key = `ssh:${d.ssh.user}@${d.ssh.host}:${d.ssh.port}`;
      entry = { id: key, kind: "ssh", host: `${d.ssh.host}:${d.ssh.port}`, detail: `user ${d.ssh.user}` };
    } else if (d.target === "docker") {
      key = `docker:${d.docker.user}@${d.docker.host}:${d.docker.port}`;
      entry = { id: key, kind: "docker", host: `${d.docker.host}:${d.docker.port}`, detail: `user ${d.docker.user}, proxy port ${d.docker.publishPort}` };
    } else if (d.target === "kubernetes") {
      key = `kubernetes:${d.kubernetes.kubeconfigSecret}`;
      entry = { id: key, kind: "kubernetes", host: `kubeconfig secret ${d.kubernetes.kubeconfigSecret}`, detail: "cluster address is stored inside the secret" };
    } else {
      continue;
    }

    const existing = map.get(key);

    if (existing) existing.projects.push(project.name);
    else map.set(key, { ...entry, projects: [project.name] });
  }

  return [...map.values()].sort((a, b) => a.host.localeCompare(b.host));
}

export interface RegistryEntry {
  endpoint: string;
  projects: string[];
  authSecret: string | null;
}

/** Only the kubernetes target uses a registry; the docker target keeps images in the artifact store. */
export function deriveRegistries(projects: Project[]): RegistryEntry[] {
  const map = new Map<string, RegistryEntry>();

  for (const project of projects) {
    const d = project.config.deployment;

    if (d.target !== "kubernetes") continue;

    const existing = map.get(d.kubernetes.registry);

    if (existing) existing.projects.push(project.name);
    else map.set(d.kubernetes.registry, { endpoint: d.kubernetes.registry, projects: [project.name], authSecret: d.kubernetes.registryAuthSecret ?? null });
  }

  return [...map.values()].sort((a, b) => a.endpoint.localeCompare(b.endpoint));
}

export interface DomainEntry {
  host: string;
  url: string;
  project: string;
  target: string;
}

export function deriveDomains(projects: Project[]): DomainEntry[] {
  const rows: DomainEntry[] = [];

  for (const project of projects) {
    const url = projectUrl(project);

    if (!url) continue;

    try {
      rows.push({ host: new URL(url).host, url, project: project.name, target: project.target });
    } catch {
      // A malformed URL cannot be listed as a domain.
    }
  }

  return rows.sort((a, b) => a.host.localeCompare(b.host));
}
