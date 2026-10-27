import type { Release, ReleaseStage, ReleaseStatus } from "@/api/types";

export type Tone = "success" | "danger" | "warning" | "info" | "neutral";

export interface StatusMeta {
  label: string;
  tone: Tone;
}

const STATUS: Record<ReleaseStatus, StatusMeta> = {
  SUCCESS: { label: "Succeeded", tone: "success" },
  FAILED: { label: "Failed", tone: "danger" },
  RUNNING: { label: "Running", tone: "info" },
  QUEUED: { label: "Queued", tone: "neutral" },
  CANCELLED: { label: "Cancelled", tone: "warning" },
};

export const statusMeta = (status: ReleaseStatus): StatusMeta => STATUS[status] ?? { label: status, tone: "neutral" };

export const isActiveStatus = (status: ReleaseStatus): boolean => status === "QUEUED" || status === "RUNNING";

export const STAGE_LABEL: Record<ReleaseStage, string> = {
  RELEASE: "Queued",
  PREPARE: "Prepare",
  BUILD: "Build",
  TEST: "Test",
  DEPLOY: "Deploy",
  VERIFY: "Verify",
  ACTIVATE: "Activate",
};

export const stageLabel = (stage: string): string => STAGE_LABEL[stage as ReleaseStage] ?? stage;

/** Human text for what triggered a release. */
export function triggerLabel(trigger: string): string {
  switch (trigger) {
    case "webhook":
      return "Git push / PR";
    case "cli":
      return "CLI";
    case "dashboard":
      return "Dashboard";
    default:
      return trigger;
  }
}

export const modeLabel = (mode: Release["mode"]): string => (mode === "check" ? "Check (no deploy)" : "Deploy");

export const TARGET_LABEL: Record<string, string> = {
  shipflow: "ShipFlow site server",
  ssh: "SSH server (static)",
  docker: "Docker server",
  kubernetes: "Kubernetes",
};

export const targetLabel = (target: string): string => TARGET_LABEL[target] ?? target;

export const isImageTarget = (target: string): boolean => target === "docker" || target === "kubernetes";
