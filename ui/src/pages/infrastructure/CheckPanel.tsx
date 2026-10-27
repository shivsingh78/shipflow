import { CheckCircle2, XCircle } from "lucide-react";
import { describeError } from "@/api/errors";
import { Spinner } from "@/components/ui";
import type { CheckState } from "./useChecks";
import { detailText } from "./model";

export const clock = (d: Date): string => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Renders one on-demand check result: loading, error, or each check with an ok/fail icon. */
export function CheckPanel({ state }: { state: CheckState | undefined }) {
  if (!state) return null;

  if (state.status === "running") return <Spinner label="Running check…" />;

  if (state.status === "error") {
    return (
      <div className="infra-check" role="alert">
        <p className="infra-check__fail">
          <XCircle size={16} aria-hidden /> Check could not run: {describeError(state.error)}
        </p>
        <p className="muted infra-check__meta">Checked at {clock(state.at)} (this session) via {state.project}</p>
      </div>
    );
  }

  return (
    <div className="infra-check" role="status">
      <ul className="infra-check__list">
        {state.checks.map((check) => (
          <li key={check.name} className={check.ok ? "infra-check__ok" : "infra-check__fail"}>
            {check.ok ? <CheckCircle2 size={16} aria-label="passed" /> : <XCircle size={16} aria-label="failed" />}
            <span className="infra-check__name">{check.name}</span>
            <span className="muted infra-check__detail">{detailText(check.detail)}</span>
          </li>
        ))}
      </ul>
      <p className="muted infra-check__meta">
        {state.ok ? "All checks passed." : "Some checks failed."} Checked at {clock(state.at)} (this session) via {state.project}. Not monitored: run it again to refresh.
      </p>
    </div>
  );
}
