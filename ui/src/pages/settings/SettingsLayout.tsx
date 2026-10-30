import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Badge, PageHeader } from "@/components/ui";
import { useWhoAmI } from "@/data/hooks";
import "./settings.css";

export type SettingsSection = "overview" | "secrets";

const RAIL: Array<{ key: SettingsSection; label: string; to: string }> = [
  { key: "overview", label: "Overview", to: "/settings" },
  { key: "secrets", label: "Secrets", to: "/settings/secrets" },
];

/** Settings frame from the Flowstep reference: a header with the workspace badge and a left rail. */
export function SettingsLayout({ active, title, description, actions, children }: { active: SettingsSection; title: string; description: string; actions?: ReactNode; children: ReactNode }) {
  const whoami = useWhoAmI();

  return (
    <div className="settings">
      <PageHeader title="Settings" description="Control plane configuration and security boundaries." actions={<Badge>Instance: {whoami.data?.instance ?? "…"}</Badge>} />
      <div className="settings__frame">
        <nav className="settings__rail" aria-label="Settings sections">
          {RAIL.map((item) => (
            <Link key={item.key} to={item.to} className={`settings__rail-link${active === item.key ? " is-active" : ""}`} aria-current={active === item.key ? "page" : undefined}>
              {item.label}
            </Link>
          ))}
          <Link to="/account" className="settings__rail-link">Account</Link>
        </nav>
        <div className="settings__panel">
          <div className="settings__panel-head">
            <div>
              <h2>{title}</h2>
              <p className="muted">{description}</p>
            </div>
            {actions}
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
