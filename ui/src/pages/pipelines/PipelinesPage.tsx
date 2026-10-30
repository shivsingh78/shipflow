import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import type { Release } from "@/api/types";
import { Badge, Banner, Button, Card, CardBody, DataTable, EmptyState, ErrorState, PageHeader, SearchInput, StatusBadge, TableSkeleton, Tabs } from "@/components/ui";
import type { Column } from "@/components/ui";
import { PipelineTrack } from "@/components/releases/PipelineTrack";
import { useReleases } from "@/data/hooks";
import { releaseDurationMs } from "@/lib/derive";
import { formatDuration, pluralize, shortSha, timeAgo } from "@/lib/format";
import { PIPELINE_TABS, filterPipelines, tabCounts } from "@/lib/pipeline";
import type { PipelineTab } from "@/lib/pipeline";
import { hasActiveRelease } from "@/lib/runs";
import { stageLabel, triggerLabel } from "@/lib/status";
import { useAutoPoll } from "../runs/useAutoPoll";
import { RELEASE_LIMIT } from "../runs/RunsList";
import "./pipelines.css";

export default function PipelinesPage() {
  const { pollMs, sync } = useAutoPoll(5000);
  const releases = useReleases({ limit: RELEASE_LIMIT, pollMs });
  const [tab, setTab] = useState<PipelineTab>("all");
  const [query, setQuery] = useState("");

  sync(releases.data ? hasActiveRelease(releases.data.releases) : undefined);

  const all = useMemo(() => releases.data?.releases ?? [], [releases.data]);
  const counts = useMemo(() => tabCounts(all), [all]);
  const visible = useMemo(() => filterPipelines(all, { query, tab }), [all, query, tab]);

  const columns: Column<Release>[] = [
    { key: "release", header: "Release", cell: (r) => <Link to={`/releases/${r.release_id}`} className="mono">{r.release_id}</Link>, sort: (a, b) => a.release_id.localeCompare(b.release_id) },
    { key: "app", header: "Application", cell: (r) => <Link to={`/applications/${encodeURIComponent(r.project)}`}>{r.project}</Link>, sort: (a, b) => a.project.localeCompare(b.project) },
    { key: "pipeline", header: "Pipeline", cell: (r) => <PipelineTrack release={r} /> },
    {
      key: "status",
      header: "Status",
      cell: (r) => (
        <span className="pipelines__status">
          <StatusBadge status={r.status} />
          {r.status === "RUNNING" || r.status === "FAILED" ? <span className="muted">at {stageLabel(r.current_stage)}</span> : null}
          {r.mode === "check" ? <Badge outline title="Check runs build and test but never deploy">Check</Badge> : null}
        </span>
      ),
    },
    { key: "commit", header: "Commit", cell: (r) => <span className="mono">{shortSha(r.commit_sha)}</span> },
    { key: "trigger", header: "Trigger", cell: (r) => triggerLabel(r.trigger) },
    { key: "duration", header: "Duration", cell: (r) => formatDuration(releaseDurationMs(r)), sort: (a, b) => (releaseDurationMs(a) ?? 0) - (releaseDurationMs(b) ?? 0) },
    { key: "started", header: "Started", cell: (r) => timeAgo(r.created_at), sort: (a, b) => a.created_at.localeCompare(b.created_at) },
  ];

  return (
    <>
      <PageHeader
        title="Pipelines"
        description="Every release's journey through PREPARE, BUILD, TEST, DEPLOY, VERIFY and ACTIVATE. Open one for its stages, logs and evidence."
        actions={<Button icon={<RefreshCw size={14} aria-hidden className={releases.refreshing ? "spin" : undefined} />} onClick={() => void releases.refresh()}>Refresh</Button>}
      />

      <div className="pipelines__toolbar">
        <Tabs
          label="Filter pipelines by status"
          value={tab}
          onChange={setTab}
          items={PIPELINE_TABS.map((item) => ({ value: item.value, label: `${item.label} ${counts[item.value]}` }))}
        />
        <div className="pipelines__search">
          <SearchInput value={query} onChange={setQuery} placeholder="Release, application or commit" label="Search pipelines" />
        </div>
      </div>

      {releases.status === "error" && !releases.data ? (
        <Card><CardBody><ErrorState error={releases.error} onRetry={() => void releases.refresh()} title="Could not load pipelines" /></CardBody></Card>
      ) : releases.status === "loading" ? (
        <Card><TableSkeleton rows={8} columns={6} /></Card>
      ) : (
        <>
          <div className="list-meta" aria-live="polite">
            <span>{visible.length === all.length ? pluralize(all.length, "pipeline") : `${visible.length} of ${pluralize(all.length, "pipeline")}`}</span>
            {counts.active > 0 ? <span>{counts.active} in progress: refreshing every 5s</span> : null}
          </div>
          {all.length >= RELEASE_LIMIT ? (
            <div className="pipelines__note"><Banner tone="info">The API returns at most the {RELEASE_LIMIT} newest releases, so older pipelines are not shown.</Banner></div>
          ) : null}
          <Card>
            <DataTable
              caption="Pipelines"
              rows={visible}
              columns={columns}
              rowKey={(r) => r.release_id}
              initialSort={{ key: "started", direction: "desc" }}
              empty={<EmptyState title={all.length === 0 ? "No pipelines yet" : "Nothing matches"} description={all.length === 0 ? "A pipeline appears as soon as a release is queued from the dashboard, the CLI or a Git webhook." : "Try another status or clear the search."} />}
            />
          </Card>
          <p className="muted pipelines__foot">Stage status is taken from each release record. ShipFlow does not store per-stage timings, so none are shown.</p>
        </>
      )}
    </>
  );
}
