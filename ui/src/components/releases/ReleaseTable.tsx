import type { ReactNode } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Box, FileText, GitBranch } from "lucide-react";
import type { Release } from "@/api/types";
import { Badge, DataTable, StatusBadge, TargetBadge } from "@/components/ui";
import type { Column } from "@/components/ui";
import { releaseDurationMs } from "@/lib/derive";
import { formatDuration, formatBytes, shortDigest, shortSha, timeAgo } from "@/lib/format";
import { stageLabel, triggerLabel } from "@/lib/status";

export type ReleaseTableVariant = "compact" | "builds" | "deployments";

interface ReleaseTableProps {
  releases: Release[];
  variant: ReleaseTableVariant;
  /** Show the application column (hide it on a single application's page). */
  showProject?: boolean;
  pageSize?: number;
  empty?: ReactNode;
  caption: string;
}

const time = (r: Release) => Date.parse(r.created_at);

function ReleaseCell({ release, showProject }: { release: Release; showProject: boolean }) {
  return (
    <div className="stack--sm" style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
      <Link to={`/releases/${release.release_id}`} onClick={(e) => e.stopPropagation()} className="mono" style={{ fontWeight: 600 }}>
        {release.release_id}
      </Link>
      {showProject ? <span className="muted truncate">{release.project}</span> : null}
    </div>
  );
}

function StatusCell({ release }: { release: Release }) {
  return (
    <div className="row row--wrap" style={{ gap: "var(--space-1)" }}>
      <StatusBadge status={release.status} />
      {release.status === "RUNNING" ? <span className="subtle">{stageLabel(release.current_stage)}</span> : null}
      {release.is_active ? <Badge tone="success" outline>Live</Badge> : null}
    </div>
  );
}

function CommitCell({ release }: { release: Release }) {
  return (
    <div className="stack--sm" style={{ display: "flex", flexDirection: "column" }}>
      <span className="mono">{shortSha(release.commit_sha)}</span>
      <span className="subtle row" style={{ gap: 4 }}>
        <GitBranch size={12} aria-hidden />
        <span className="truncate" style={{ maxWidth: 160 }}>{release.ref ?? "—"}</span>
      </span>
    </div>
  );
}

function ArtifactCell({ release }: { release: Release }) {
  const artifact = release.artifact;

  if (!artifact) return <span className="subtle">{release.mode === "check" ? "none (check)" : "—"}</span>;

  if (artifact.type === "image") {
    return (
      <span className="row" style={{ gap: 6 }} title={artifact.digest}>
        <Box size={14} aria-hidden />
        <span className="mono">{shortDigest(artifact.digest)}</span>
        <span className="subtle">{formatBytes(artifact.sizeBytes)}</span>
      </span>
    );
  }

  return (
    <span className="row" style={{ gap: 6 }}>
      <FileText size={14} aria-hidden />
      <span>{artifact.fileCount > 0 ? `${artifact.fileCount} files` : "static files"}</span>
    </span>
  );
}

/** The one table every release list uses, so lists look and behave the same. */
export function ReleaseTable({ releases, variant, showProject = true, pageSize = 15, empty, caption }: ReleaseTableProps) {
  const navigate = useNavigate();

  const status: Column<Release> = { key: "status", header: "Status", cell: (r) => <StatusCell release={r} />, sort: (a, b) => a.status.localeCompare(b.status) };
  const release: Column<Release> = { key: "release", header: showProject ? "Release / application" : "Release", cell: (r) => <ReleaseCell release={r} showProject={showProject} />, sort: (a, b) => a.project.localeCompare(b.project) || a.release_id.localeCompare(b.release_id) };
  const commit: Column<Release> = { key: "commit", header: "Commit / branch", cell: (r) => <CommitCell release={r} /> };
  const started: Column<Release> = { key: "started", header: "Started", cell: (r) => <span title={r.created_at}>{timeAgo(r.created_at)}</span>, sort: (a, b) => time(a) - time(b) };
  const duration: Column<Release> = { key: "duration", header: "Duration", align: "right", cell: (r) => formatDuration(releaseDurationMs(r)), sort: (a, b) => (releaseDurationMs(a) ?? -1) - (releaseDurationMs(b) ?? -1) };

  const columns: Column<Release>[] =
    variant === "compact"
      ? [status, release, commit, duration, started]
      : variant === "builds"
        ? [
            status,
            release,
            commit,
            { key: "trigger", header: "Trigger", cell: (r) => triggerLabel(r.trigger) },
            {
              key: "mode",
              header: "Type",
              cell: (r) => (
                <div className="stack--sm" style={{ display: "flex", flexDirection: "column" }}>
                  <span>{r.mode === "check" ? "Check (no deploy)" : "Build + deploy"}</span>
                  <span className="subtle">{r.test_status ? `Tests ${r.test_status.toLowerCase()}` : "Tests —"}</span>
                </div>
              ),
            },
            duration,
            started,
          ]
        : [
            status,
            release,
            { key: "target", header: "Target", cell: (r) => <TargetBadge target={r.target} /> },
            { key: "artifact", header: "Artifact", cell: (r) => <ArtifactCell release={r} /> },
            commit,
            duration,
            started,
          ];

  return (
    <DataTable
      rows={releases}
      columns={columns}
      rowKey={(r) => r.release_id}
      onRowClick={(r) => navigate(`/releases/${r.release_id}`)}
      initialSort={{ key: "started", direction: "desc" }}
      pageSize={pageSize}
      empty={empty}
      caption={caption}
    />
  );
}
