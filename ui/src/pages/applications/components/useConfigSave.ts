import { useCallback, useState } from "react";
import { ApiError, describeError } from "@/api/errors";
import type { SaveProjectResult } from "@/api/types";
import { useApi } from "@/auth/AuthProvider";
import type { ProjectConfigIssue } from "@/lib/projectConfig";
import { buildConfig } from "../lib/configForm";
import type { ConfigDraft } from "../lib/configForm";

/** Server problems that name no field still belong somewhere sensible. */
function placeServerError(error: ApiError): ProjectConfigIssue[] {
  if (error.issues.length > 0) return error.issues.map((i) => ({ path: i.path ?? "(root)", message: i.message }));
  if (error.status === 409 && /hostname/i.test(error.message)) return [{ path: "deployment.shipflow.hostname", message: error.message }];
  if (error.status === 400 && /repositor|repo/i.test(error.message)) return [{ path: "project.repository", message: error.message }];

  return [];
}

/** Validate a draft with the shared validator, then save it with PUT /projects/:name. */
export function useConfigSave(allowedPrefixes: readonly string[]) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<ProjectConfigIssue[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  const reset = useCallback(() => {
    setIssues([]);
    setMessage(null);
  }, []);

  const save = useCallback(
    async (draft: ConfigDraft): Promise<SaveProjectResult | null> => {
      reset();

      const built = buildConfig(draft, allowedPrefixes);

      if (!built.ok) {
        setIssues(built.issues);
        setMessage("Fix the highlighted problems, then save again.");

        return null;
      }

      setBusy(true);

      try {
        return await api.saveProject(built.config);
      } catch (caught) {
        if (caught instanceof ApiError) {
          const placed = placeServerError(caught);

          setIssues(placed);
          setMessage(describeError(caught));
        } else {
          setMessage(describeError(caught));
        }

        return null;
      } finally {
        setBusy(false);
      }
    },
    [api, allowedPrefixes, reset]
  );

  return { save, busy, issues, message, reset };
}
