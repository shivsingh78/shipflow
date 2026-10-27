import { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { ReleaseMode, ReleaseStatus } from "@/api/types";
import { Banner, Button, Card, CardBody, EmptyState, ErrorState, PageHeader, SearchInput, TableSkeleton } from "@/components/ui";
import { ReleaseTable } from "@/components/releases/ReleaseTable";
import { useReleases } from "@/data/hooks";
import { timeAgo, pluralize } from "@/lib/format";
import { EMPTY_FILTERS, filterReleases, hasActiveRelease, hasActiveFilters } from "@/lib/runs";
import type { DateRange, RunFilters } from "@/lib/runs";
import { statusMeta, targetLabel } from "@/lib/status";
import { useAutoPoll } from "./useAutoPoll";
import "./runs.css";

export const RELEASE_LIMIT = 200;
const STATUSES: ReleaseStatus[] = ["QUEUED", "RUNNING", "SUCCESS", "FAILED", "CANCELLED"];

function Select({ label, value, onChange, children }: { label: string; value: string; onChange: (value: string) => void; children: React.ReactNode }) {
  return (
    <label className="filters__group">
      <span className="field__label">{label}</span>
      <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
        {children}
      </select>
    </label>
  );
}

/** Shared by Build Runs (every release) and Deployments (deploy-mode releases only). */
export function RunsList({ kind }: { kind: "builds" | "deployments" }) {
  const { pollMs, sync } = useAutoPoll(5000);
  const releases = useReleases({ limit: RELEASE_LIMIT, pollMs });
  const [filters, setFilters] = useState<RunFilters>({ ...EMPTY_FILTERS, mode: kind === "deployments" ? "deploy" : "" });
  const set = <K extends keyof RunFilters>(key: K, value: RunFilters[K]) => setFilters((f) => ({ ...f, [key]: value }));

  sync(releases.data ? hasActiveRelease(releases.data.releases) : undefined);

  const all = useMemo(() => releases.data?.releases ?? [], [releases.data]);
  const base = useMemo(() => (kind === "deployments" ? all.filter((r) => r.mode === "deploy") : all), [all, kind]);
  const projects = useMemo(() => [...new Set(all.map((r) => r.project))].sort(), [all]);
  const targets = useMemo(() => [...new Set(all.map((r) => r.target))].sort(), [all]);
  const visible = useMemo(() => filterReleases(base, filters), [base, filters]);
  const builds = kind === "builds";
  const defaults = { ...EMPTY_FILTERS, mode: (builds ? "" : "deploy") as ReleaseMode | "" };
  const filtered = hasActiveFilters({ ...filters, mode: builds ? filters.mode : "" });
  const running = all.filter((r) => r.status === "RUNNING" || r.status === "QUEUED").length;

  return (
    <>
      <PageHeader
        title={builds ? "Build Runs" : "Deployments"}
        description={
          builds
            ? "Every CI run ShipFlow has executed: deployments and check-only runs (pull requests, dry runs). Each is a release."
            : "Releases that were built and deployed to a target. Check-only runs never deploy and are listed under Build Runs."
        }
        actions={
          <Button icon={<RefreshCw size={14} aria-hidden className={releases.refreshing ? "spin" : undefined} />} onClick={() => void releases.refresh()}>
            Refresh
          </Button>
        }
      />

      <ul className="legend" aria-label="How ShipFlow terms relate">
        <li><strong>Build run</strong>Install, build and test your source in a sandbox. A check stops here.</li>
        <li><strong>Artifact / image</strong>What the build produced: static files, or a container image with a digest.</li>
        <li><strong>Deployment</strong>An artifact placed on a target, verified, then made the live release.</li>
      </ul>

      <div className="filters" role="search" aria-label={builds ? "Filter build runs" : "Filter deployments"}>
        <div className="filters__group" style={{ flex: "1 1 220px" }}>
          <span className="field__label">Search</span>
          <SearchInput value={filters.query} onChange={(v) => set("query", v)} placeholder="Release, application or commit" label="Search releases" />
        </div>
        <Select label="Application" value={filters.project} onChange={(v) => set("project", v)}>
          <option value="">All applications</option>
          {projects.map((p) => <option key={p} value={p}>{p}</option>)}
        </Select>
        <Select label="Status" value={filters.status} onChange={(v) => set("status", v as ReleaseStatus | "")}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{statusMeta(s).label}</option>)}
        </Select>
        {builds ? (
          <Select label="Type" value={filters.mode} onChange={(v) => set("mode", v as ReleaseMode | "")}>
            <option value="">Deploy and check</option>
            <option value="deploy">Deploy</option>
            <option value="check">Check</option>
          </Select>
        ) : (
          <Select label="Target" value={filters.target} onChange={(v) => set("target", v)}>
            <option value="">All targets</option>
            {targets.map((t) => <option key={t} value={t}>{targetLabel(t)}</option>)}
          </Select>
        )}
        <Select label="Created" value={filters.range} onChange={(v) => set("range", v as DateRange)}>
          <option value="all">Any time</option>
          <option value="24h">Last 24 hours</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
        </Select>
        {!builds ? (
          <label className="check" style={{ paddingBottom: 6 }}>
            <input type="checkbox" checked={filters.liveOnly} onChange={(e) => set("liveOnly", e.target.checked)} />
            <span>Live only</span>
          </label>
        ) : null}
        {filtered ? <Button variant="ghost" onClick={() => setFilters(defaults)}>Clear filters</Button> : null}
      </div>

      {releases.status === "error" && !releases.data ? (
        <Card><CardBody><ErrorState error={releases.error} onRetry={() => void releases.refresh()} title="Could not load releases" /></CardBody></Card>
      ) : releases.status === "loading" ? (
        <Card><TableSkeleton rows={8} columns={6} /></Card>
      ) : (
        <>
          <div className="list-meta" aria-live="polite">
            <span>{filtered ? `${visible.length} of ${pluralize(base.length, builds ? "run" : "deployment")}` : pluralize(base.length, builds ? "run" : "deployment")}</span>
            {running > 0 ? <span>{running} in progress: auto-refreshing every 5s</span> : null}
            {releases.updatedAt ? <span className="subtle">Updated {timeAgo(new Date(releases.updatedAt).toISOString())}</span> : null}
          </div>
          {all.length >= RELEASE_LIMIT ? (
            <div style={{ marginBottom: "var(--space-3)" }}>
              <Banner tone="info">The API returns at most the {RELEASE_LIMIT} newest releases, so older runs are not shown here.</Banner>
            </div>
          ) : null}
          <Card>
            <ReleaseTable
              releases={visible}
              variant={builds ? "builds" : "deployments"}
              caption={builds ? "Build runs" : "Deployments"}
              empty={
                <EmptyState
                  title={base.length === 0 ? (builds ? "No builds yet" : "No deployments yet") : "Nothing matches these filters"}
                  description={base.length === 0 ? "Releases appear here as soon as one is queued from the dashboard, the CLI or a Git webhook." : "Try widening the date range or clearing filters."}
                />
              }
            />
          </Card>
        </>
      )}
    </>
  );
}
