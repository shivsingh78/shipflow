import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { LogOut, Menu, Monitor, Moon, Plus, Search, Sun, UserRound } from "lucide-react";
import { Breadcrumbs } from "./Breadcrumbs";
import { useTheme } from "./Theme";
import type { ThemePreference } from "./Theme";
import { useAuth } from "@/auth/AuthProvider";
import { LinkButton } from "@/components/ui";

const THEME_ICON = { system: Monitor, light: Sun, dark: Moon } as const;
const NEXT: Record<ThemePreference, ThemePreference> = { system: "light", light: "dark", dark: "system" };

export function Topbar({ onMenu, onSearch }: { onMenu: () => void; onSearch: () => void }) {
  const { preference, setPreference } = useTheme();
  const { demo, signOut } = useAuth();
  const navigate = useNavigate();
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const ThemeIcon = THEME_ICON[preference];

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
      <Breadcrumbs />
      <div className="grow" />
      <button type="button" className="topbar__search" onClick={onSearch} aria-label="Open command menu">
        <Search size={14} aria-hidden />
        <span>Search…</span>
        <kbd>Ctrl K</kbd>
      </button>
      <button type="button" className="icon-btn" onClick={onSearch} aria-label="Search" style={{ display: "var(--search-icon-display, none)" }}>
        <Search size={18} aria-hidden />
      </button>
      <button type="button" className="icon-btn" onClick={() => setPreference(NEXT[preference])} aria-label={`Theme: ${preference}. Switch to ${NEXT[preference]}`} title={`Theme: ${preference}`}>
        <ThemeIcon size={18} aria-hidden />
      </button>
      <LinkButton to="/applications/new" variant="primary" icon={<Plus size={15} aria-hidden />} className="topbar__new">
        <span className="topbar__new-label">New application</span>
      </LinkButton>
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
