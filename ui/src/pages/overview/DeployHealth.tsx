import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import type { Release } from "@/api/types";
import { Skeleton } from "@/components/ui";
import { summarizeReleases } from "@/lib/derive";
import { formatDuration, pluralize } from "@/lib/format";
import { statusMeta } from "@/lib/status";
import { healthBars, HEALTH_WINDOW } from "./health";

interface DeployHealthProps {
  releases: Release[];
  applications: number | undefined;
  loading: boolean;
}

/** Bar chart of the latest releases plus the four headline numbers, all from real release records. */
export function DeployHealth({ releases, applications, loading }: DeployHealthProps) {
  const window = releases.slice(0, HEALTH_WINDOW);
  const bars = healthBars(releases);
  const summary = summarizeReleases(window);
  const label = `last ${pluralize(window.length, "release")}`;

  return (
    <section className="card health" aria-labelledby="health-title">
      <header className="health__head">
        <div>
          <h2 className="card__title" id="health-title">Deploy health</h2>
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

      <dl className="health__stats">
        <div className="health__stat">
          <dt className="label-caps">Applications</dt>
          <dd className="health__value">{loading || applications === undefined ? <Skeleton width={28} height={26} /> : applications}</dd>
          <dd className="health__hint">registered projects</dd>
        </div>
        <div className="health__stat">
          <dt className="label-caps">Successful builds</dt>
          <dd className="health__value">{loading ? <Skeleton width={28} height={26} /> : summary.succeeded}</dd>
          <dd className="health__hint">{label}</dd>
        </div>
        <div className="health__stat">
          <dt className="label-caps">Failed builds</dt>
          <dd className={`health__value${summary.failed > 0 ? " health__value--failed" : ""}`}>{loading ? <Skeleton width={28} height={26} /> : summary.failed}</dd>
          <dd className="health__hint">{label}</dd>
        </div>
        <div className="health__stat">
          <dt className="label-caps">Running / queued</dt>
          <dd className="health__value">{loading ? <Skeleton width={44} height={26} /> : `${summary.running} / ${summary.queued}`}</dd>
          <dd className="health__hint">right now</dd>
        </div>
      </dl>
    </section>
  );
}
