import { Banner, Button } from "@/components/ui";
import type { ProjectConfigIssue } from "@/lib/projectConfig";
import { isFieldPath, normalizePath, stepOfPath, STEPS } from "../lib/configForm";
import type { StepNumber } from "../lib/configForm";

/**
 * Problems that no form field shows inline (or, with `all`, every problem),
 * each optionally linking to the wizard step that owns it.
 */
export function ErrorSummary({ issues, title = "Fix these before continuing", all = false, onGoToStep }: { issues: readonly ProjectConfigIssue[]; title?: string; all?: boolean; onGoToStep?: (step: StepNumber) => void }) {
  const shown = all ? issues : issues.filter((i) => !isFieldPath(normalizePath(i.path)));

  if (shown.length === 0) return null;

  return (
    <Banner tone="danger" title={title}>
      <ul className="error-list">
        {shown.map((issue, index) => {
          const step = stepOfPath(issue.path);

          return (
            <li key={`${issue.path}-${index}`}>
              <code>{normalizePath(issue.path)}</code> {issue.message}
              {onGoToStep ? (
                <Button size="sm" variant="ghost" onClick={() => onGoToStep(step)}>
                  Fix on step {step}: {STEPS[step - 1]}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Banner>
  );
}
