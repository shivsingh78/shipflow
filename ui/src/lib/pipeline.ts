import type { Release, ReleaseMode, ReleaseStage, ReleaseStatus } from "@/api/types";
import { STAGES } from "@/api/types";
import { stageLabel } from "./status";

export type StepState = "pending" | "running" | "done" | "failed" | "skipped";

export interface StageState {
  stage: ReleaseStage;
  state: StepState;
}

/**
 * Where each pipeline stage stands, derived ONLY from the release record
 * (status, current stage, mode). ShipFlow does not store per-stage timings, so
 * none are invented. A "check" run stops after TEST, so later stages are
 * skipped rather than pending.
 */
export function stageStates({ status, stage, mode }: { status: ReleaseStatus; stage: ReleaseStage; mode: ReleaseMode }): StageState[] {
  const index = STAGES.indexOf(stage);
  const testIndex = STAGES.indexOf("TEST");

  return STAGES.map((name, i): StageState => {
    if (mode === "check" && i > testIndex) return { stage: name, state: "skipped" };
    if (status === "QUEUED" || index === -1) return { stage: name, state: "pending" };
    if (status === "SUCCESS") return { stage: name, state: "done" };
    if (i < index) return { stage: name, state: "done" };
    if (i === index) return { stage: name, state: status === "FAILED" ? "failed" : status === "CANCELLED" ? "skipped" : "running" };

    return { stage: name, state: "pending" };
  });
}

/** "PREPARE done, BUILD done, TEST running, …": the text alternative for a compact track. */
export function describeStages(states: StageState[]): string {
  return states.map(({ stage, state }) => `${stageLabel(stage)} ${state}`).join(", ");
}

export type PipelineTab = "all" | "active" | "succeeded" | "failed";

export const PIPELINE_TABS: Array<{ value: PipelineTab; label: string }> = [
  { value: "all", label: "All" },
  { value: "active", label: "In progress" },
  { value: "succeeded", label: "Succeeded" },
  { value: "failed", label: "Failed" },
];

const TAB_STATUSES: Record<Exclude<PipelineTab, "all">, ReleaseStatus[]> = {
  active: ["QUEUED", "RUNNING"],
  succeeded: ["SUCCESS"],
  failed: ["FAILED"],
};

export function filterPipelines(releases: Release[], { query, tab }: { query: string; tab: PipelineTab }): Release[] {
  const q = query.trim().toLowerCase();

  return releases.filter((release) => {
    if (tab !== "all" && !TAB_STATUSES[tab].includes(release.status)) return false;

    return !q || [release.release_id, release.project, release.commit_sha ?? "", release.ref ?? "", release.trigger].some((value) => value.toLowerCase().includes(q));
  });
}

export function tabCounts(releases: Release[]): Record<PipelineTab, number> {
  return {
    all: releases.length,
    active: releases.filter((r) => TAB_STATUSES.active.includes(r.status)).length,
    succeeded: releases.filter((r) => r.status === "SUCCESS").length,
    failed: releases.filter((r) => r.status === "FAILED").length,
  };
}
