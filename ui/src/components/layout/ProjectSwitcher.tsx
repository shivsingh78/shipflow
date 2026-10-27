import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useMatch } from "react-router-dom";
import { Check, ChevronDown } from "lucide-react";
import { useProjects, useReleases } from "@/data/hooks";
import { latestByProject } from "@/lib/derive";

/**
 * Jump between applications. The dot reflects the application's latest deployment
 * (orange when it failed); it is not a health probe.
 */
export function ProjectSwitcher() {
  const match = useMatch("/applications/:name/*");
  const current = match?.params.name && match.params.name !== "new" ? decodeURIComponent(match.params.name) : null;
  const projects = useProjects();
  const releases = useReleases({ limit: 100 });
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const latest = useMemo(() => latestByProject((releases.data?.releases ?? []).filter((r) => r.mode === "deploy")), [releases.data]);
  const dotFor = (name: string) => {
    const status = latest.get(name)?.status;

    return status === "FAILED" ? "status-dot--warn" : status === "SUCCESS" ? "" : "status-dot--idle";
  };

  useEffect(() => {
    if (!open) return undefined;

    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !ref.current?.contains(event.target as Node)) setOpen(false);
    };

    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);

    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const names = (projects.data ?? []).map((p) => p.name);

  return (
    <div className="menu" ref={ref}>
      <button type="button" className="selector" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} aria-label="Switch application">
        <span className={`status-dot ${current ? dotFor(current) : ""}`.trim()} aria-hidden />
        <span>{current ?? "All applications"}</span>
        <ChevronDown size={14} aria-hidden />
      </button>
      {open ? (
        <div className="menu__panel" role="menu">
          <Link to="/applications" role="menuitem" className="menu__item" aria-current={current === null || undefined} onClick={() => setOpen(false)}>
            <span className="grow">All applications</span>
            {current === null ? <Check size={14} aria-hidden /> : null}
          </Link>
          {projects.status === "loading" ? <div className="menu__head muted">Loading…</div> : null}
          {projects.status === "ready" && names.length === 0 ? <div className="menu__head muted">No applications yet</div> : null}
          {names.map((name) => (
            <Link key={name} to={`/applications/${encodeURIComponent(name)}`} role="menuitem" className="menu__item" aria-current={name === current || undefined} onClick={() => setOpen(false)}>
              <span className={`status-dot ${dotFor(name)}`.trim()} aria-hidden />
              <span className="grow">{name}</span>
              {name === current ? <Check size={14} aria-hidden /> : null}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}
