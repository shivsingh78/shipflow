// Filtering and deriving for release lists and the activity feed. Everything is
// computed from real release records; no events are invented.
import type { Release, ReleaseMode, ReleaseStatus } from "@/api/types";
import { isActiveStatus } from "./status";

export type DateRange = "all" | "24h" | "7d" | "30d";

export const RANGE_MS: Record<Exclude<DateRange, "all">, number> = {
  "24h": 24 * 3600_000,
  "7d": 7 * 24 * 3600_000,
  "30d": 30 * 24 * 3600_000,
};

export interface RunFilters {
  query: string;
  project: string;
  status: ReleaseStatus | "";
  mode: ReleaseMode | "";
  target: string;
  range: DateRange;
  liveOnly: boolean;
}

export const EMPTY_FILTERS: RunFilters = { query: "", project: "", status: "", mode: "", target: "", range: "all", liveOnly: false };

export function hasActiveFilters(filters: RunFilters): boolean {
  return JSON.stringify(filters) !== JSON.stringify(EMPTY_FILTERS);
}

/** Search matches the release id, application, commit, ref and repository. */
export function filterReleases(releases: Release[], filters: RunFilters, now = Date.now()): Release[] {
  const needle = filters.query.trim().toLowerCase();
  const since = filters.range === "all" ? null : now - RANGE_MS[filters.range];

  return releases.filter((r) => {
    if (filters.project && r.project !== filters.project) return false;
    if (filters.status && r.status !== filters.status) return false;
    if (filters.mode && r.mode !== filters.mode) return false;
    if (filters.target && r.target !== filters.target) return false;
    if (filters.liveOnly && !r.is_active) return false;
    if (since !== null && Date.parse(r.created_at) < since) return false;

    if (needle) {
      const haystack = [r.release_id, r.project, r.commit_sha, r.ref, r.repo_url].filter(Boolean).join(" ").toLowerCase();

      if (!haystack.includes(needle)) return false;
    }

    return true;
  });
}

export const hasActiveRelease = (releases: Release[] | undefined): boolean => (releases ?? []).some((r) => isActiveStatus(r.status));

/** Running releases first, then newest first. */
export function sortForPicker(releases: Release[]): Release[] {
  const rank = (r: Release) => (r.status === "RUNNING" ? 0 : r.status === "QUEUED" ? 1 : 2);

  return [...releases].sort((a, b) => rank(a) - rank(b) || Date.parse(b.created_at) - Date.parse(a.created_at));
}

export type ActivityKind = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface ActivityEvent {
  key: string;
  kind: ActivityKind;
  at: string;
  release: Release;
  /** A successful deployment whose artifact can still be made live again. */
  rollbackEligible: boolean;
}

const TERMINAL: Partial<Record<ReleaseStatus, ActivityKind>> = { SUCCESS: "succeeded", FAILED: "failed", CANCELLED: "cancelled" };

/**
 * One "queued" event per release (at created_at) plus, once it has moved on, an
 * event for its current state (at updated_at). That is all the records tell us.
 */
export function deriveActivity(releases: Release[]): ActivityEvent[] {
  const events: ActivityEvent[] = [];

  for (const release of releases) {
    const rollbackEligible = release.mode === "deploy" && release.status === "SUCCESS" && !release.is_active && !release.artifacts_pruned && release.artifact_path !== null;

    events.push({ key: `${release.release_id}:queued`, kind: "queued", at: release.created_at, release, rollbackEligible: false });

    if (release.status === "RUNNING") events.push({ key: `${release.release_id}:running`, kind: "running", at: release.updated_at, release, rollbackEligible: false });

    const terminal = TERMINAL[release.status];

    if (terminal) events.push({ key: `${release.release_id}:${terminal}`, kind: terminal, at: release.updated_at, release, rollbackEligible });
  }

  return events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export function describeActivity(event: ActivityEvent): string {
  const { release } = event;
  const what = release.mode === "check" ? "check" : "deployment";

  switch (event.kind) {
    case "queued":
      return `${what} queued`;
    case "running":
      return `${what} running (stage ${release.current_stage.toLowerCase()})`;
    case "succeeded":
      return release.mode === "check" ? "check passed" : release.is_active ? "deployed and live" : "deployed";
    case "failed":
      return `${what} failed at ${release.current_stage.toLowerCase()}`;
    case "cancelled":
      return `${what} cancelled`;
  }
}

export function filterActivity(events: ActivityEvent[], { project, kind }: { project: string; kind: ActivityKind | "" }): ActivityEvent[] {
  return events.filter((e) => (!project || e.release.project === project) && (!kind || e.kind === kind));
}

export function dayKey(iso: string): string {
  const d = new Date(iso);

  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function dayLabel(iso: string, now = Date.now()): string {
  const today = dayKey(new Date(now).toISOString());
  const yesterday = dayKey(new Date(now - 24 * 3600_000).toISOString());
  const key = dayKey(iso);

  if (key === today) return "Today";
  if (key === yesterday) return "Yesterday";

  return new Date(iso).toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" });
}

export function groupByDay(events: ActivityEvent[], now = Date.now()): Array<{ key: string; label: string; events: ActivityEvent[] }> {
  const groups: Array<{ key: string; label: string; events: ActivityEvent[] }> = [];

  for (const event of events) {
    const key = dayKey(event.at);
    const last = groups[groups.length - 1];

    if (last && last.key === key) last.events.push(event);
    else groups.push({ key, label: dayLabel(event.at, now), events: [event] });
  }

  return groups;
}

/** Only http(s) URLs are ever rendered as links. */
export function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;

  try {
    const parsed = new URL(url);

    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function detailText(detail: unknown): string {
  if (detail === null || detail === undefined) return "";

  return typeof detail === "string" ? detail : JSON.stringify(detail);
}
