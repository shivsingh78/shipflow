import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import { Badge, Banner, Button, Card, EmptyState, ErrorState, PageHeader, TableSkeleton } from "@/components/ui";
import { useReleases } from "@/data/hooks";
import { formatTime, shortSha } from "@/lib/format";
import { triggerLabel } from "@/lib/status";
import { deriveActivity, describeActivity, filterActivity, groupByDay, hasActiveRelease } from "@/lib/runs";
import type { ActivityKind } from "@/lib/runs";
import { useAutoPoll } from "../runs/useAutoPoll";
import "../runs/runs.css";

const KINDS: Array<{ value: ActivityKind; label: string }> = [
  { value: "queued", label: "Queued" },
  { value: "running", label: "Running" },
  { value: "succeeded", label: "Succeeded" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
];

const TONE = { queued: "neutral", running: "info", succeeded: "success", failed: "danger", cancelled: "warning" } as const;

export default function ActivityPage() {
  const { pollMs, sync } = useAutoPoll(10_000);
  const releases = useReleases({ limit: 200, pollMs });
  const [project, setProject] = useState("");
  const [kind, setKind] = useState<ActivityKind | "">("");

  sync(releases.data ? hasActiveRelease(releases.data.releases) : undefined);

  const all = useMemo(() => releases.data?.releases ?? [], [releases.data]);
  const projects = useMemo(() => [...new Set(all.map((r) => r.project))].sort(), [all]);
  const groups = useMemo(() => groupByDay(filterActivity(deriveActivity(all), { project, kind })), [all, project, kind]);

  return (
    <>
      <PageHeader
        title="Activity"
        description="What happened to your applications, newest first."
        actions={<Button icon={<RefreshCw size={14} aria-hidden className={releases.refreshing ? "spin" : undefined} />} onClick={() => void releases.refresh()}>Refresh</Button>}
      />
      <div style={{ marginBottom: "var(--space-4)" }}>
        <Banner tone="info" title="Derived from release records">
          ShipFlow has no separate audit log. This feed is built from the {all.length} most recent release records (up to 200): when each was queued and its current state. It does not include sign-ins, configuration edits or secret changes.
        </Banner>
      </div>

      <div className="filters" role="search" aria-label="Filter activity">
        <label className="filters__group">
          <span className="field__label">Application</span>
          <select className="select" value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">All applications</option>
            {projects.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label className="filters__group">
          <span className="field__label">Event</span>
          <select className="select" value={kind} onChange={(e) => setKind(e.target.value as ActivityKind | "")}>
            <option value="">All events</option>
            {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
        </label>
      </div>

      {releases.status === "loading" ? (
        <Card><TableSkeleton rows={8} columns={3} /></Card>
      ) : releases.status === "error" && !releases.data ? (
        <Card><ErrorState error={releases.error} onRetry={() => void releases.refresh()} title="Could not load activity" /></Card>
      ) : groups.length === 0 ? (
        <Card><EmptyState title={all.length === 0 ? "No activity yet" : "No events match these filters"} description={all.length === 0 ? "Events appear once a release is queued." : "Clear a filter to see more."} /></Card>
      ) : (
        groups.map((group) => (
          <section key={group.key} aria-label={group.label}>
            <h2 className="feed__day">{group.label}</h2>
            <Card>
              <ul className="feed">
                {group.events.map((event) => (
                  <li key={event.key}>
                    <span className="feed__time" title={event.at}>{formatTime(event.at).slice(0, 5)}</span>
                    <span className="feed__text">
                      <Link to={`/releases/${event.release.release_id}`} className="mono" style={{ fontWeight: 600 }}>{event.release.release_id}</Link>{" "}
                      <Link to={`/applications/${encodeURIComponent(event.release.project)}`}>{event.release.project}</Link>{" "}
                      {describeActivity(event)}
                      <span className="subtle"> &middot; {triggerLabel(event.release.trigger)}{event.release.commit_sha ? ` · ${shortSha(event.release.commit_sha)}` : ""}</span>
                    </span>
                    <span className="row" style={{ gap: "var(--space-1)" }}>
                      {event.rollbackEligible ? <Badge outline title="The stored artifact can be made live again from the release page">Rollback available</Badge> : null}
                      <Badge tone={TONE[event.kind]}>{KINDS.find((k) => k.value === event.kind)?.label}</Badge>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          </section>
        ))
      )}
    </>
  );
}
