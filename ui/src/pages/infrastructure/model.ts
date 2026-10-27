// Derived, read-only infrastructure views. ShipFlow has no Server or Registry
// entity: everything here is computed from the projects' own configurations.
import type { Project } from "@/api/types";

export type ServerKind = "ssh" | "docker" | "kubernetes";

export const KIND_LABEL: Record<ServerKind, string> = {
  ssh: "SSH static host",
  docker: "Docker host",
  kubernetes: "Kubernetes",
};

export const KIND_RUNTIME: Record<ServerKind, string> = {
  ssh: "Static files (versioned directories with an atomic symlink switch)",
  docker: "Container images, loaded over SSH and run behind a managed proxy",
  kubernetes: "Container images, pushed to a registry and run as a Deployment",
};

export interface InfraServer {
  id: string;
  kind: ServerKind;
  /** host:port for ssh/docker; the kubeconfig secret name for kubernetes. */
  address: string;
  user: string | null;
  /** Pinned SSH host key (public). Null for kubernetes. */
  hostKey: string | null;
  /** NAME of the secret holding the credential (never its value). */
  credentialSecret: string;
  namespaces: string[];
  projects: string[];
}

export interface HostKeyParts {
  type: string;
  /** Truncated key material: start and end of the base64 blob. */
  short: string;
}

/** Split a public host key into its type and a truncated form for display. */
export function formatHostKey(hostKey: string): HostKeyParts {
  const [type = "", blob = ""] = hostKey.trim().split(/\s+/);
  const short = blob.length > 24 ? `${blob.slice(0, 12)}…${blob.slice(-8)}` : blob;

  return { type, short };
}

export function deriveInfraServers(projects: Project[]): InfraServer[] {
  const map = new Map<string, InfraServer>();

  for (const project of projects) {
    const d = project.config.deployment;
    let id: string;
    let base: Omit<InfraServer, "projects">;

    if (d.target === "ssh" || d.target === "docker") {
      const t = d.target === "ssh" ? d.ssh : d.docker;

      id = `${d.target}:${t.user}@${t.host}:${t.port}`;
      base = { id, kind: d.target, address: `${t.host}:${t.port}`, user: t.user, hostKey: t.hostKey, credentialSecret: t.privateKeySecret, namespaces: [] };
    } else if (d.target === "kubernetes") {
      id = `kubernetes:${d.kubernetes.kubeconfigSecret}`;
      base = { id, kind: "kubernetes", address: `kubeconfig secret ${d.kubernetes.kubeconfigSecret}`, user: null, hostKey: null, credentialSecret: d.kubernetes.kubeconfigSecret, namespaces: [] };
    } else {
      continue;
    }

    const entry = map.get(id) ?? { ...base, projects: [] };

    entry.projects.push(project.name);
    if (d.target === "kubernetes" && !entry.namespaces.includes(d.kubernetes.namespace)) entry.namespaces.push(d.kubernetes.namespace);
    map.set(id, entry);
  }

  return [...map.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.address.localeCompare(b.address));
}

export interface InfraRegistry {
  endpoint: string;
  authSecret: string | null;
  namespaces: string[];
  projects: string[];
}

export function deriveInfraRegistries(projects: Project[]): InfraRegistry[] {
  const map = new Map<string, InfraRegistry>();

  for (const project of projects) {
    const d = project.config.deployment;

    if (d.target !== "kubernetes") continue;

    const entry = map.get(d.kubernetes.registry) ?? { endpoint: d.kubernetes.registry, authSecret: d.kubernetes.registryAuthSecret ?? null, namespaces: [], projects: [] };

    entry.projects.push(project.name);
    if (!entry.namespaces.includes(d.kubernetes.namespace)) entry.namespaces.push(d.kubernetes.namespace);
    if (!entry.authSecret && d.kubernetes.registryAuthSecret) entry.authSecret = d.kubernetes.registryAuthSecret;
    map.set(d.kubernetes.registry, entry);
  }

  return [...map.values()].sort((a, b) => a.endpoint.localeCompare(b.endpoint));
}

/** Renders a check's `detail` (any JSON) as text. */
export function detailText(detail: unknown): string {
  if (detail === null || detail === undefined) return "";
  if (typeof detail === "string") return detail;

  try {
    return JSON.stringify(detail);
  } catch {
    return "[unprintable detail]";
  }
}
