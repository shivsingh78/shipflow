import { useMemo } from "react";
import { useApi } from "@/auth/AuthProvider";
import type { ListReleasesOptions, Project, ProjectDetail, SecretInfo } from "@/api/types";
import { useResource } from "./useResource";
import type { ResourceOptions } from "./useResource";

export function useWhoAmI() {
  const api = useApi();

  return useResource((signal) => api.whoami(signal), [api]);
}

export function useReadiness(options?: ResourceOptions) {
  const api = useApi();

  return useResource((signal) => api.ready(signal), [api], options);
}

export function useProjects(options?: ResourceOptions) {
  const api = useApi();

  return useResource((signal) => api.listProjects(signal), [api], options);
}

export function useProject(name: string, options?: ResourceOptions) {
  const api = useApi();

  return useResource((signal) => api.getProject(name, signal), [api, name], options);
}

export interface ProjectWithState {
  project: Project;
  activeReleaseId: string | null;
  secrets: SecretInfo[];
}

/** Every project with its full configuration (one request per project). */
export function useProjectDetails(options?: ResourceOptions) {
  const api = useApi();

  return useResource<ProjectWithState[]>(
    async (signal) => {
      const summaries = await api.listProjects(signal);
      const details: ProjectDetail[] = await Promise.all(summaries.map((p) => api.getProject(p.name, signal)));

      return details.map((d) => ({ project: d.project, activeReleaseId: d.activeReleaseId, secrets: d.secrets }));
    },
    [api],
    options
  );
}

export function useReleases(options: ListReleasesOptions & ResourceOptions = {}) {
  const api = useApi();
  const { pollMs, enabled, ...query } = options;
  const key = JSON.stringify(query);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures `query`.
  const stable = useMemo(() => query, [key]);

  return useResource((signal) => api.listReleases(stable, signal), [api, stable], { pollMs, enabled });
}

export function useRelease(releaseId: string, options?: ResourceOptions) {
  const api = useApi();

  return useResource((signal) => api.getRelease(releaseId, signal), [api, releaseId], options);
}

export function useReleaseLogs(releaseId: string, options?: ResourceOptions) {
  const api = useApi();

  return useResource((signal) => api.getReleaseLogs(releaseId, signal), [api, releaseId], options);
}

export function useEvidence(releaseId: string, options?: ResourceOptions) {
  const api = useApi();

  return useResource((signal) => api.getEvidence(releaseId, signal), [api, releaseId], options);
}
