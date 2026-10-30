import { describe, expect, it } from "vitest";
import type { Release } from "@/api/types";
import { PIPELINE_TABS, describeStages, filterPipelines, stageStates, tabCounts } from "./pipeline";

const states = (status: Release["status"], stage: Release["current_stage"], mode: Release["mode"] = "deploy") => stageStates({ status, stage, mode }).map((s) => s.state);
const release = (over: Partial<Release>): Release => ({ id: 1, release_id: "Aa1Bb2Cc", repo_url: "u", status: "SUCCESS", current_stage: "ACTIVATE", created_at: "2026-10-30T10:00:00Z", updated_at: "2026-10-30T10:05:00Z", project: "orders-api", mode: "deploy", trigger: "cli", commit_sha: "abcdef1234", ref: "main", ...over }) as Release;

describe("stageStates (derived from the release record only)", () => {
  it("queued releases have nothing started", () => {
    expect(states("QUEUED", "RELEASE")).toEqual(["pending", "pending", "pending", "pending", "pending", "pending"]);
  });

  it("a running release is done before its stage, running at it, pending after", () => {
    expect(states("RUNNING", "TEST")).toEqual(["done", "done", "running", "pending", "pending", "pending"]);
  });

  it("a failed release fails at its stage and leaves the rest pending", () => {
    expect(states("FAILED", "BUILD")).toEqual(["done", "failed", "pending", "pending", "pending", "pending"]);
  });

  it("a cancelled release is skipped at the stage it stopped on", () => {
    expect(states("CANCELLED", "DEPLOY")).toEqual(["done", "done", "done", "skipped", "pending", "pending"]);
  });

  it("a successful release has every stage done", () => {
    expect(states("SUCCESS", "ACTIVATE")).toEqual(Array(6).fill("done"));
  });

  it("a check run skips the stages after TEST instead of leaving them pending", () => {
    expect(states("SUCCESS", "TEST", "check")).toEqual(["done", "done", "done", "skipped", "skipped", "skipped"]);
    expect(states("RUNNING", "BUILD", "check")).toEqual(["done", "running", "pending", "skipped", "skipped", "skipped"]);
  });

  it("describes every stage for assistive technology", () => {
    expect(describeStages(stageStates({ status: "RUNNING", stage: "TEST", mode: "deploy" }))).toBe("Prepare done, Build done, Test running, Deploy pending, Verify pending, Activate pending");
  });
});

describe("pipeline list filtering", () => {
  const all = [release({ release_id: "OK000001", status: "SUCCESS" }), release({ release_id: "BAD00002", status: "FAILED", project: "billing" }), release({ release_id: "RUN00003", status: "RUNNING" }), release({ release_id: "QUE00004", status: "QUEUED" }), release({ release_id: "CAN00005", status: "CANCELLED" })];

  it("counts each tab from the data", () => {
    expect(tabCounts(all)).toEqual({ all: 5, active: 2, succeeded: 1, failed: 1 });
    expect(PIPELINE_TABS.map((t) => t.value)).toEqual(["all", "active", "succeeded", "failed"]);
  });

  it("filters by tab", () => {
    expect(filterPipelines(all, { query: "", tab: "active" }).map((r) => r.release_id)).toEqual(["RUN00003", "QUE00004"]);
    expect(filterPipelines(all, { query: "", tab: "failed" }).map((r) => r.release_id)).toEqual(["BAD00002"]);
    expect(filterPipelines(all, { query: "", tab: "all" })).toHaveLength(5);
  });

  it("searches release id, application, commit and ref, case-insensitively", () => {
    expect(filterPipelines(all, { query: "billing", tab: "all" }).map((r) => r.release_id)).toEqual(["BAD00002"]);
    expect(filterPipelines(all, { query: "que0000", tab: "all" }).map((r) => r.release_id)).toEqual(["QUE00004"]);
    expect(filterPipelines(all, { query: "ABCDEF", tab: "all" })).toHaveLength(5);
    expect(filterPipelines(all, { query: "nothing-matches", tab: "all" })).toEqual([]);
  });
});
