import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AppWindow, CornerDownLeft, Rocket, Search } from "lucide-react";
import { NAV_ROUTES } from "./nav";
import { useProjects, useReleases } from "@/data/hooks";
import { repoName } from "@/lib/format";

interface Command {
  id: string;
  label: string;
  hint: string;
  to: string;
  icon: typeof Search;
}

/** Ctrl/⌘+K: jump to a page, application or recent release. */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const ref = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const projects = useProjects({ enabled: open });
  const releases = useReleases({ limit: 15, enabled: open });

  useEffect(() => {
    const dialog = ref.current;

    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      setQuery("");
      setIndex(0);
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const pages: Command[] = NAV_ROUTES.map((route) => ({ id: `page:${route.to}`, label: route.label, hint: route.group, to: route.to, icon: route.icon }));
    const apps: Command[] = (projects.data ?? []).map((p) => ({ id: `app:${p.name}`, label: p.name, hint: repoName(p.repo_url), to: `/applications/${encodeURIComponent(p.name)}`, icon: AppWindow }));
    const runs: Command[] = (releases.data?.releases ?? []).map((r) => ({ id: `run:${r.release_id}`, label: `${r.project} · ${r.release_id}`, hint: r.mode === "check" ? "Check run" : "Deployment", to: `/releases/${r.release_id}`, icon: Rocket }));
    const needle = query.trim().toLowerCase();
    const all = [...pages, ...apps, ...runs];

    return (needle ? all.filter((c) => `${c.label} ${c.hint}`.toLowerCase().includes(needle)) : all).slice(0, 12);
  }, [projects.data, releases.data, query]);

  const go = (command: Command | undefined) => {
    if (!command) return;

    onClose();
    void navigate(command.to);
  };

  return (
    <dialog
      ref={ref}
      className="dialog palette"
      aria-label="Command menu"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      {open ? (
        <div>
          <div className="palette__input">
            <Search size={16} aria-hidden />
            <input
              autoFocus
              value={query}
              placeholder="Search pages, applications, releases…"
              aria-label="Search"
              onChange={(event) => {
                setQuery(event.target.value);
                setIndex(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setIndex((i) => Math.min(i + 1, commands.length - 1));
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setIndex((i) => Math.max(i - 1, 0));
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  go(commands[index]);
                }
              }}
            />
            <kbd>Esc</kbd>
          </div>
          <ul className="palette__list" role="listbox" aria-label="Results">
            {commands.length === 0 ? <li className="palette__empty">No results</li> : null}
            {commands.map((command, i) => {
              const Icon = command.icon;

              return (
                <li key={command.id} role="option" aria-selected={i === index}>
                  <button type="button" className={`palette__item${i === index ? " is-active" : ""}`} onMouseEnter={() => setIndex(i)} onClick={() => go(command)}>
                    <Icon size={16} aria-hidden />
                    <span className="grow truncate">{command.label}</span>
                    <span className="subtle truncate">{command.hint}</span>
                    {i === index ? <CornerDownLeft size={14} aria-hidden /> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </dialog>
  );
}
