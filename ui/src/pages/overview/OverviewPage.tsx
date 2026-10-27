import { useMemo } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, Boxes, CheckCircle2, Loader2, Plus, RefreshCw, XCircle } from "lucide-react";
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, ErrorState, LinkButton, PageHeader, Skeleton, Stat, TableSkeleton } from "@/components/ui";
import { ReleaseTable } from "@/components/releases/ReleaseTable";
import { useProjectDetails, useProjects, useReadiness, useReleases } from "@/data/hooks";
import { formatTime, timeAgo } from "@/lib/format";
import { summarizeReleases } from "@/lib/derive";
import { deriveActivity, describeActivity, detailText, hasActiveRelease } from "@/lib/runs";
import { useAutoPoll } from "../runs/useAutoPoll";
import { applicationsNeedingAttention } from "./attention";
import { Onboarding } from "./Onboarding";
import { QuickDeploy } from "./QuickDeploy";
import "../runs/runs.css";

const READY_LABEL: Record<string, string> = { database: "Database", queue: "Queue", "artifact store": "Artifact store", workers: "Workers", "secret storage": "Secret storage" };

export default function OverviewPage() {
  const { pollMs, sync } = useAutoPoll(15_000);
  const projects = useProjects();
  const releases = useReleases({ limit: 200, pollMs });
  const readiness = useReadiness();
  const details = useProjectDetails();

  sync(releases.data ? hasActiveRelease(releases.data.releases) : undefined);

  const list = useMemo(() => releases.data?.releases ?? [], [releases.data]);
  const summary = useMemo(() => summarizeReleases(list), [list]);
  const attention = useMemo(() => applicationsNeedingAttention(details.data ?? [], list), [details.data, list]);
  const activity = useMemo(() => deriveActivity(list).slice(0, 8), [list]);
  const names = useMemo(() => (projects.data ?? []).map((p) => p.name), [projects.data]);

  const refreshAll = () => void Promise.all([projects.refresh(), releases.refresh(), readiness.refresh(), details.refresh()]);
  const refreshing = projects.refreshing || releases.refreshing || readiness.refreshing;
  const loading = projects.status === "loading" || releases.status === "loading";
  const failed = (projects.status === "error" && !projects.data) || (releases.status === "error" && !releases.data);
  const empty = !loading && !failed && (projects.data?.length ?? 0) === 0 && list.length === 0;
  const updated = Math.max(releases.updatedAt ?? 0, projects.updatedAt ?? 0);
  const windowLabel = `last ${list.length} ${list.length === 1 ? "release" : "releases"}`;

  return (
    <>
      <PageHeader
        title="Overview"
        description={
          <>
            Operational summary of this ShipFlow instance.
            {updated ? <span className="subtle"> Updated {timeAgo(new Date(updated).toISOString())}{summary.running + summary.queued > 0 ? ", auto-refreshing every 15s while releases are running" : ""}.</span> : null}
          </>
        }
        actions={
          <>
            <Button icon={<RefreshCw size={14} aria-hidden className={refreshing ? "spin" : undefined} />} onClick={refreshAll}>Refresh</Button>
            <QuickDeploy projects={names} />
            <LinkButton to="/applications/new" variant="primary" icon={<Plus size={14} aria-hidden />}>New application</LinkButton>
          </>
        }
      />

      {failed ? (
        <Card><ErrorState error={projects.error ?? releases.error} onRetry={refreshAll} title="Could not load the dashboard" /></Card>
      ) : empty ? (
        <Onboarding />
      ) : (
        <div className="stack">
          <div className="grid grid--4">
            <Stat label="Applications" value={projects.data?.length ?? 0} loading={projects.status === "loading"} icon={<Boxes size={14} aria-hidden />} hint="Registered projects" />
            <Stat label="Successful builds" value={summary.succeeded} loading={loading} icon={<CheckCircle2 size={14} aria-hidden />} hint={windowLabel} />
            <Stat label="Failed builds" value={summary.failed} loading={loading} icon={<XCircle size={14} aria-hidden />} hint={windowLabel} />
            <Stat label="Running / queued" value={`${summary.running} / ${summary.queued}`} loading={loading} icon={<Loader2 size={14} aria-hidden />} hint="Right now" />
          </div>

          <div className="overview-grid">
            <Card>
              <CardHeader title="Recent builds & deployments" actions={<Link to="/build-runs">View all</Link>} />
              {loading ? (
                <TableSkeleton rows={5} columns={5} />
              ) : (
                <ReleaseTable releases={list} variant="compact" pageSize={8} caption="Recent builds and deployments" empty={<EmptyState title="No releases yet" description="Deploy an application to see it here." />} />
              )}
            </Card>

            <div className="overview-side">
              <Card>
                <CardHeader title="Needs attention" description="Failed latest release or missing secrets" />
                <CardBody>
                  {details.status === "loading" || releases.status === "loading" ? (
                    <Skeleton height={48} />
                  ) : attention.length === 0 ? (
                    <p className="muted">Nothing needs attention.</p>
                  ) : (
                    <ul className="plain-list attention">
                      {attention.map((item) => (
                        <li key={item.project}>
                          <AlertTriangle size={14} aria-hidden style={{ color: "var(--warning)" }} />
                          <Link to={`/applications/${encodeURIComponent(item.project)}`} style={{ fontWeight: 600 }}>{item.project}</Link>
                          <span className="muted" style={{ flexBasis: "100%", fontSize: "var(--text-sm)" }}>
                            {item.reasons.join(" · ")}
                            {item.failedReleaseId ? <> (<Link to={`/releases/${item.failedReleaseId}`}>details</Link>)</> : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardBody>
              </Card>

              <Card>
                <CardHeader title="System readiness" actions={readiness.data ? <Badge tone={readiness.data.ok ? "success" : "danger"}>{readiness.data.ok ? "Ready" : "Degraded"}</Badge> : null} />
                <CardBody>
                  {readiness.status === "loading" ? (
                    <Skeleton height={80} />
                  ) : readiness.status === "error" && !readiness.data ? (
                    <ErrorState error={readiness.error} onRetry={() => void readiness.refresh()} title="Readiness unavailable" />
                  ) : (
                    <ul className="plain-list">
                      {(readiness.data?.checks ?? []).map((c) => (
                        <li key={c.name} className="row" style={{ alignItems: "flex-start", padding: "var(--space-1) 0" }}>
                          {c.ok ? <CheckCircle2 size={15} aria-hidden style={{ color: "var(--success)", flex: "none", marginTop: 2 }} /> : <XCircle size={15} aria-hidden style={{ color: "var(--danger)", flex: "none", marginTop: 2 }} />}
                          <span className="grow">
                            <strong>{READY_LABEL[c.name] ?? c.name}</strong> <span className="sr-only">{c.ok ? "ok" : "failing"}</span>
                            <span className="muted" style={{ display: "block", fontSize: "var(--text-xs)", overflowWrap: "anywhere" }}>{detailText(c.detail)}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardBody>
              </Card>

              <Card>
                <CardHeader title="Recent activity" description="Derived from release records" actions={<Link to="/activity">View all</Link>} />
                <CardBody>
                  {activity.length === 0 ? (
                    <p className="muted">No activity yet.</p>
                  ) : (
                    <ul className="plain-list stack--sm" style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
                      {activity.map((e) => (
                        <li key={e.key} style={{ fontSize: "var(--text-sm)" }}>
                          <span className="subtle">{formatTime(e.at).slice(0, 5)}</span>{" "}
                          <Link to={`/releases/${e.release.release_id}`} className="mono">{e.release.release_id}</Link>{" "}
                          <span className="muted">{e.release.project} {describeActivity(e)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardBody>
              </Card>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
