import { Activity, AppWindow, GitBranch, LayoutDashboard, Rocket, ScrollText, Server, Settings, Sparkles, TerminalSquare } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface NavChild {
  label: string;
  to: string;
}

export interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  /** Pages that live under this item in the sidebar. */
  children?: NavChild[];
  /** Other route prefixes that should light this item (e.g. a detail page it owns). */
  also?: string[];
}

/** Sidebar order, from the Flowstep reference. A divider is drawn before DIVIDE_BEFORE. */
export const NAV: NavItem[] = [
  { label: "Overview", to: "/overview", icon: LayoutDashboard },
  { label: "Applications", to: "/applications", icon: AppWindow },
  { label: "Pipelines", to: "/pipelines", icon: GitBranch, also: ["/releases"] },
  { label: "Deployments", to: "/deployments", icon: Rocket },
  {
    label: "Infrastructure",
    to: "/infrastructure",
    icon: Server,
    children: [
      { label: "Servers", to: "/servers" },
      { label: "Registries", to: "/registries" },
      { label: "Domains", to: "/domains" },
    ],
  },
  { label: "Build Runs", to: "/build-runs", icon: TerminalSquare },
  { label: "RepoPilot", to: "/repopilot", icon: Sparkles },
  { label: "Activity", to: "/activity", icon: Activity },
  {
    label: "Settings",
    to: "/settings",
    icon: Settings,
    children: [
      { label: "Secrets", to: "/settings/secrets" },
      { label: "Account", to: "/account" },
    ],
  },
];

export const DIVIDE_BEFORE = "Settings";

const matches = (pathname: string, to: string): boolean => pathname === to || pathname.startsWith(`${to}/`);

/** True when `pathname` belongs to this item (its own page, a child's page, or an owned detail route). */
export function isItemActive(pathname: string, item: NavItem): boolean {
  return matches(pathname, item.to) || (item.also ?? []).some((prefix) => matches(pathname, prefix)) || (item.children ?? []).some((child) => matches(pathname, child.to));
}

/** The exact entry that should look selected: a child if one matches, otherwise the item. */
export function activeEntry(pathname: string, item: NavItem): string | null {
  const child = (item.children ?? []).find((candidate) => matches(pathname, candidate.to));

  if (child) return child.to;

  return matches(pathname, item.to) || (item.also ?? []).some((prefix) => matches(pathname, prefix)) ? item.to : null;
}

/** Pages offered by the command menu. Includes routes that have no sidebar entry (Logs). */
export const NAV_ROUTES: Array<{ label: string; to: string; icon: LucideIcon; group: string }> = [
  ...NAV.flatMap((item) => [
    { label: item.label, to: item.to, icon: item.icon, group: "Navigate" },
    ...(item.children ?? []).map((child) => ({ label: child.label, to: child.to, icon: item.icon, group: item.label })),
  ]),
  { label: "Logs", to: "/logs", icon: ScrollText, group: "Navigate" },
];
