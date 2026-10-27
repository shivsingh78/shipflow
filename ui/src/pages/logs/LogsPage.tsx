import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import { Button, Card, CardBody, EmptyState, ErrorState, PageHeader, SearchInput, StatusBadge, TableSkeleton } from "@/components/ui";
import { LogViewer } from "@/components/logs/LogViewer";
import { useReleases } from "@/data/hooks";
import { timeAgo } from "@/lib/format";
import { filterReleases, hasActiveRelease, sortForPicker, EMPTY_FILTERS } from "@/lib/runs";
import { useAutoPoll } from "../runs/useAutoPoll";
import "../runs/runs.css";

export default function LogsPage() {
  const { pollMs, sync } = useAutoPoll(10_000);
  const releases = useReleases({ limit: 200, pollMs });
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const selected = params.get("release") ?? "";

  sync(releases.data ? hasActiveRelease(releases.data.releases) : undefined);

  const list = useMemo(() => sortForPicker(filterReleases(releases.data?.releases ?? [], { ...EMPTY_FILTERS, query })), [releases.data, query]);
  // Without a selection, show the first (running first, then newest) without touching the URL.
  const current = selected || list[0]?.release_id || "";

  return (
    <>
      <PageHeader
        title="Logs"
        description="Build and deployment logs per release. There is no streaming endpoint: logs of running releases are re-fetched every 2 seconds."
        actions={<Button icon={<RefreshCw size={14} aria-hidden className={releases.refreshing ? "spin" : undefined} />} onClick={() => void releases.refresh()}>Refresh list</Button>}
      />
      {releases.status === "loading" ? (
        <Card><TableSkeleton rows={6} columns={2} /></Card>
      ) : releases.status === "error" && !releases.data ? (
        <Card><ErrorState error={releases.error} onRetry={() => void releases.refresh()} title="Could not load releases" /></Card>
      ) : (releases.data?.releases.length ?? 0) === 0 ? (
        <Card><EmptyState title="No logs yet" description="Logs appear here after the first release is queued." /></Card>
      ) : (
        <div className="logs-layout">
          <Card className="logs-picker">
            <div style={{ padding: "var(--space-3)", borderBottom: "1px solid var(--border)" }}>
              <SearchInput value={query} onChange={setQuery} placeholder="Release, application or commit" label="Search releases" />
            </div>
            <ul className="logs-picker__list" aria-label="Releases">
              {list.length === 0 ? <li className="muted" style={{ padding: "var(--space-4)" }}>No releases match.</li> : null}
              {list.map((r) => (
                <li key={r.release_id}>
                  <button type="button" className="logs-picker__item" aria-current={r.release_id === current ? "true" : undefined} onClick={() => setParams({ release: r.release_id }, { replace: true })}>
                    <span className="row row--between">
                      <span className="mono" style={{ fontWeight: 600 }}>{r.release_id}</span>
                      <StatusBadge status={r.status} />
                    </span>
                    <span className="muted truncate">{r.project} &middot; {r.mode === "check" ? "check" : "deploy"}</span>
                    <span className="subtle">{timeAgo(r.created_at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
          <Card>
            <CardBody>{current ? <LogViewer key={current} releaseId={current} /> : <EmptyState title="Select a release" />}</CardBody>
          </Card>
        </div>
      )}
    </>
  );
}
