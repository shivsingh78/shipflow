import { useApi } from "@/auth/AuthProvider";
import { useResource } from "./useResource";
import type { ResourceOptions } from "./useResource";

export function useRepoPilotStatus() {
  const api = useApi();

  return useResource((signal) => api.repopilot.status(signal), [api]);
}

export function useRepoPilotRepositories() {
  const api = useApi();

  return useResource((signal) => api.repopilot.listRepositories(signal), [api]);
}

export function useRepoPilotCredentials() {
  const api = useApi();

  return useResource((signal) => api.repopilot.listCredentials(signal), [api]);
}

export function useRepoPilotRuns(options?: ResourceOptions) {
  const api = useApi();

  return useResource((signal) => api.repopilot.listRuns(signal), [api], options);
}

export function useRepoPilotRun(runId: number, options?: ResourceOptions) {
  const api = useApi();

  return useResource((signal) => api.repopilot.getRun(runId, signal), [api, runId], options);
}

export function useRepoPilotFindings(runId: number, options?: ResourceOptions) {
  const api = useApi();

  return useResource((signal) => api.repopilot.listFindings(runId, signal), [api, runId], options);
}

export function useRepoPilotPatches(runId: number, options?: ResourceOptions) {
  const api = useApi();

  return useResource((signal) => api.repopilot.listPatches(runId, signal), [api, runId], options);
}

export function useRepoPilotVerifications(runId: number, options?: ResourceOptions) {
  const api = useApi();

  return useResource((signal) => api.repopilot.getVerifications(runId, signal), [api, runId], options);
}

export function useRepoPilotLogs(runId: number, options?: ResourceOptions) {
  const api = useApi();

  return useResource((signal) => api.repopilot.listLogs(runId, signal), [api, runId], options);
}
