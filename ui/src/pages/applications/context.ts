import { useOutletContext } from "react-router-dom";
import type { Project, Release, SecretInfo, WhoAmI } from "@/api/types";

/** What the detail layout loads once and hands to every tab. */
export interface ApplicationContext {
  name: string;
  project: Project;
  secrets: SecretInfo[];
  activeReleaseId: string | null;
  releases: Release[];
  releasesLoading: boolean;
  releasesError: unknown;
  whoami: WhoAmI | undefined;
  /** Reload the project, its secrets and its releases. */
  refresh: () => Promise<void>;
}

export const useApplication = () => useOutletContext<ApplicationContext>();

/** The newest deployment-mode release that is not cancelled. */
export function latestDeploy(releases: Release[]): Release | undefined {
  return releases.find((r) => r.mode === "deploy" && r.status !== "CANCELLED");
}
