import { describe, expect, it } from "vitest";
import type { Release } from "@/api/types";
import { EMPTY_FILTERS, deriveActivity, describeActivity, filterActivity, filterReleases, groupByDay, safeHref, sortForPicker } from "./runs";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const ago = (h: number) => new Date(NOW - h * 3600_000).toISOString();

function rel(partial: Partial<Release>): Release {
  return {
    id: 1, release_id: "r1", repo_url: "https://github.com/acme/app", status: "SUCCESS", current_stage: "ACTIVATE", created_at: ago(2), updated_at: ago(1),
    error_message: null, deployment_url: null, artifact_path: "/a", public_deployment_url: null, commit_sha: "abc1234def", test_status: "PASSED", project: "app", mode: "deploy",
    ref: "main", trigger: "cli", target: "shipflow", config: null, cancel_requested: false, artifacts_pruned: false, artifact_type: "static", artifact: null, build_strategy: null,
    deployment: null, is_active: false, ...partial,
  };
}

const releases = [
  rel({ release_id: "a1", project: "web", is_active: true }),
  rel({ release_id: "b2", project: "api", status: "FAILED", mode: "check", target: "docker", created_at: ago(30) }),
  rel({ release_id: "c3", project: "api", status: "RUNNING", current_stage: "BUILD", created_at: ago(24 * 10), commit_sha: "ffff000" }),
];

describe("filterReleases", () => {
  it("filters by application, status, type and target", () => {
    expect(filterReleases(releases, { ...EMPTY_FILTERS, project: "api" }, NOW).map((r) => r.release_id)).toEqual(["b2", "c3"]);
    expect(filterReleases(releases, { ...EMPTY_FILTERS, status: "FAILED" }, NOW)).toHaveLength(1);
    expect(filterReleases(releases, { ...EMPTY_FILTERS, mode: "check" }, NOW)[0]?.release_id).toBe("b2");
    expect(filterReleases(releases, { ...EMPTY_FILTERS, target: "docker" }, NOW)).toHaveLength(1);
    expect(filterReleases(releases, { ...EMPTY_FILTERS, liveOnly: true }, NOW).map((r) => r.release_id)).toEqual(["a1"]);
  });

  it("searches id, app and commit, case-insensitively", () => {
    expect(filterReleases(releases, { ...EMPTY_FILTERS, query: "FFFF0" }, NOW).map((r) => r.release_id)).toEqual(["c3"]);
    expect(filterReleases(releases, { ...EMPTY_FILTERS, query: "a1" }, NOW)).toHaveLength(1);
  });

  it("applies date ranges relative to now", () => {
    expect(filterReleases(releases, { ...EMPTY_FILTERS, range: "24h" }, NOW).map((r) => r.release_id)).toEqual(["a1"]);
    expect(filterReleases(releases, { ...EMPTY_FILTERS, range: "7d" }, NOW)).toHaveLength(2);
    expect(filterReleases(releases, { ...EMPTY_FILTERS, range: "30d" }, NOW)).toHaveLength(3);
  });
});

describe("activity", () => {
  it("derives queued plus current-state events, newest first", () => {
    const events = deriveActivity(releases);

    expect(events.map((e) => e.key)).toEqual(["a1:queued", "a1:succeeded", "b2:queued", "b2:failed", "c3:queued", "c3:running"].sort((x, y) => events.findIndex((e) => e.key === x) - events.findIndex((e) => e.key === y)));
    expect(events).toHaveLength(6);
    expect(Date.parse(events[0]!.at)).toBeGreaterThanOrEqual(Date.parse(events[events.length - 1]!.at));
  });

  it("flags rollback eligibility only for stored, non-live, successful deployments", () => {
    const events = deriveActivity([rel({ release_id: "x" }), rel({ release_id: "y", is_active: true }), rel({ release_id: "z", artifacts_pruned: true })]);
    const eligible = events.filter((e) => e.rollbackEligible).map((e) => e.release.release_id);

    expect(eligible).toEqual(["x"]);
  });

  it("describes and filters events", () => {
    const events = deriveActivity(releases);

    expect(describeActivity(events.find((e) => e.key === "b2:failed")!)).toBe("check failed at activate");
    expect(filterActivity(events, { project: "api", kind: "failed" })).toHaveLength(1);
  });

  it("groups by local day", () => {
    const groups = groupByDay(deriveActivity(releases), NOW);

    expect(groups[0]?.label).toBe("Today");
    expect(groups.reduce((n, g) => n + g.events.length, 0)).toBe(6);
  });
});

describe("helpers", () => {
  it("puts running releases first in the picker", () => {
    expect(sortForPicker(releases)[0]?.release_id).toBe("c3");
  });

  it("only links http(s) URLs", () => {
    expect(safeHref("https://x.dev/a")).toBe("https://x.dev/a");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref(null)).toBeNull();
  });
});
