import { NavLink } from "react-router-dom";
import { X } from "lucide-react";
import { NAV } from "./nav";
import { Logo } from "./Logo";
import { useWhoAmI } from "@/data/hooks";

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const whoami = useWhoAmI();

  return (
    <>
      <div className={`sidebar-scrim${open ? " is-open" : ""}`} onClick={onClose} aria-hidden />
      <aside className={`sidebar${open ? " is-open" : ""}`} aria-label="Primary">
        <div className="sidebar__brand">
          <Logo />
          <div className="sidebar__brand-text">
            <span className="sidebar__name">ShipFlow</span>
            <span className="sidebar__instance truncate">{whoami.data?.instance ?? "workspace"}</span>
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
                      <Icon size={17} aria-hidden />
                      <span className="sidebar__label">{item.label}</span>
                      <span className="sidebar__soon">Soon</span>
                    </span>
                  );
                }

                return (
                  <NavLink key={item.label} to={item.to} className={({ isActive }) => `sidebar__link${isActive ? " is-active" : ""}`} onClick={onClose} title={item.label}>
                    <Icon size={17} aria-hidden />
                    <span className="sidebar__label">{item.label}</span>
                  </NavLink>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="sidebar__foot">
          <span>Self-hosted</span>
        </div>
      </aside>
    </>
  );
}
