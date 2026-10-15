// Target "shipflow": the ShipFlow site server streams the release straight
// from artifact storage. Activation is the pointer row in `activations`
// (an atomic database insert); no files are copied.
import { config } from "../config.js";
import { verifyCandidate, verifyActive } from "../verify.js";

export const shipflowTarget = {
  name: "shipflow",
  description: "Served by the ShipFlow site server from artifact storage",
  capabilities: {
    candidateVerification: "http",
    atomicActivation: true,
    rollback: true,
  },

  requiredSecrets: () => [],

  async check() {
    return [{ name: "site server", ok: true, detail: config.internalSiteUrl }];
  },

  async prepare() {
    // The artifact already in storage *is* the candidate.
    return { detail: "artifact is served from storage; nothing to transfer" };
  },

  async verifyCandidate({ releaseId }) {
    const result = await verifyCandidate({ releaseId });
    return { detail: `candidate served HTTP ${result.statusCode} (${result.contentType})` };
  },

  async activate() {
    // The pointer row inserted by activateRelease() is the activation.
  },

  async verifyLive({ releaseId, targetConfig }) {
    const result = await verifyActive({ releaseId, hostname: targetConfig.hostname });
    return {
      url: result.url,
      detail: `Live site serves ${releaseId}: HTTP ${result.statusCode} (${result.contentType})`,
    };
  },

  liveUrl({ targetConfig }) {
    return targetConfig.hostname ? `http://${targetConfig.hostname}/` : config.publicSiteUrl;
  },
};
