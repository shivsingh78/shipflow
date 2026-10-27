import { Link, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { ApiError } from "@/api/errors";
import type { Evidence, Release } from "@/api/types";
import { Badge, Banner, Button, Card, CardBody, CardHeader, EmptyState, ErrorState, LinkButton, PageHeader, PipelineSteps, Skeleton, StatusBadge, Tabs } from "@/components/ui";
import { CancelReleaseButton, DeployButton, RollbackButton } from "@/components/releases/ReleaseActions";
import { LogViewer } from "@/components/logs/LogViewer";
import { useEvidence, useRelease } from "@/data/hooks";
import { formatDateTime, timeAgo } from "@/lib/format";
import { isActiveStatus, stageLabel } from "@/lib/status";
import { ArtifactCard, BuildCard, DeploymentCard, SourceCard } from "./ReleaseBreakdown";
import { useAutoPoll } from "./useAutoPoll";
import "./runs.css";

type Tab = "overview" | "logs" | "evidence";

function FailurePanel({ evidence }: { evidence: Evidence }) {
  if (!evidence.failure && !evidence.diagnosis) return null;

  return (
    <Banner tone="danger" title={`Failed at ${stageLabel(evidence.failure?.stage ?? evidence.stage)}${evidence.diagnosis ? `: ${evidence.diagnosis.category}` : ""}`}>
      {evidence.diagnosis ? <p style={{ margin: "0 0 4px" }}>{evidence.diagnosis.summary}</p> : null}
      {evidence.failure ? <p className="mono" style={{ margin: "0 0 4px", overflowWrap: "anywhere" }}>{evidence.failure.message}</p> : null}
      {evidence.diagnosis && evidence.diagnosis.suggestions.length > 0 ? (
        <ul style={{ margin: 0, paddingLeft: "1.2em" }}>
          {evidence.diagnosis.suggestions.map((s) => <li key={s}>{s}</li>)}
        </ul>
      ) : null}
    </Banner>
  );
}

function EvidenceTab({ evidence, loading, error, retry }: { evidence: Evidence | undefined; loading: boolean; error: unknown; retry: () => void }) {
  if (error && !evidence) return <ErrorState error={error} onRetry={retry} title="Could not load evidence" />;
  if (loading || !evidence) return <Skeleton height={120} />;

  return (
    <div className="stack">
      <FailurePanel evidence={evidence} />
      <Card>
        <CardHeader title="Stage timeline" description="Recorded from the release's log rows: when each stage was first and last seen, and how many errors and warnings it logged." />
        <CardBody>
          {evidence.timeline.length === 0 ? (
            <p className="muted">No stages have logged anything yet.</p>
          ) : (
            <ol className="timeline">
              {evidence.timeline.map((t) => (
                <li key={t.stage}>
                  <strong>{stageLabel(t.stage)}</strong>
                  <span className="muted">{formatDateTime(t.startedAt)}{t.lastAt && t.lastAt !== t.startedAt ? ` to ${formatDateTime(t.lastAt)}` : ""}</span>
                  <span className="row" style={{ gap: "var(--space-1)" }}>
                    <Badge tone={t.errors > 0 ? "danger" : "neutral"}>{t.errors} {t.errors === 1 ? "error" : "errors"}</Badge>
                    <Badge tone={t.warnings > 0 ? "warning" : "neutral"}>{t.warnings} {t.warnings === 1 ? "warning" : "warnings"}</Badge>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function Loaded({ release, refresh, refreshing, updatedAt }: { release: Release; refresh: () => Promise<void>; refreshing: boolean; updatedAt: number | null }) {
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab");
  const tab: Tab = requested === "logs" || requested === "evidence" ? requested : "overview";
  const evidence = useEvidence(release.release_id, { enabled: release.status !== "QUEUED", pollMs: isActiveStatus(release.status) ? 5000 : false });
  const failed = release.status === "FAILED";
  const redeployRef = release.commit_sha ?? release.ref ?? undefined;

  const setTab = (next: Tab) => setParams(next === "overview" ? {} : { tab: next }, { replace: true });

  return (
    <>
      <PageHeader
        title={<span className="row row--wrap" style={{ gap: "var(--space-3)" }}><span className="mono">{release.release_id}</span><StatusBadge status={release.status} />{release.is_active ? <Badge tone="success" outline>Live</Badge> : null}</span>}
        description={<>Release of <Link to={`/applications/${encodeURIComponent(release.project)}`}>{release.project}</Link> &middot; {release.mode === "check" ? "check run (no deploy)" : "deployment"} &middot; queued {timeAgo(release.created_at)}</>}
        actions={
          <>
            <Button variant="ghost" aria-label="Refresh release" icon={<RefreshCw size={14} aria-hidden className={refreshing ? "spin" : undefined} />} onClick={() => void refresh()} />
            <CancelReleaseButton release={release} onDone={() => void refresh()} />
            <RollbackButton release={release} onDone={() => void refresh()} />
            <DeployButton project={release.project} {...(redeployRef ? { defaultRef: redeployRef } : {})} label="Redeploy" variant="secondary" />
          </>
        }
      />

      {isActiveStatus(release.status) ? (
        <div style={{ marginBottom: "var(--space-4)" }}>
          <Banner tone="info">This release is {release.status === "QUEUED" ? "waiting for a worker" : `running (${stageLabel(release.current_stage)})`}. The page auto-refreshes every 3s{updatedAt ? `, last at ${new Date(updatedAt).toLocaleTimeString()}` : ""}.</Banner>
        </div>
      ) : null}

      <Card className="pipeline-card">
        <CardBody>
          <PipelineSteps status={release.status} stage={release.current_stage} mode={release.mode} />
        </CardBody>
      </Card>

      <Tabs<Tab>
        label="Release sections"
        value={tab}
        onChange={setTab}
        items={[
          { value: "overview", label: "Overview" },
          { value: "logs", label: "Logs" },
          { value: "evidence", label: "Evidence" },
        ]}
      />

      {tab === "overview" ? (
        <div className="stack">
          {failed ? (
            evidence.data ? <FailurePanel evidence={evidence.data} /> : release.error_message ? <Banner tone="danger" title={`Failed at ${stageLabel(release.current_stage)}`}><span className="mono">{release.error_message}</span></Banner> : null
          ) : null}
          <div className="breakdown">
            <BuildCard release={release} />
            <ArtifactCard release={release} />
            <DeploymentCard release={release} />
            <SourceCard release={release} />
          </div>
        </div>
      ) : tab === "logs" ? (
        <LogViewer releaseId={release.release_id} />
      ) : (
        <EvidenceTab evidence={evidence.data} loading={evidence.status === "loading"} error={evidence.error} retry={() => void evidence.refresh()} />
      )}
    </>
  );
}

export default function ReleaseDetailPage() {
  const { releaseId = "" } = useParams();
  const { pollMs, sync } = useAutoPoll(3000);
  const release = useRelease(releaseId, { pollMs });

  sync(release.data ? isActiveStatus(release.data.status) : undefined);

  if (release.status === "loading") {
    return (
      <div className="stack" role="status" aria-label="Loading release">
        <Skeleton height={32} width={280} />
        <Skeleton height={64} />
        <Skeleton height={220} />
      </div>
    );
  }

  if (release.error && !release.data) {
    const notFound = release.error instanceof ApiError && release.error.status === 404;

    return notFound ? (
      <EmptyState
        title="Release not found"
        description={<>There is no release with id <code>{releaseId}</code>. It may have been removed, or the link is wrong.</>}
        action={<LinkButton to="/build-runs" icon={<ArrowLeft size={14} aria-hidden />}>Back to build runs</LinkButton>}
      />
    ) : (
      <ErrorState error={release.error} onRetry={() => void release.refresh()} title="Could not load this release" />
    );
  }

  if (!release.data) return null;

  return <Loaded release={release.data} refresh={release.refresh} refreshing={release.refreshing} updatedAt={release.updatedAt} />;
}
