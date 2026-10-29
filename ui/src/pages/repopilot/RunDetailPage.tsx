import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, ExternalLink, RefreshCw } from "lucide-react";
import { useApi } from "@/auth/AuthProvider";
import { ApiError, describeError } from "@/api/errors";
import type { RpFinding, RpPatch, RpVerification } from "@/api/repopilotTypes";
import { Badge, Banner, Button, Card, CardBody, CardHeader, Checkbox, ConfirmDialog, CopyValue, EmptyState, ErrorState, KeyValue, PageHeader, Spinner, useToast } from "@/components/ui";
import { useRepoPilotFindings, useRepoPilotLogs, useRepoPilotPatches, useRepoPilotRun, useRepoPilotVerifications } from "@/data/repopilot";
import { formatDuration, formatTime } from "@/lib/format";
import { useAutoPoll } from "../runs/useAutoPoll";
import { Diff } from "./Diff";
import { OUTCOME, RUN_STATE, authorizationBlocker, canCancel, isActive, ladderFor, needsPerson, percent, reasonText, shortSha } from "./model";
import "./repopilot.css";

const SEVERITY_TONE = { low: "neutral", medium: "info", high: "warning", critical: "danger" } as const;

export default function RunDetailPage() {
  const params = useParams();
  const runId = /^[1-9][0-9]{0,14}$/.test(params.runId ?? "") ? Number(params.runId) : 0;
  const { pollMs, sync } = useAutoPoll(3000);
  const run = useRepoPilotRun(runId, { pollMs, enabled: runId > 0 });
  const findings = useRepoPilotFindings(runId, { pollMs, enabled: runId > 0 });
  const patches = useRepoPilotPatches(runId, { pollMs, enabled: runId > 0 });
  const verifications = useRepoPilotVerifications(runId, { pollMs, enabled: runId > 0 });
  const logs = useRepoPilotLogs(runId, { pollMs, enabled: runId > 0 });

  sync(run.data ? isActive(run.data.run.state) && !needsPerson(run.data.run.state) : undefined);

  if (runId === 0) return <ErrorState error={new ApiError("That is not a valid run id.", 400)} title="Run not found" />;
  if (run.status === "loading") return <Spinner label="Loading run" />;
  if (run.status === "error") return <ErrorState error={run.error} onRetry={() => void run.refresh()} title="Could not load this run" />;
  if (!run.data) return null;

  const { run: r, stages, outcomes, pullRequest } = run.data;
  const refreshAll = () => void Promise.all([run.refresh(), findings.refresh(), patches.refresh(), verifications.refresh(), logs.refresh()]);
  const latestPatch = [...(patches.data ?? [])].sort((a, b) => b.id - a.id)[0];
  const outcome = outcomes.find((o) => o.patchId === latestPatch?.id);

  return (
    <>
      <Link to="/repopilot" className="rp-back"><ArrowLeft size={14} aria-hidden /> RepoPilot</Link>
      <PageHeader
        title={<>Run #{r.id} <Badge tone={RUN_STATE[r.state].tone}>{RUN_STATE[r.state].label}</Badge></>}
        description={<><code>{r.repo.owner}/{r.repo.name}</code> at <code title={r.commitSha ?? undefined}>{shortSha(r.commitSha)}</code>{r.requestedRef ? <> (requested “{r.requestedRef}”)</> : null}</>}
        actions={<><Button icon={<RefreshCw size={14} aria-hidden className={run.refreshing ? "spin" : undefined} />} onClick={refreshAll}>Refresh</Button><CancelButton runId={r.id} enabled={canCancel(r)} onDone={refreshAll} /></>}
      />

      {r.failure ? <Banner tone="danger" title={`This run failed (${r.failure.code})`}>{r.failure.detail ?? "No further detail was recorded."} Nothing was proposed from this run.</Banner> : null}
      {r.state === "cancelled" ? <Banner tone="info" title="This run was cancelled">Nothing further will happen.</Banner> : null}
      {r.cancelRequested && isActive(r.state) ? <Banner tone="warning" title="Cancelling">The current step will stop at its next checkpoint.</Banner> : null}

      <div className="rp-stack">
        <Card>
          <CardHeader title="Progress" description="Where the run is, and what each step actually did." />
          <CardBody>
            <ol className="rp-steps">
              {stages.map((s) => (
                <li key={`${s.stage}-${s.attempt}`} className="row">
                  <Badge tone={s.state === "succeeded" ? "success" : s.state === "failed" ? "danger" : s.state === "running" ? "info" : "neutral"}>{s.state}</Badge>
                  <span className="grow">{s.stage}{s.attempt > 1 ? ` (attempt ${s.attempt})` : ""}{s.error ? <span className="muted"> — {s.error.code}: {s.error.detail}</span> : null}</span>
                  <span className="muted">{formatTime(s.startedAt)}</span>
                </li>
              ))}
              {stages.length === 0 ? <li className="muted">Waiting for a worker to pick this run up.</li> : null}
            </ol>
          </CardBody>
        </Card>

        <FindingsCard runId={r.id} state={r.state} findings={findings.data} loading={findings.status === "loading"} error={findings.status === "error" ? findings.error : undefined} onChanged={refreshAll} />

        <PatchCard patch={latestPatch} loading={patches.status === "loading"} />

        <VerificationCard verifications={(verifications.data?.verifications ?? []).filter((v) => v.patchId === latestPatch?.id)} outcome={outcome} patchPassed={latestPatch?.policy.passed} />

        <PullRequestCard run={r} patch={latestPatch} outcome={outcome} pullRequest={pullRequest} onChanged={refreshAll} />

        <Card>
          <CardHeader title="Log" description="Progress messages from the worker. Source code and credentials are never logged." />
          <CardBody>
            {logs.data && logs.data.length > 0 ? (
              <pre className="rp-log" tabIndex={0} aria-label="Run log">{logs.data.map((l) => `${formatTime(l.at)}  ${l.level.padEnd(5)} ${l.stage.padEnd(8)} ${l.message}`).join("\n")}</pre>
            ) : <p className="muted">No log lines yet.</p>}
            <p className="muted">AI usage on this run: {r.ai.requests} request(s), {r.ai.inputTokens.toLocaleString()} input / {r.ai.outputTokens.toLocaleString()} output tokens (billed to your provider key).</p>
          </CardBody>
        </Card>
      </div>
    </>
  );
}

function CancelButton({ runId, enabled, onDone }: { runId: number; enabled: boolean; onDone: () => void }) {
  const api = useApi();
  const toast = useToast();
  const [open, setOpen] = useState(false);

  if (!enabled) return null;

  return (
    <>
      <Button onClick={() => setOpen(true)}>Cancel run</Button>
      <ConfirmDialog
        open={open}
        title="Cancel this run?"
        description="The current step stops at its next checkpoint. Work already done is kept for review, but nothing further will happen."
        confirmLabel="Cancel run"
        tone="danger"
        onClose={() => setOpen(false)}
        onConfirm={async () => {
          try {
            await api.repopilot.cancelRun(runId);
            setOpen(false);
            onDone();
          } catch (error) {
            toast.error("Could not cancel", describeError(error));
          }
        }}
      />
    </>
  );
}

function FindingsCard({ runId, state, findings, loading, error, onChanged }: { runId: number; state: string; findings: RpFinding[] | undefined; loading: boolean; error: unknown; onChanged: () => void }) {
  const api = useApi();
  const toast = useToast();
  const [busy, setBusy] = useState<number | null>(null);

  const request = async (finding: RpFinding) => {
    setBusy(finding.id);

    try {
      await api.repopilot.requestPatch(runId, finding.id);
      toast.success("Patch requested", "The patch and its test are being written. This uses your AI key.");
      onChanged();
    } catch (error_) {
      toast.error("Could not request a patch", describeError(error_));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader title="Findings" description="Suggestions from an AI model, ranked. They are not confirmed defects: read the evidence and the code before acting." />
      <CardBody>
        {loading ? <Spinner label="Loading findings" /> : null}
        {error ? <ErrorState error={error} title="Could not load findings" /> : null}
        {findings && findings.length === 0 && !["queued", "ingesting", "analyzing"].includes(state) ? <EmptyState title="No findings" description="The model reported nothing it could justify citing. That is not a guarantee the code is free of problems." /> : null}
        <ul className="rp-findings">
          {(findings ?? []).map((f) => (
            <li key={f.id} className="rp-finding">
              <div className="row">
                <strong className="grow">#{f.rank} {f.title}</strong>
                <Badge tone={SEVERITY_TONE[f.severity]}>{f.severity}</Badge>
                <Badge outline title="Whether the model says the code shown demonstrably misbehaves">{f.evidenceKind === "observed" ? "cited as observed" : "hypothesis"}</Badge>
              </div>
              <p className="muted"><code>{f.file}:{f.lineStart}{f.lineEnd !== f.lineStart ? `–${f.lineEnd}` : ""}</code> · {f.category} · AI suggestion · the model rated its own confidence {percent(f.modelConfidence)} (an estimate, not a measurement)</p>
              <p>{f.evidence}</p>
              <p className="muted">Impact: {f.impact} · Direction: {f.remediation}</p>
              {state === "awaiting_patch" ? <Button size="sm" loading={busy === f.id} disabled={busy !== null} onClick={() => void request(f)}>Generate a patch for this</Button> : null}
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

function PatchCard({ patch, loading }: { patch: RpPatch | undefined; loading: boolean }) {
  return (
    <Card>
      <CardHeader title="Proposed change" description="One source change and one new regression test, both written by an AI model." />
      <CardBody>
        {loading ? <Spinner label="Loading patch" /> : null}
        {!loading && !patch ? <p className="muted">No patch yet. Choose a finding above to generate one.</p> : null}
        {patch ? (
          <>
            <KeyValue items={[
              { label: "Title", value: patch.title },
              { label: "Based on commit", value: <code>{shortSha(patch.baseCommit)}</code> },
              { label: "Patch digest", value: <CopyValue value={patch.diffSha256} display={`sha256:${patch.diffSha256.slice(0, 16)}…`} /> },
            ]} />
            <p>{patch.explanation}</p>
            {!patch.policy.passed ? (
              <Banner tone="danger" title="Rejected by RepoPilot's patch policy">
                This proposal will not be verified or proposed. It is kept so you can see what was rejected and why.
                <ul>
                  {(patch.policy.details.issues ?? []).map((i, n) => <li key={`p${n}`}>{i.message}{i.path ? ` (${i.path})` : ""}</li>)}
                  {(patch.policy.details.apply?.issues ?? []).filter((i) => i.code !== "not_applied").map((i, n) => <li key={`a${n}`}>{i.message}{i.path ? ` (${i.path})` : ""}</li>)}
                </ul>
              </Banner>
            ) : null}
            <h3 className="rp-h3">Source change</h3>
            <Diff text={patch.diff} label="Source diff" />
            <h3 className="rp-h3">New regression test</h3>
            <Diff text={patch.testDiff} label="Test diff" />
          </>
        ) : null}
      </CardBody>
    </Card>
  );
}

function VerificationCard({ verifications, outcome, patchPassed }: { verifications: RpVerification[]; outcome: { outcome: keyof typeof OUTCOME; reasons: string[] } | undefined; patchPassed: boolean | undefined }) {
  return (
    <Card>
      <CardHeader title="Verification" description="Baseline, control and patched test runs in an isolated sandbox. Only sandbox results count; the AI cannot supply them." />
      <CardBody>
        {patchPassed === undefined ? <p className="muted">Nothing to verify yet.</p> : null}
        {patchPassed === false ? <p className="muted">The patch was rejected, so it was not verified.</p> : null}
        {outcome ? (
          <Banner tone={outcome.outcome === "improved" ? "success" : outcome.outcome === "regressed" ? "danger" : "warning"} title={`Outcome: ${OUTCOME[outcome.outcome].label}`}>
            {OUTCOME[outcome.outcome].meaning}
            {outcome.reasons.length > 0 ? <ul>{outcome.reasons.map((reason) => <li key={reason}>{reasonText(reason)}</li>)}</ul> : null}
          </Banner>
        ) : null}
        {verifications.length > 0 ? (
          <table className="rp-table">
            <caption className="sr-only">Test runs</caption>
            <thead><tr><th>Run</th><th>#</th><th>Result</th><th>Exit</th><th>Duration</th><th>Command</th></tr></thead>
            <tbody>
              {verifications.map((v) => (
                <tr key={v.id}>
                  <td>{v.arm}</td><td>{v.attempt}</td>
                  <td><Badge tone={v.kind === "exited" ? (v.exitCode === 0 ? "success" : "danger") : "warning"}>{v.kind === "exited" ? (v.exitCode === 0 ? "passed" : "failed") : v.kind.replace(/_/g, " ")}</Badge></td>
                  <td>{v.exitCode ?? "—"}</td><td>{formatDuration(v.durationMs)}</td><td><code>{v.testCommand}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        <p className="muted">Passing tests are evidence, not proof. The regression test was also written by an AI model.</p>
      </CardBody>
    </Card>
  );
}

function PullRequestCard({ run, patch, outcome, pullRequest, onChanged }: { run: { id: number; state: Parameters<typeof authorizationBlocker>[0]["state"]; commitSha: string | null; defaultBranch: string | null }; patch: RpPatch | undefined; outcome: Parameters<typeof authorizationBlocker>[2]; pullRequest: ReturnType<typeof useRepoPilotRun>["data"] extends infer D ? (D extends { pullRequest: infer P } ? P : never) : never; onChanged: () => void }) {
  const api = useApi();
  const toast = useToast();
  const [reviewed, setReviewed] = useState(false);
  const [open, setOpen] = useState(false);
  const blocker = authorizationBlocker(run, patch, outcome);
  const ladder = ladderFor(patch, outcome, pullRequest);

  return (
    <Card>
      <CardHeader title="Pull request" description="Opened only after you approve this exact change. RepoPilot never merges." />
      <CardBody>
        <ol className="rp-ladder" aria-label="Status of the proposal">
          {ladder.map((step) => (
            <li key={step.key} className={`rp-ladder__step rp-ladder__step--${step.status}`}>
              <strong>{step.label}</strong>
              <span>{step.status === "done" ? "Yes" : step.status === "fail" ? "No" : step.status === "warn" ? "Unclear" : "Not yet"} — {step.detail}</span>
            </li>
          ))}
        </ol>

        {pullRequest ? (
          <KeyValue items={[
            { label: "State", value: <Badge tone={pullRequest.state === "opened" ? "success" : pullRequest.state === "failed" ? "danger" : "info"}>{pullRequest.state}</Badge> },
            { label: "Branch", value: <code>{pullRequest.branch}</code> },
            { label: "Authorised by", value: `${pullRequest.authorizedBy} · ${formatTime(pullRequest.authorizedAt)}` },
            ...(pullRequest.url ? [{ label: "Link", value: <a href={pullRequest.url} target="_blank" rel="noreferrer noopener">#{pullRequest.number} <ExternalLink size={12} aria-hidden /></a> }] : []),
            ...(pullRequest.error ? [{ label: "Problem", value: `${pullRequest.error.code}: ${pullRequest.error.detail ?? ""}` }] : []),
          ]} />
        ) : null}

        {!pullRequest && run.state === "ready_for_review" ? (
          blocker ? <Banner tone="warning" title="Cannot be proposed">{blocker}</Banner> : (
            <div className="rp-form">
              {outcome && outcome.outcome !== "improved" ? <Banner tone="warning" title={`The outcome is “${OUTCOME[outcome.outcome].label}”`}>{OUTCOME[outcome.outcome].meaning} You can still propose the change for human review, but it will say so in the pull request.</Banner> : null}
              <Checkbox checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} label="I have read the source diff, the test diff and the verification outcome above, and I want this change proposed for review." />
              <div><Button variant="primary" disabled={!reviewed} onClick={() => setOpen(true)}>Review and authorise pull request…</Button></div>
              <ConfirmDialog
                open={open}
                title="Authorise this pull request?"
                description={<>A draft pull request will be opened against <code>{run.defaultBranch}</code> from a new <code>repopilot/…</code> branch based on commit <code>{shortSha(run.commitSha)}</code>, containing exactly the diffs shown (digest <code>{patch?.diffSha256.slice(0, 12)}…</code>). If anything has changed since you reviewed it, authorisation is refused. RepoPilot will not merge it.</>}
                confirmLabel="Authorise pull request"
                onClose={() => setOpen(false)}
                onConfirm={async () => {
                  if (!patch || !outcome || !run.commitSha) return;

                  try {
                    await api.repopilot.authorizePullRequest(run.id, { patchId: patch.id, diffSha256: patch.diffSha256, baseCommitSha: run.commitSha, outcome: outcome.outcome });
                    toast.success("Authorised", "The pull request is being created.");
                    setOpen(false);
                    onChanged();
                  } catch (error) {
                    toast.error("Authorisation refused", describeError(error));
                  }
                }}
              />
            </div>
          )
        ) : null}
      </CardBody>
    </Card>
  );
}
