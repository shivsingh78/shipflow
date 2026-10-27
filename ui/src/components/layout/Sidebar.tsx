import { NavLink } from "react-router-dom";
import { X } from "lucide-react";
import { NAV } from "./nav";
import { Logo } from "./Logo";
import { useReadiness, useWhoAmI } from "@/data/hooks";

/** Overall system state from the API's own readiness checks: nothing is assumed. */
function systemStatus(status: "loading" | "ready" | "error", checks: Array<{ ok: boolean }> | undefined): { text: string; dot: string } {
  if (status === "loading") return { text: "checking status…", dot: "status-dot--idle" };
  if (!checks) return { text: "status unavailable", dot: "status-dot--idle" };

  const failing = checks.filter((c) => !c.ok).length;

  return failing === 0 ? { text: "all systems nominal", dot: "" } : { text: `${failing} ${failing === 1 ? "check" : "checks"} failing`, dot: "status-dot--warn" };
}

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const whoami = useWhoAmI();
  const readiness = useReadiness({ pollMs: 60_000 });
  const state = systemStatus(readiness.status, readiness.data?.checks);

  return (
    <>
      <div className={`sidebar-scrim${open ? " is-open" : ""}`} onClick={onClose} aria-hidden />
      <aside className={`sidebar${open ? " is-open" : ""}`} aria-label="Primary">
        <div className="sidebar__brand">
          <Logo />
          <div className="sidebar__brand-text">
            <span className="brand-name">ShipFlow</span>
            <span className="sidebar__instance truncate">Self-hosted{whoami.data?.instance ? ` · ${whoami.data.instance}` : ""}</span>
          </div>
          <button type="button" className="icon-btn sidebar__close" onClick={onClose} aria-label="Close navigation">
            <X size={18} aria-hidden />
          </button>
        </div>
        <nav className="sidebar__nav">
          {NAV.map((group) => (
            <div key={group.label} className="sidebar__group">
              <div className="sidebar__group-label">{group.label}</div>
              {group.items.map((item) => {
                const Icon = item.icon;

                if (!item.to) {
                  return (
                    <span key={item.label} className="sidebar__link is-disabled" aria-disabled="true" title={item.unavailable}>
                      <Icon size={16} aria-hidden />
                      <span className="sidebar__label">{item.label}</span>
                      <span className="sidebar__soon">Soon</span>
                    </span>
                  );
                }

                return (
                  <NavLink key={item.label} to={item.to} className={({ isActive }) => `sidebar__link${isActive ? " is-active" : ""}`} onClick={onClose}>
                    <Icon size={16} aria-hidden />
                    <span className="sidebar__label">{item.label}</span>
                  </NavLink>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="sidebar__foot" role="status">
          <span className={`status-dot ${state.dot}`.trim()} aria-hidden />
          <span>{state.text}</span>
        </div>
      </aside>
    </>
  );
}
