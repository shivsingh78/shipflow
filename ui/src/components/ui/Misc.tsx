import type { ReactNode } from "react";
import { Check, Minus, X } from "lucide-react";
import { Skeleton } from "./States";
import type { ReleaseStage, ReleaseStatus } from "@/api/types";
import { STAGES } from "@/api/types";
import { stageLabel } from "@/lib/status";

export function Stat({ label, value, hint, icon, loading = false }: { label: string; value: ReactNode; hint?: ReactNode; icon?: ReactNode; loading?: boolean }) {
  return (
    <div className="card stat">
      <div className="stat__label">
        {icon}
        {label}
      </div>
      <div className="stat__value">{loading ? <Skeleton width={56} height={28} /> : value}</div>
      {hint ? <div className="stat__hint">{hint}</div> : null}
    </div>
  );
}

export function KeyValue({ items }: { items: Array<{ label: ReactNode; value: ReactNode }> }) {
  return (
    <dl className="kv">
      {items.map((item, index) => (
        <div key={index} style={{ display: "contents" }}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

type StepState = "pending" | "running" | "done" | "failed" | "skipped";

/**
 * The pipeline as ShipFlow actually runs it. `mode: "check"` stops after TEST,
 * so later stages are shown as skipped rather than pending.
 */
export function PipelineSteps({ status, stage, mode }: { status: ReleaseStatus; stage: ReleaseStage; mode: "deploy" | "check" }) {
  const stages = STAGES;
  const index = stages.indexOf(stage);

  const stateOf = (name: ReleaseStage, i: number): StepState => {
    if (mode === "check" && i > stages.indexOf("TEST")) return "skipped";
    if (status === "QUEUED" || index === -1) return "pending";
    if (status === "SUCCESS") return "done";
    if (i < index) return "done";
    if (i === index) return status === "FAILED" ? "failed" : status === "CANCELLED" ? "skipped" : "running";

    return name === stage ? "running" : "pending";
  };

  return (
    <ol className="pipeline" aria-label="Pipeline stages" style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {stages.map((name, i) => {
        const state = stateOf(name, i);

        return (
          <li key={name} className="pipeline__step" data-state={state}>
            <span className="pipeline__node">
              {state === "done" ? <Check size={14} aria-hidden /> : state === "failed" ? <X size={14} aria-hidden /> : state === "skipped" ? <Minus size={14} aria-hidden /> : state === "running" ? <span className="dot dot--pulse" aria-hidden /> : <span className="sr-only">pending</span>}
            </span>
            <span className="pipeline__label">{stageLabel(name)}</span>
            <span className="sr-only">{state}</span>
          </li>
        );
      })}
    </ol>
  );
}
