import { Link, useLocation } from "react-router-dom";
import { ChevronRight } from "lucide-react";

interface Crumb {
  label: string;
  to?: string;
}

const TOP: Record<string, string> = {
  overview: "Overview",
  applications: "Applications",
  deployments: "Deployments",
  "build-runs": "Build Runs",
  servers: "Servers",
  registries: "Container Registries",
  domains: "Domains",
  activity: "Activity",
  logs: "Logs",
  settings: "Settings",
  account: "Account",
  releases: "Releases",
};

const TABS: Record<string, string> = {
  deployments: "Deployments",
  logs: "Build Logs",
  configuration: "Configuration",
  domains: "Domains",
  environment: "Environment Variables",
  settings: "Settings",
};

export function crumbsFor(pathname: string): Crumb[] {
  const [first, second, third] = pathname.split("/").filter(Boolean).map(decodeURIComponent);

  if (!first) return [{ label: "Overview" }];

  const root: Crumb = { label: TOP[first] ?? first, to: `/${first}` };

  if (first === "applications" && second === "new") return [root, { label: "New application" }];
  if (first === "applications" && second) {
    const app: Crumb = { label: second, to: `/applications/${encodeURIComponent(second)}` };

    return third && TABS[third] ? [root, app, { label: TABS[third] }] : [root, { label: second }];
  }

  if (first === "releases" && second) return [root, { label: second }];

  return [{ label: root.label }];
}

export function Breadcrumbs() {
  const crumbs = crumbsFor(useLocation().pathname);

  return (
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      <ol>
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;

          return (
            <li key={`${crumb.label}-${index}`}>
              {index > 0 ? <ChevronRight size={14} aria-hidden className="subtle" /> : null}
              {crumb.to && !last ? <Link to={crumb.to}>{crumb.label}</Link> : <span aria-current={last ? "page" : undefined}>{crumb.label}</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
