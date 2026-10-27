import type { Release } from "@/api/types";
import type { ProjectWithState } from "@/data/hooks";
import { latestByProject } from "@/lib/derive";
import { requiredSecrets } from "@/lib/projectConfig";

export interface AttentionItem {
  project: string;
  reasons: string[];
  failedReleaseId: string | null;
}

/** Applications whose latest release failed, or that lack secrets their configuration requires. */
export function applicationsNeedingAttention(details: ProjectWithState[], releases: Release[]): AttentionItem[] {
  const latest = latestByProject(releases);
  const items: AttentionItem[] = [];

  for (const { project, secrets } of details) {
    const reasons: string[] = [];
    const last = latest.get(project.name);
    const have = new Set(secrets.map((s) => s.name));
    const missing = requiredSecrets(project.config).filter((name) => !have.has(name));

    if (last?.status === "FAILED") reasons.push(`Latest release ${last.release_id} failed`);
    if (missing.length > 0) reasons.push(`Missing ${missing.length === 1 ? "secret" : "secrets"}: ${missing.join(", ")}`);
    if (reasons.length > 0) items.push({ project: project.name, reasons, failedReleaseId: last?.status === "FAILED" ? last.release_id : null });
  }

  return items;
}
