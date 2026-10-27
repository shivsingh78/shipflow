import { useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardBody, EmptyState, ErrorState, Skeleton } from "@/components/ui";
import { DeployButton } from "@/components/releases/ReleaseActions";
import { LogViewer } from "@/components/logs/LogViewer";
import { timeAgo } from "@/lib/format";
import { statusMeta } from "@/lib/status";
import { useApplication } from "../context";
import "../applications.css";

export default function BuildLogsTab() {
  const { releases, releasesLoading, releasesError, project } = useApplication();
  const [picked, setPicked] = useState<string | null>(null);

  if (releasesLoading) return <Card><CardBody><Skeleton height={240} /></CardBody></Card>;
  if (releasesError) return <Card><ErrorState error={releasesError} title="Could not load releases" /></Card>;

  if (releases.length === 0) {
    return (
      <Card>
        <EmptyState title="No build logs yet" description="Logs appear here once this application has been built." action={<DeployButton project={project.name} defaultRef={project.config.project.branch} />} />
      </Card>
    );
  }

  const selected = releases.find((r) => r.release_id === picked) ?? releases[0];

  if (!selected) return null;

  return (
    <div className="stack">
      <div className="apps-toolbar" style={{ marginBottom: 0 }}>
        <label className="row row--wrap" style={{ gap: "var(--space-2)", maxWidth: "100%", minWidth: 0 }}>
          <span className="field__label">Release</span>
          <select className="select" value={selected.release_id} onChange={(e) => setPicked(e.target.value)}>
            {releases.map((r, i) => (
              <option key={r.release_id} value={r.release_id}>
                {r.release_id} · {statusMeta(r.status).label} · {r.mode === "check" ? "check" : "deploy"} · {timeAgo(r.created_at)}
                {i === 0 ? " (latest)" : ""}
              </option>
            ))}
          </select>
        </label>
        <Link to={`/releases/${selected.release_id}`}>Open release details</Link>
      </div>
      <LogViewer key={selected.release_id} releaseId={selected.release_id} height="520px" />
    </div>
  );
}
