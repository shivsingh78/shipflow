import { Activity, AppWindow, Boxes, FolderKanban, Globe, Hammer, LayoutDashboard, Rocket, ScrollText, Server, Settings, ShieldCheck, UserRound, Workflow } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface NavItem {
  label: string;
  to?: string;
  icon: LucideIcon;
  /** Set for features the backend does not offer: rendered disabled with this explanation. */
  unavailable?: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  {
    label: "Workspace",
    items: [
      { label: "Overview", to: "/overview", icon: LayoutDashboard },
      { label: "Projects", icon: FolderKanban, unavailable: "ShipFlow has no workspace-level project grouping yet. Each project is one application: see Applications." },
      { label: "Applications", to: "/applications", icon: AppWindow },
      { label: "Deployments", to: "/deployments", icon: Rocket },
      { label: "Build Runs", to: "/build-runs", icon: Hammer },
      { label: "RepoPilot", to: "/repopilot", icon: ShieldCheck },
    ],
  },
  {
    label: "Infrastructure",
    items: [
      { label: "Servers", to: "/servers", icon: Server },
      { label: "Container Registries", to: "/registries", icon: Boxes },
      { label: "Domains", to: "/domains", icon: Globe },
      { label: "Environments", icon: Workflow, unavailable: "Environments are not a ShipFlow concept yet. Use one project per environment (for example my-app and my-app-staging)." },
    ],
  },
  {
    label: "Operations",
    items: [
      { label: "Activity", to: "/activity", icon: Activity },
      { label: "Logs", to: "/logs", icon: ScrollText },
    ],
  },
  {
    label: "Administration",
    items: [
      { label: "Settings", to: "/settings", icon: Settings },
      { label: "Account", to: "/account", icon: UserRound },
    ],
  },
];

/** Routes searchable in the command menu. */
export const NAV_ROUTES = NAV.flatMap((group) => group.items.filter((item) => item.to).map((item) => ({ label: item.label, to: item.to as string, icon: item.icon, group: group.label })));
