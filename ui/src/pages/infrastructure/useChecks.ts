import { useCallback, useState } from "react";
import { useApi } from "@/auth/AuthProvider";
import type { CheckResult } from "@/api/types";

export type CheckState =
  | { status: "running" }
  | { status: "done"; ok: boolean; checks: CheckResult[]; at: Date; project: string }
  | { status: "error"; error: unknown; at: Date; project: string };

/**
 * On-demand target diagnostics (POST /projects/:name/check), remembered by key
 * for this page's lifetime only. Nothing is polled or persisted.
 */
export function useChecks() {
  const api = useApi();
  const [states, setStates] = useState<Record<string, CheckState>>({});

  const run = useCallback(
    async (key: string, project: string) => {
      setStates((s) => ({ ...s, [key]: { status: "running" } }));

      try {
        const result = await api.checkProject(project);

        setStates((s) => ({ ...s, [key]: { status: "done", ok: result.ok, checks: result.checks, at: new Date(), project } }));
      } catch (error) {
        setStates((s) => ({ ...s, [key]: { status: "error", error, at: new Date(), project } }));
      }
    },
    [api]
  );

  return { states, run };
}
