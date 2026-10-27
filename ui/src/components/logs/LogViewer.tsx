import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Download, RefreshCw } from "lucide-react";
import { Badge, Button, CopyButton, ErrorState, SearchInput, Skeleton } from "@/components/ui";
import { useReleaseLogs } from "@/data/hooks";
import { useAutoPoll } from "@/pages/runs/useAutoPoll";
import { formatTime, pluralize, timeAgo } from "@/lib/format";
import { filterLogs, logsToText, splitMatches } from "@/lib/logs";
import { stageLabel, statusMeta } from "@/lib/status";
import type { ReleaseStatus } from "@/api/types";
import "./logs.css";

export interface LogViewerProps {
  releaseId: string;
  /** Optional fixed height (CSS), otherwise the viewer fills a sensible default. */
  height?: string;
}

export const LOG_POLL_MS = 2000;
/** Rows rendered at once; older lines stay in memory, in the copy and in the download. */
export const MAX_RENDERED_ROWS = 2000;
const LEVELS = ["INFO", "WARN", "ERROR"] as const;

const isLive = (status: ReleaseStatus) => status === "QUEUED" || status === "RUNNING";

function Highlight({ text, query }: { text: string; query: string }) {
  return (
    <>
      {splitMatches(text, query).map((part, i) => (part.match ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>))}
    </>
  );
}

export function LogViewer({ releaseId, height }: LogViewerProps) {
  const { pollMs, sync } = useAutoPoll(LOG_POLL_MS);
  const logs = useReleaseLogs(releaseId, { pollMs });
  const data = logs.data && logs.data.release.release_id === releaseId ? logs.data : undefined;
  const status = data?.release.status;

  sync(status === undefined ? undefined : isLive(status));

  const [query, setQuery] = useState("");
  const [levels, setLevels] = useState<string[]>([]);
  const [stage, setStage] = useState("");
  const [followChoice, setFollowChoice] = useState<boolean | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  const follow = followChoice ?? (status !== undefined && isLive(status));
  const rows = useMemo(() => data?.logs ?? [], [data]);
  const stages = useMemo(() => [...new Set(rows.map((r) => r.stage))], [rows]);
  const filtered = useMemo(() => filterLogs(rows, { query, levels, stage }), [rows, query, levels, stage]);
  const shown = showAll || filtered.length <= MAX_RENDERED_ROWS ? filtered : filtered.slice(-MAX_RENDERED_ROWS);
  const filteredNow = query.trim() !== "" || levels.length > 0 || stage !== "";

  useEffect(() => {
    const el = scroller.current;

    if (follow && el) el.scrollTop = el.scrollHeight;
  }, [follow, shown.length]);

  const onScroll = () => {
    const el = scroller.current;

    if (!el) return;

    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 24;

    setAtBottom(near);
    // Scrolling up pauses following; the user can resume with the toggle or "Jump to latest".
    if (!near && follow) setFollowChoice(false);
  };

  const jump = () => {
    setFollowChoice(true);

    const el = scroller.current;

    if (el) el.scrollTop = el.scrollHeight;
  };

  const toggleLevel = (level: string) => setLevels((current) => (current.includes(level) ? current.filter((l) => l !== level) : [...current, level]));

  const download = () => {
    const blob = new Blob([`${logsToText(filtered)}\n`], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `${releaseId}-logs.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  if (logs.status === "error" && !data) return <ErrorState error={logs.error} onRetry={() => void logs.refresh()} title="Could not load logs" />;

  if (!data) {
    return (
      <div className="logv" role="status" aria-label="Loading logs">
        <Skeleton height={32} />
        <Skeleton height={Number.parseInt(height ?? "320", 10) || 320} />
      </div>
    );
  }

  const meta = statusMeta(data.release.status);
  const chip = data.release.status === "RUNNING" ? "Running" : data.release.status === "SUCCESS" ? "Completed" : data.release.status === "FAILED" ? "Failed" : meta.label;
  const live = isLive(data.release.status);

  return (
    <div className="logv" style={height ? ({ "--logv-height": height } as React.CSSProperties) : undefined}>
      <div className="logv__bar" role="group" aria-label="Log filters">
        <SearchInput value={query} onChange={setQuery} placeholder="Search logs" label="Search logs" />
        <div className="row" style={{ gap: "var(--space-1)" }} role="group" aria-label="Levels">
          {LEVELS.map((level) => (
            <button key={level} type="button" className="chip" aria-pressed={levels.includes(level)} onClick={() => toggleLevel(level)}>
              {level}
            </button>
          ))}
        </div>
        <select className="select" style={{ width: "auto" }} value={stage} onChange={(e) => setStage(e.target.value)} aria-label="Filter by stage">
          <option value="">All stages</option>
          {stages.map((s) => (
            <option key={s} value={s}>
              {stageLabel(s)}
            </option>
          ))}
        </select>
        <label className="check">
          <input type="checkbox" checked={follow} onChange={(e) => (e.target.checked ? jump() : setFollowChoice(false))} />
          <span>Follow tail</span>
        </label>
        <span className="grow" />
        <CopyButton text={logsToText(filtered)} label={filteredNow ? "Copy filtered lines" : "Copy all lines"} />
        <Button size="sm" icon={<Download size={14} aria-hidden />} onClick={download} disabled={filtered.length === 0}>
          Download .txt
        </Button>
        <Button size="sm" variant="ghost" aria-label="Refresh logs" icon={<RefreshCw size={14} aria-hidden className={logs.refreshing ? "spin" : undefined} />} onClick={() => void logs.refresh()} />
      </div>

      <div className="logv__status">
        <Badge tone={meta.tone}>
          <span className={`dot${data.release.status === "RUNNING" ? " dot--pulse" : ""}`} aria-hidden />
          {chip}
        </Badge>
        <span aria-live="polite">
          {filteredNow ? `${filtered.length} of ${pluralize(rows.length, "line")}` : pluralize(rows.length, "line")}
        </span>
        <span>{live ? `Auto-refreshing every ${LOG_POLL_MS / 1000}s while the release runs` : "Release finished: no longer refreshing"}</span>
        {logs.updatedAt ? <span className="subtle">Updated {timeAgo(new Date(logs.updatedAt).toISOString())}</span> : null}
        {logs.status === "error" ? <span style={{ color: "var(--danger)" }}>Last refresh failed; showing earlier data.</span> : null}
      </div>

      <div className="logv__panel">
        <div ref={scroller} className="logv__scroll" onScroll={onScroll} tabIndex={0} role="region" aria-label={`Logs for release ${releaseId}`}>
          {rows.length === 0 ? (
            <div className="logv__empty">{data.release.status === "QUEUED" ? "No logs yet: waiting for a worker." : "No log lines were recorded for this release."}</div>
          ) : filtered.length === 0 ? (
            <div className="logv__empty">No lines match the current filters.</div>
          ) : (
            <>
              {shown.length < filtered.length ? (
                <div className="logv__empty" style={{ padding: "var(--space-2) var(--space-3)" }}>
                  Showing the latest {shown.length} of {filtered.length} lines.{" "}
                  <button type="button" className="chip" onClick={() => setShowAll(true)}>
                    Show all
                  </button>
                </div>
              ) : null}
              {shown.map((row) => (
                <div key={row.id} className="logv__line" data-level={row.level}>
                  <span className="logv__meta">
                    <span className="logv__time">{formatTime(row.created_at)}</span>
                    <span className="logv__stage">{row.stage}</span>
                    <span className="logv__lvl">{row.level}</span>
                  </span>
                  <span className="logv__msg">
                    <Highlight text={row.message} query={query} />
                  </span>
                </div>
              ))}
            </>
          )}
        </div>
        {!atBottom && shown.length > 0 ? (
          <Button className="logv__jump" size="sm" variant="primary" icon={<ArrowDown size={14} aria-hidden />} onClick={jump}>
            Jump to latest
          </Button>
        ) : null}
      </div>

      {data.notifications.length > 0 ? (
        <section aria-label="Notifications">
          <h3 className="field__label" style={{ marginBottom: 4 }}>Notifications</h3>
          <ul className="logv__notes">
            {data.notifications.map((n) => (
              <li key={n.id}>
                <Badge outline>{n.type}</Badge> {n.message} <span className="subtle">{timeAgo(n.created_at)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
