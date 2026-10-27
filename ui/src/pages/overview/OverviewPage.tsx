import { useMemo } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, RefreshCw, Plus } from "lucide-react";
import { Card, EmptyState, ErrorState, IconButton, LinkButton, PageHeader, TableSkeleton } from "@/components/ui";
import { ReleaseTable } from "@/components/releases/ReleaseTable";
import { useProjectDetails, useProjects, useReadiness, useReleases, useWhoAmI } from "@/data/hooks";
import { timeAgo } from "@/lib/format";
import { hasActiveRelease } from "@/lib/runs";
import { useAutoPoll } from "../runs/useAutoPoll";
import { applicationsNeedingAttention } from "./attention";
import { AttentionCard } from "./AttentionCard";
import { DeployHealth } from "./DeployHealth";
import { Onboarding } from "./Onboarding";
import { QuickDeploy } from "./QuickDeploy";
import { ReadinessCard } from "./ReadinessCard";
import "../runs/runs.css";
import "./overview.css";

export default function OverviewPage() {
  const { pollMs, sync } = useAutoPoll(15_000);
  const whoami = useWhoAmI();
  const projects = useProjects();
  const releases = useReleases({ limit: 200, pollMs });
  const readiness = useReadiness();
  const details = useProjectDetails();

  sync(releases.data ? hasActiveRelease(releases.data.releases) : undefined);

  const list = useMemo(() => releases.data?.releases ?? [], [releases.data]);
  const attention = useMemo(() => applicationsNeedingAttention(details.data ?? [], list), [details.data, list]);
  const names = useMemo(() => (projects.data ?? []).map((p) => p.name), [projects.data]);

  const refreshAll = () => void Promise.all([projects.refresh(), releases.refresh(), readiness.refresh(), details.refresh()]);
  const refreshing = projects.refreshing || releases.refreshing || readiness.refreshing;
  const loading = projects.status === "loading" || releases.status === "loading";
  const failed = (projects.status === "error" && !projects.data) || (releases.status === "error" && !releases.data);
  const empty = !loading && !failed && (projects.data?.length ?? 0) === 0 && list.length === 0;
  const updated = Math.max(releases.updatedAt ?? 0, projects.updatedAt ?? 0);
  const instance = whoami.data?.instance;

  return (
    <>
      <PageHeader
        eyebrow={`${instance ?? "this instance"} · self-hosted`}
        title="Overview"
        description={`Operational summary of this ShipFlow instance.${updated ? ` Updated ${timeAgo(new Date(updated).toISOString())}.` : ""}`}
        actions={
          <>
            <IconButton label={refreshing ? "Refreshing" : "Refresh"} onClick={refreshAll} className="icon-btn icon-btn--box">
              <RefreshCw size={15} aria-hidden className={refreshing ? "spin" : undefined} />
            </IconButton>
            <QuickDeploy projects={names} />
            <LinkButton to="/applications/new" variant="primary" icon={<Plus size={15} aria-hidden />}>New application</LinkButton>
          </>
        }
      />

      {failed ? (
        <Card><ErrorState error={projects.error ?? releases.error} onRetry={refreshAll} title="Could not load the dashboard" /></Card>
      ) : empty ? (
        <Onboarding />
      ) : (
        <div className="overview-grid">
          <div className="overview-main">
            <DeployHealth releases={list} applications={projects.data?.length} loading={loading} />

            <section className="card" aria-labelledby="recent-title">
              <header className="card__header">
                <div>
                  <h2 className="card__title" id="recent-title">Recent builds &amp; deployments</h2>
                  <p className="card__sub">The latest releases across all applications</p>
                </div>
                <Link to="/build-runs" className="link-accent">View all <ArrowRight size={13} aria-hidden /></Link>
              </header>
              {loading ? (
                <TableSkeleton rows={5} columns={5} />
              ) : (
                <div className="compact-releases">
                  <ReleaseTable releases={list.slice(0, 8)} variant="compact" pageSize={8} caption="Recent builds and deployments" empty={<EmptyState title="No releases yet" description="Deploy an application to see it here." />} />
                </div>
              )}
            </section>
          </div>

          <div className="overview-side">
            <AttentionCard items={attention} loading={details.status === "loading" || releases.status === "loading"} />
            <ReadinessCard readiness={readiness.data} status={readiness.status} error={readiness.error} onRetry={() => void readiness.refresh()} />
          </div>
        </div>
      )}
    </>
  );
}
