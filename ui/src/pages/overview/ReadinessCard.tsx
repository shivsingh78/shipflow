import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { Readiness } from "@/api/types";
import { ErrorState, Skeleton } from "@/components/ui";
import { detailText } from "@/lib/runs";

interface ReadinessCardProps {
  readiness: Readiness | undefined;
  status: "loading" | "ready" | "error";
  error: unknown;
  onRetry: () => void;
}

/** The API's own readiness checks, verbatim. */
export function ReadinessCard({ readiness, status, error, onRetry }: ReadinessCardProps) {
  return (
    <section className="card readiness" aria-labelledby="readiness-title">
      <header className="readiness__head">
        <h2 className="card__title" id="readiness-title">System readiness</h2>
        {readiness ? <span className={`badge badge--${readiness.ok ? "success" : "danger"}`}>{readiness.ok ? "Ready" : "Degraded"}</span> : null}
      </header>

      {status === "loading" ? <Skeleton height={96} /> : null}
      {status === "error" && !readiness ? <ErrorState error={error} onRetry={onRetry} title="Readiness unavailable" /> : null}

      <ul className="readiness__list">
        {(readiness?.checks ?? []).map((check) => (
          <li key={check.name} className="readiness__item">
            {check.ok ? <CheckCircle2 size={16} aria-hidden className="readiness__ok" /> : <AlertTriangle size={16} aria-hidden className="readiness__bad" />}
            <div className="grow">
              <span className="readiness__name">{check.name}</span>
              <span className="sr-only">{check.ok ? " ok" : " failing"}</span>
              <span className="readiness__detail">{detailText(check.detail)}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
