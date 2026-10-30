import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { LogOut, Menu, Search, UserRound } from "lucide-react";
import { useAuth } from "@/auth/AuthProvider";
import { Breadcrumbs } from "./Breadcrumbs";
import { Logo } from "./Logo";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { ThemeSwitcher } from "./ThemeSwitcher";

const isMac = typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform);

export function Topbar({ onMenu, onSearch }: { onMenu: () => void; onSearch: () => void }) {
  const { demo, signOut } = useAuth();
  const navigate = useNavigate();
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return undefined;

    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !menuRef.current?.contains(event.target as Node)) setMenu(false);
    };

    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);

    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [menu]);

  return (
    <header className="topbar">
      <button type="button" className="icon-btn topbar__menu" onClick={onMenu} aria-label="Open navigation">
        <Menu size={20} aria-hidden />
      </button>
      <Link to="/overview" className="topbar__brand" aria-label="ShipFlow overview">
        <Logo size={32} />
      </Link>
      <Breadcrumbs />
      <div className="grow" />
      <ProjectSwitcher />
      <button type="button" className="topbar__search" onClick={onSearch} aria-label="Search releases, applications and pages">
        <Search size={15} aria-hidden />
        <span className="topbar__search-text">Search</span>
        <kbd>{isMac ? "⌘ K" : "Ctrl K"}</kbd>
      </button>
      <ThemeSwitcher />
      <div className="menu" ref={menuRef}>
        <button type="button" className="avatar" onClick={() => setMenu((m) => !m)} aria-haspopup="menu" aria-expanded={menu} aria-label="Account menu">
          <UserRound size={16} aria-hidden />
        </button>
        {menu ? (
          <div className="menu__panel" role="menu">
            <div className="menu__head">
              <strong>{demo ? "Demo session" : "API token session"}</strong>
              <span className="muted">{demo ? "Sample data, nothing is real" : "Single shared admin token"}</span>
            </div>
            <Link to="/account" role="menuitem" className="menu__item" onClick={() => setMenu(false)}>
              <UserRound size={15} aria-hidden /> Account
            </Link>
            <button
              type="button"
              role="menuitem"
              className="menu__item"
              onClick={() => {
                setMenu(false);
                signOut();
                void navigate("/");
              }}
            >
              <LogOut size={15} aria-hidden /> {demo ? "Exit demo" : "Sign out"}
            </button>
          </div>
        ) : null}
      </div>
    </header>
  );
}
