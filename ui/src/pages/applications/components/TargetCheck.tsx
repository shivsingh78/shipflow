import { useState } from "react";
import { CheckCircle2, Stethoscope, XCircle } from "lucide-react";
import { describeError } from "@/api/errors";
import type { CheckResult } from "@/api/types";
import { useApi } from "@/auth/AuthProvider";
import { Banner, Button } from "@/components/ui";

const detailText = (detail: unknown): string => (typeof detail === "string" ? detail : detail === undefined || detail === null ? "" : JSON.stringify(detail));

export function CheckList({ checks }: { checks: CheckResult[] }) {
  return (
    <ul className="check-list" aria-label="Target check results">
      {checks.map((c) => (
        <li key={c.name}>
          {c.ok ? <CheckCircle2 size={16} aria-hidden style={{ color: "var(--success)", flex: "none", marginTop: 2 }} /> : <XCircle size={16} aria-hidden style={{ color: "var(--danger)", flex: "none", marginTop: 2 }} />}
          <div>
            <strong>{c.name}</strong> <span className="sr-only">{c.ok ? "passed" : "failed"}</span>
            {detailText(c.detail) ? <div className="detail">{detailText(c.detail)}</div> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Runs the deployment target's own read-only diagnostics, only when the user asks. */
export function TargetCheckPanel({ project }: { project: string }) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; checks: CheckResult[]; at: Date } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);

    try {
      setResult({ ...(await api.checkProject(project)), at: new Date() });
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div>
        <Button onClick={() => void run()} loading={busy} icon={<Stethoscope size={14} aria-hidden />}>Run target check</Button>
      </div>
      {error ? <Banner tone="danger" title="The target check could not run">{error}</Banner> : null}
      {result ? (
        <>
          <Banner tone={result.ok ? "success" : "danger"} title={result.ok ? "The target answered all checks" : "Some target checks failed"}>
            Read-only diagnostics run at {result.at.toLocaleTimeString()}. They do not deploy anything.
          </Banner>
          <CheckList checks={result.checks} />
        </>
      ) : null}
    </div>
  );
}
