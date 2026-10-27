import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, ArrowRight, Plus } from "lucide-react";
import { ApiError, describeError } from "@/api/errors";
import type { SaveProjectResult } from "@/api/types";
import { useApi } from "@/auth/AuthProvider";
import { Banner, Button, Card, CardBody, CardHeader, ErrorState, PageHeader, Skeleton } from "@/components/ui";
import { useWhoAmI } from "@/data/hooks";
import type { ProjectConfigIssue } from "@/lib/projectConfig";
import { BuildAndRuntimeFields, DeploymentMethodFields, RepositoryFields, SourceFields } from "./components/ConfigFields";
import { CreatedPanel } from "./components/CreateStep";
import { ErrorSummary } from "./components/ErrorSummary";
import { ReviewStep } from "./components/ReviewStep";
import { Stepper } from "./components/Stepper";
import { buildConfig, emptyDraft, errorMap, issuesForStep, STEPS } from "./lib/configForm";
import type { ConfigDraft, StepNumber } from "./lib/configForm";
import { clearDraft, loadDraft, saveDraft } from "./lib/draftStorage";
import "./applications.css";

function mapServerIssues(error: ApiError): ProjectConfigIssue[] {
  if (error.issues.length > 0) return error.issues.map((i) => ({ path: i.path ?? "(root)", message: i.message }));
  if (error.status === 409 && /hostname/i.test(error.message)) return [{ path: "deployment.shipflow.hostname", message: error.message }];
  if (error.status === 400 && /repositor|allowed/i.test(error.message)) return [{ path: "project.repository", message: error.message }];

  return [];
}

export default function CreateApplicationPage() {
  const api = useApi();
  const whoami = useWhoAmI();
  const [initial] = useState(loadDraft);
  const [restored, setRestored] = useState(initial !== null);
  const [draft, setDraft] = useState<ConfigDraft>(() => initial?.draft ?? emptyDraft());
  const [step, setStep] = useState<StepNumber>(() => (initial?.step ?? 1) as StepNumber);
  const [reached, setReached] = useState<StepNumber>(() => (initial?.step ?? 1) as StepNumber);
  const [showErrors, setShowErrors] = useState(false);
  const [created, setCreated] = useState<SaveProjectResult | null>(null);
  const [creating, setCreating] = useState(false);
  const [serverIssues, setServerIssues] = useState<ProjectConfigIssue[]>([]);
  const [serverMessage, setServerMessage] = useState<string | null>(null);
  const [existingNames, setExistingNames] = useState<string[]>([]);
  const heading = useRef<HTMLSpanElement>(null);

  const prefixes = useMemo(() => whoami.data?.allowedRepoPrefixes ?? [], [whoami.data]);
  const built = useMemo(() => buildConfig(draft, prefixes), [draft, prefixes]);

  // Existing names: PUT /projects/:name would silently overwrite, so the wizard refuses to reuse one.
  useEffect(() => {
    const controller = new AbortController();

    api.listProjects(controller.signal).then((list) => setExistingNames(list.map((p) => p.name)), () => undefined);

    return () => controller.abort();
  }, [api]);

  // Drafts never hold secret values (those are only typed after creation, into write-only fields).
  useEffect(() => {
    if (!created) saveDraft(step, draft);
  }, [draft, step, created]);

  // Move focus to the step heading when the user changes step (not on first load).
  const firstRender = useRef(true);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }

    heading.current?.focus();
  }, [step]);

  const allIssues = useMemo<ProjectConfigIssue[]>(() => {
    const list = built.ok ? [] : [...built.issues];

    if (existingNames.includes(draft.name.trim())) list.push({ path: "project.name", message: `already exists. Open it from Applications, or choose another name` });

    return [...list, ...serverIssues];
  }, [built, existingNames, draft.name, serverIssues]);

  const stepIssues = (n: StepNumber) => issuesForStep(allIssues, n);
  const visibleIssues = useMemo(() => (showErrors ? issuesForStep(allIssues, step) : []), [showErrors, allIssues, step]);
  const errors = useMemo(() => errorMap(visibleIssues), [visibleIssues]);

  const go = (target: StepNumber) => {
    setShowErrors(false);
    setStep(target);
  };

  const next = () => {
    if (stepIssues(step).length > 0) {
      setShowErrors(true);

      return;
    }

    const target = Math.min(step + 1, 6) as StepNumber;

    setReached((r) => (target > r ? target : r));
    go(target);
  };

  const create = async () => {
    if (!built.ok) {
      setShowErrors(true);
      setServerMessage("The configuration is not valid yet.");

      return;
    }

    setCreating(true);
    setServerIssues([]);
    setServerMessage(null);

    try {
      // Re-check right before the write: PUT would overwrite an existing application.
      const fresh = await api.listProjects();

      if (fresh.some((p) => p.name === built.config.project.name)) {
        setExistingNames(fresh.map((p) => p.name));
        setServerMessage(`An application named ${built.config.project.name} already exists, so nothing was changed. Go back and choose another name.`);

        return;
      }

      setCreated(await api.saveProject(built.config));
      clearDraft();
    } catch (caught) {
      if (caught instanceof ApiError) {
        const issues = mapServerIssues(caught);

        setServerIssues(issues);
        setServerMessage(
          caught.status === 409 ? `${describeError(caught)} (conflict: choose a different value)` : caught.status === 400 ? `The server rejected the configuration. ${describeError(caught)}` : describeError(caught)
        );
      } else {
        setServerMessage(describeError(caught));
      }
    } finally {
      setCreating(false);
    }
  };

  const startOver = () => {
    clearDraft();
    setDraft(emptyDraft());
    setStep(1);
    setReached(1);
    setShowErrors(false);
    setServerIssues([]);
    setServerMessage(null);
    setRestored(false);
  };

  let content;

  if (whoami.status === "loading") content = <Skeleton height={200} />;
  else if (whoami.status === "error") content = <ErrorState error={whoami.error} onRetry={() => void whoami.refresh()} title="Could not load server capabilities" />;
  else {
    const section = { draft, onChange: setDraft, errors };

    content = (
      <>
        {step === 1 ? <RepositoryFields {...section} allowedPrefixes={prefixes} /> : null}
        {step === 2 ? <SourceFields {...section} /> : null}
        {step === 3 ? <DeploymentMethodFields {...section} targets={whoami.data?.targets} /> : null}
        {step === 4 ? <BuildAndRuntimeFields {...section} /> : null}
        {step === 5 ? <ReviewStep config={built.ok ? built.config : null} issues={built.ok ? [] : allIssues} onGoToStep={go} /> : null}
        {step === 6 ? (
          created ? (
            <CreatedPanel result={created} secretsEnabled={whoami.data?.secretsEnabled} />
          ) : (
            <div className="stack">
              <p>
                Creating saves the validated configuration for <strong>{draft.name || "this application"}</strong>. Nothing is built or deployed until you choose to. Required secrets are set right after, write-only.
              </p>
              {serverMessage ? <Banner tone="danger" title="The application was not created">{serverMessage}</Banner> : null}
              <ErrorSummary issues={serverIssues} all title="Server validation" onGoToStep={go} />
              {!built.ok ? <ErrorSummary issues={allIssues} all title="Fix these first" onGoToStep={go} /> : null}
              <div>
                <Button variant="primary" icon={<Plus size={14} aria-hidden />} loading={creating} disabled={!built.ok || existingNames.includes(draft.name.trim())} onClick={() => void create()}>Create application</Button>
              </div>
            </div>
          )
        ) : null}
      </>
    );
  }

  return (
    <div className="apps-page">
      <PageHeader title="New application" description="Connect a repository, choose where it deploys, and review the configuration before anything is created." actions={<Link to="/applications" className="btn"><ArrowLeft size={14} aria-hidden />Applications</Link>} />
      {restored && !created ? (
        <Banner tone="info" title="Draft restored" action={<Button size="sm" onClick={startOver}>Start over</Button>}>
          Your earlier answers were restored from this browser tab. Drafts never include secret values.
        </Banner>
      ) : null}
      <div style={{ height: "var(--space-3)" }} />
      <Stepper current={step} reached={reached} onGo={go} locked={created !== null} />
      <Card>
        <CardHeader title={<span tabIndex={-1} ref={heading} style={{ outline: "none" }}>{`Step ${step} of ${STEPS.length}: ${STEPS[step - 1]}`}</span>} />
        <CardBody>
          <div className="stack">
            {step <= 4 ? <ErrorSummary issues={visibleIssues} title="Fix these before continuing" /> : null}
            {content}
          </div>
        </CardBody>
      </Card>
      {!created ? (
        <div className="wizard-nav">
          <Button onClick={() => go(Math.max(step - 1, 1) as StepNumber)} disabled={step === 1} icon={<ArrowLeft size={14} aria-hidden />}>Back</Button>
          {step < 5 ? (
            <Button variant="primary" onClick={next} disabled={whoami.status !== "ready"}>Next<ArrowRight size={14} aria-hidden /></Button>
          ) : step === 5 ? (
            <Button variant="primary" onClick={next} disabled={!built.ok}>Continue to create<ArrowRight size={14} aria-hidden /></Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
