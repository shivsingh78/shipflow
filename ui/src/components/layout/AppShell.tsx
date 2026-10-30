import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import { FlaskConical } from "lucide-react";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { CommandPalette } from "./CommandPalette";
import { useAuth } from "@/auth/AuthProvider";

export function AppShell() {
  const { demo, signOut } = useAuth();
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };

    window.addEventListener("keydown", onKey);

    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="shell">
      <a href="#main" className="skip-link">Skip to content</a>
      <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />
      <div className="shell__main">
        {demo ? (
          <div className="demo-banner" role="status">
            <FlaskConical size={15} aria-hidden />
            <span>
              <strong>Demo mode.</strong> Everything here is sample data held in your browser. No server is contacted and nothing is deployed.
            </span>
            <button type="button" className="btn btn--sm" onClick={() => signOut()}>Exit demo</button>
          </div>
        ) : null}
        <Topbar onMenu={() => setNavOpen(true)} onSearch={() => setPaletteOpen(true)} />
        <main id="main" className="content" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
