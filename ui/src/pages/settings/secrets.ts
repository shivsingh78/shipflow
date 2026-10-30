// The cross-application secret inventory, from real records only: NAMES and state.
// ShipFlow never returns a secret's value, so none is ever represented here.
import type { ProjectWithState } from "@/data/hooks";
import { requiredSecrets } from "@/lib/projectConfig";

export type SecretState = "configured" | "missing";

export interface SecretRow {
  project: string;
  name: string;
  state: SecretState;
  /** Required by the application's configuration (a stored extra is false). */
  required: boolean;
  updatedAt: string | null;
}

export function secretInventory(details: ProjectWithState[]): SecretRow[] {
  const rows: SecretRow[] = [];

  for (const { project, secrets } of details) {
    const stored = new Map(secrets.map((s) => [s.name, s.updated_at]));
    const required = requiredSecrets(project.config);

    for (const name of required) {
      rows.push({ project: project.name, name, required: true, state: stored.has(name) ? "configured" : "missing", updatedAt: stored.get(name) ?? null });
    }

    for (const [name, updatedAt] of stored) {
      if (!required.includes(name)) rows.push({ project: project.name, name, required: false, state: "configured", updatedAt });
    }
  }

  // Problems first, then by application and name.
  return rows.sort((a, b) => Number(a.state === "configured") - Number(b.state === "configured") || a.project.localeCompare(b.project) || a.name.localeCompare(b.name));
}

export function secretSummary(rows: SecretRow[]): { configured: number; missing: number; applications: number } {
  return { configured: rows.filter((r) => r.state === "configured").length, missing: rows.filter((r) => r.state === "missing").length, applications: new Set(rows.map((r) => r.project)).size };
}
