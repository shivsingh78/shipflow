import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import type { Release } from "@/api/types";
import { Skeleton } from "@/components/ui";
import { summarizeReleases } from "@/lib/derive";
import { formatDuration, pluralize } from "@/lib/format";
import { statusMeta } from "@/lib/status";
import { healthBars, HEALTH_WINDOW, releaseMetrics } from "./health";

interface DeployHealthProps {
  releases: Release[];
  loading: boolean;
}

/** Bar chart of the latest releases plus three derived numbers, all from real release records. */
export function DeployHealth({ releases, loading }: DeployHealthProps) {
  const window = releases.slice(0, HEALTH_WINDOW);
  const bars = healthBars(releases);
  const summary = summarizeReleases(window);
  const metrics = releaseMetrics(window);
  const label = `last ${pluralize(window.length, "release")}`;

  return (
    <section className="card health" aria-labelledby="health-title">
      <header className="health__head">
        <div>
          <h2 className="card__title" id="health-title">Deployment pulse</h2>
          <p className="card__sub">{label[0]?.toUpperCase()}{label.slice(1)}</p>
        </div>
        <Link to="/build-runs" className="link-accent">
          Build runs <ArrowRight size={13} aria-hidden />
        </Link>
      </header>

      <div className="health__chart" role="img" aria-label={`${pluralize(summary.succeeded, "release")} succeeded and ${summary.failed} failed in the ${label}`}>
        {loading ? (
          <Skeleton height={72} />
        ) : bars.length === 0 ? (
          <p className="muted health__empty">No releases yet.</p>
        ) : (
          <div className="bars" aria-hidden>
            {/* Faint slots keep the chart's 45-bar rhythm when there is less history: no data, not zero. */}
            {Array.from({ length: Math.max(0, HEALTH_WINDOW - bars.length) }, (_, slot) => (
              <span key={`empty-${slot}`} className="bar bar--empty" />
            ))}
            {bars.map((bar) => (
              <span
                key={bar.id}
                className={`bar bar--${bar.status.toLowerCase()}`}
                style={{ height: `${bar.heightPct}%` }}
                title={`${bar.id} · ${statusMeta(bar.status).label}${bar.durationMs !== null ? ` · ${formatDuration(bar.durationMs)}` : ""}`}
              />
            ))}
          </div>
        )}
      </div>

      <dl className="health__stats health__stats--mini">
        <div className="health__stat">
          <dt>Median duration</dt>
          <dd className="health__value mono">{loading ? <Skeleton width={44} height={22} /> : formatDuration(metrics.medianDurationMs)}</dd>
        </div>
        <div className="health__stat">
          <dt>Throughput</dt>
          <dd className="health__value mono">{loading ? <Skeleton width={44} height={22} /> : metrics.throughputPerDay === null ? "—" : `${metrics.throughputPerDay}/day`}</dd>
        </div>
        <div className="health__stat">
          <dt>Error rate</dt>
          <dd className={`health__value mono${(metrics.errorRatePct ?? 0) > 0 ? " health__value--failed" : ""}`}>{loading ? <Skeleton width={44} height={22} /> : metrics.errorRatePct === null ? "—" : `${metrics.errorRatePct}%`}</dd>
        </div>
      </dl>
      <p className="muted health__foot">Derived from release history · {label}</p>
    </section>
  );
}
