import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { ChevronDown, X } from "lucide-react";
import { DIVIDE_BEFORE, NAV, activeEntry, isItemActive } from "./nav";
import type { NavItem } from "./nav";
import { Logo } from "./Logo";
import { useAuth } from "@/auth/AuthProvider";
import { useReadiness, useWhoAmI } from "@/data/hooks";

/** Overall system state from the API's own readiness checks: nothing is assumed. */
function systemStatus(status: "loading" | "ready" | "error", checks: Array<{ ok: boolean }> | undefined): { text: string; dot: string } {
  if (status === "loading") return { text: "checking status…", dot: "status-dot--idle" };
  if (!checks) return { text: "status unavailable", dot: "status-dot--idle" };

  const failing = checks.filter((c) => !c.ok).length;

  return failing === 0 ? { text: "all systems nominal", dot: "" } : { text: `${failing} ${failing === 1 ? "check" : "checks"} failing`, dot: "status-dot--warn" };
}

const initials = (name: string): string => (name.replace(/[^A-Za-z0-9]+/g, " ").trim().split(" ").slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "SF");

function NavGroup({ item, pathname, onNavigate }: { item: NavItem; pathname: string; onNavigate: () => void }) {
  const Icon = item.icon;
  const active = activeEntry(pathname, item);
  const [manual, setManual] = useState(false);
  const hasChildren = (item.children?.length ?? 0) > 0;
  // Open while you are inside it; the chevron lets you peek into the others.
  const open = hasChildren && (isItemActive(pathname, item) || manual);
  const panelId = `nav-${item.label.toLowerCase().replace(/\W+/g, "-")}`;

  return (
    <div className="sidebar__item">
      <div className="sidebar__row">
        <Link to={item.to} className={`sidebar__link${active === item.to ? " is-active" : ""}`} aria-current={active === item.to ? "page" : undefined} onClick={onNavigate}>
          <Icon size={16} aria-hidden />
          <span className="sidebar__label">{item.label}</span>
        </Link>
        {hasChildren ? (
          <button type="button" className="sidebar__toggle" onClick={() => setManual((value) => !value)} aria-expanded={open} aria-controls={panelId} aria-label={`${open ? "Collapse" : "Expand"} ${item.label}`}>
            <ChevronDown size={14} aria-hidden className={open ? "is-open" : undefined} />
          </button>
        ) : null}
      </div>
      {hasChildren && open ? (
        <div className="sidebar__children" id={panelId}>
          {item.children?.map((child) => (
            <Link key={child.to} to={child.to} className={`sidebar__sublink${active === child.to ? " is-active" : ""}`} aria-current={active === child.to ? "page" : undefined} onClick={onNavigate}>
              {child.label}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const whoami = useWhoAmI();
  const readiness = useReadiness({ pollMs: 60_000 });
  const { demo } = useAuth();
  const { pathname } = useLocation();
  const state = systemStatus(readiness.status, readiness.data?.checks);
  const instance = whoami.data?.instance ?? "ShipFlow";

  return (
    <>
      <div className={`sidebar-scrim${open ? " is-open" : ""}`} onClick={onClose} aria-hidden />
      <aside className={`sidebar${open ? " is-open" : ""}`} aria-label="Primary">
        <div className="sidebar__brand">
          <Link to="/overview" className="sidebar__brand-link" aria-label="ShipFlow overview" onClick={onClose}>
            <Logo />
            <span className="brand-name">ShipFlow</span>
          </Link>
          <button type="button" className="icon-btn sidebar__close" onClick={onClose} aria-label="Close navigation">
            <X size={18} aria-hidden />
          </button>
        </div>
        <nav className="sidebar__nav" aria-label="Main">
          {NAV.map((item) => (
            <div key={item.label}>
              {item.label === DIVIDE_BEFORE ? <div className="sidebar__divider" role="separator" /> : null}
              <NavGroup item={item} pathname={pathname} onNavigate={onClose} />
            </div>
          ))}
        </nav>
        <div className="sidebar__foot">
          <div className="sidebar__workspace">
            <span className="sidebar__avatar" aria-hidden>{initials(instance)}</span>
            <span className="sidebar__workspace-text">
              <span className="sidebar__workspace-name truncate">{instance}</span>
              <span className="sidebar__workspace-sub truncate">{demo ? "Demo session" : "API token session"}</span>
            </span>
          </div>
          <div className="sidebar__status" role="status">
            <span className={`status-dot ${state.dot}`.trim()} aria-hidden />
            <span>{state.text}</span>
          </div>
        </div>
      </aside>
    </>
  );
}
