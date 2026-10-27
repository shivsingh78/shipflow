import { useMemo, useState } from "react";
import { Card, Checkbox, EmptyState, ErrorState, TableSkeleton } from "@/components/ui";
import { ReleaseTable } from "@/components/releases/ReleaseTable";
import { DeployButton } from "@/components/releases/ReleaseActions";
import type { ReleaseStatus } from "@/api/types";
import { useApplication } from "../context";
import "../applications.css";

const STATUSES: Array<ReleaseStatus | "all"> = ["all", "SUCCESS", "FAILED", "RUNNING", "QUEUED", "CANCELLED"];

export default function DeploymentsTab() {
  const { releases, releasesLoading, releasesError, project } = useApplication();
  const [status, setStatus] = useState<ReleaseStatus | "all">("all");
  const [liveOnly, setLiveOnly] = useState(false);
  const [checks, setChecks] = useState(false);

  const visible = useMemo(
    () => releases.filter((r) => (checks || r.mode === "deploy") && (status === "all" || r.status === status) && (!liveOnly || r.is_active)),
    [releases, status, liveOnly, checks]
  );

  if (releasesLoading) return <Card><TableSkeleton rows={5} columns={6} /></Card>;
  if (releasesError) return <Card><ErrorState error={releasesError} title="Could not load releases" /></Card>;

  return (
    <div>
      <div className="apps-toolbar">
        <select className="select" aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value as ReleaseStatus | "all")}>
          {STATUSES.map((s) => <option key={s} value={s}>{s === "all" ? "All statuses" : s.charAt(0) + s.slice(1).toLowerCase()}</option>)}
        </select>
        <Checkbox label="Live release only" checked={liveOnly} onChange={(e) => setLiveOnly(e.target.checked)} />
        <Checkbox label="Include check runs" checked={checks} onChange={(e) => setChecks(e.target.checked)} />
      </div>
      <Card>
        <ReleaseTable
          releases={visible}
          variant="deployments"
          showProject={false}
          caption={`Deployments of ${project.name}`}
          empty={
            <EmptyState
              title={releases.length === 0 ? "No deployments yet" : "No deployments match"}
              description={releases.length === 0 ? "Queue the first deployment of this application." : "Change the filters to see more."}
              action={releases.length === 0 ? <DeployButton project={project.name} defaultRef={project.config.project.branch} /> : undefined}
            />
          }
        />
      </Card>
    </div>
  );
}
