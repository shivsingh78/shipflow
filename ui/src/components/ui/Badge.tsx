import type { ReactNode } from "react";
import type { ReleaseStatus } from "@/api/types";
import { statusMeta, targetLabel } from "@/lib/status";
import type { Tone } from "@/lib/status";

export function Badge({ tone = "neutral", outline = false, children, title }: { tone?: Tone; outline?: boolean; children: ReactNode; title?: string }) {
  return (
    <span className={["badge", tone !== "neutral" ? `badge--${tone}` : "", outline ? "badge--outline" : ""].filter(Boolean).join(" ")} title={title}>
      {children}
    </span>
  );
}

/** Release status with a state dot; running releases pulse. */
export function StatusBadge({ status }: { status: ReleaseStatus }) {
  const { label, tone } = statusMeta(status);

  return (
    <Badge tone={tone}>
      <span className={`dot${status === "RUNNING" ? " dot--pulse" : ""}`} aria-hidden />
      {label}
    </Badge>
  );
}

export function TargetBadge({ target }: { target: string }) {
  return <Badge outline>{targetLabel(target)}</Badge>;
}
