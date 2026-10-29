import { ApiError } from "./errors";
import type { RepoPilotApi } from "./repopilotTypes";

/**
 * RepoPilot analyses real repositories with your own AI key, so there is no
 * honest sample data for it. Demo mode says so instead of inventing findings,
 * test results or pull requests.
 */
export function createDemoRepoPilot(): RepoPilotApi {
  const unavailable = (): Promise<never> =>
    Promise.reject(new ApiError("RepoPilot is not available in the sample-data demo. Sign in to a ShipFlow server to use it.", 404, [], "repopilot_disabled"));

  return {
    status: () =>
      Promise.resolve({
        enabled: false,
        message: "RepoPilot is not available in the sample-data demo. It analyses real repositories using your own AI provider key, so no sample results are shown.",
        problems: [],
        limitations: [],
      }),
    listRepositories: unavailable,
    authorizeRepository: unavailable,
    revokeRepository: unavailable,
    listCredentials: unavailable,
    setCredential: unavailable,
    deleteCredential: unavailable,
    listRuns: unavailable,
    createRun: unavailable,
    getRun: unavailable,
    cancelRun: unavailable,
    listFindings: unavailable,
    requestPatch: unavailable,
    listPatches: unavailable,
    getVerifications: unavailable,
    listLogs: unavailable,
    authorizePullRequest: unavailable,
  };
}
