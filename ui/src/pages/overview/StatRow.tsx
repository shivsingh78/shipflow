import { AppWindow, LoaderCircle, TrendingUp, TriangleAlert } from "lucide-react";
import type { Release } from "@/api/types";
import { Skeleton } from "@/components/ui";
import { summarizeReleases } from "@/lib/derive";
import { pluralize } from "@/lib/format";
import { HEALTH_WINDOW, releaseMetrics } from "./health";

/** The four headline numbers (Flowstep reference), each from real release/project records. */
export function StatRow({ releases, applications, loading }: { releases: Release[]; applications: number | undefined; loading: boolean }) {
  const window = releases.slice(0, HEALTH_WINDOW);
  const summary = summarizeReleases(window);
  const metrics = releaseMetrics(window);
  const span = `last ${pluralize(window.length, "release")}`;

  const cards = [
    { key: "apps", label: "Applications", icon: <AppWindow size={16} aria-hidden />, value: applications === undefined ? null : String(applications), hint: "registered projects", tone: "" },
    { key: "rate", label: "Success rate", icon: <TrendingUp size={16} aria-hidden />, value: metrics.successRatePct === null ? "—" : `${metrics.successRatePct}%`, hint: metrics.finished === 0 ? "no finished releases yet" : `of ${pluralize(metrics.finished, "finished release")}`, tone: "" },
    { key: "running", label: "Running builds", icon: <LoaderCircle size={16} aria-hidden />, value: `${summary.running}`, hint: summary.queued > 0 ? `${summary.queued} queued` : "right now", tone: "" },
    { key: "failed", label: "Failed deploys", icon: <TriangleAlert size={16} aria-hidden />, value: `${summary.failed}`, hint: span, tone: summary.failed > 0 ? "stat-card--alert" : "" },
  ];

  return (
    <ul className="stat-row" aria-label="Headline numbers">
      {cards.map((card) => (
        <li key={card.key} className={`card stat-card ${card.tone}`.trim()}>
          <span className="stat-card__label">{card.label}{card.icon}</span>
          <span className="stat-card__value">{loading || card.value === null ? <Skeleton width={56} height={30} /> : card.value}</span>
          <span className="stat-card__hint">{card.hint}</span>
        </li>
      ))}
    </ul>
  );
}
