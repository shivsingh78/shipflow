import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Rocket, RotateCcw, Square } from "lucide-react";
import { describeError } from "@/api/errors";
import type { Release, ReleaseMode } from "@/api/types";
import { useApi } from "@/auth/AuthProvider";
import { Banner, Button, ConfirmDialog, Dialog, TextField, useToast } from "@/components/ui";
import { isActiveStatus } from "@/lib/status";

/** Queue a new release of an application: a real deployment, or a check run that never deploys. */
export function DeployButton({ project, defaultRef, defaultMode = "deploy", label = "Deploy", variant = "primary", onQueued }: { project: string; defaultRef?: string; defaultMode?: ReleaseMode; label?: string; variant?: "primary" | "secondary"; onQueued?: (release: Release) => void }) {
  const api = useApi();
  const toast = useToast();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [ref, setRef] = useState(defaultRef ?? "");
  const [mode, setMode] = useState<ReleaseMode>(defaultMode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);

    try {
      const release = await api.deploy({ project, ...(ref.trim() ? { ref: ref.trim() } : {}), mode });

      toast.success(mode === "check" ? "Check queued" : "Deployment queued", `Release ${release.release_id} is waiting for a worker.`);
      setOpen(false);
      onQueued?.(release);
      void navigate(`/releases/${release.release_id}`);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant={variant} icon={<Rocket size={14} aria-hidden />} onClick={() => { setError(null); setOpen(true); }}>
        {label}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`${label} ${project}`}
        footer={
          <>
            <Button onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
            <Button variant="primary" onClick={() => void submit()} loading={busy}>
              {mode === "check" ? "Queue check" : "Queue deployment"}
            </Button>
          </>
        }
      >
        <div className="stack" style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          <TextField label="Branch, tag or commit" value={ref} onChange={(e) => setRef(e.target.value)} placeholder={defaultRef ?? "default branch"} hint="Leave empty to use the project's configured branch." />
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="field__label" style={{ marginBottom: 6 }}>What to run</legend>
            <label className="check">
              <input type="radio" name="mode" checked={mode === "deploy"} onChange={() => setMode("deploy")} />
              <span>
                <strong>Build and deploy</strong>
                <span className="field__hint" style={{ display: "block" }}>Builds, tests, stores the artifact, verifies a candidate, then switches the live release.</span>
              </span>
            </label>
            <label className="check" style={{ marginTop: 8 }}>
              <input type="radio" name="mode" checked={mode === "check"} onChange={() => setMode("check")} />
              <span>
                <strong>Check only</strong>
                <span className="field__hint" style={{ display: "block" }}>Prepares, builds and tests. Never deploys and never reads deployment secrets.</span>
              </span>
            </label>
          </fieldset>
          {error ? <Banner tone="danger" title="Could not queue the release">{error}</Banner> : null}
        </div>
      </Dialog>
    </>
  );
}

/** Stop a queued or running release. A release that already started activating cannot be stopped. */
export function CancelReleaseButton({ release, onDone }: { release: Release; onDone?: () => void }) {
  const api = useApi();
  const toast = useToast();
  const [open, setOpen] = useState(false);

  if (!isActiveStatus(release.status)) return null;

  return (
    <>
      <Button variant="secondary" icon={<Square size={13} aria-hidden />} onClick={() => setOpen(true)} disabled={release.cancel_requested}>
        {release.cancel_requested ? "Cancelling…" : "Cancel"}
      </Button>
      <ConfirmDialog
        open={open}
        title={`Cancel release ${release.release_id}?`}
        description="A queued release is cancelled immediately. A running one stops at its next checkpoint, and never once activation has begun."
        confirmLabel="Cancel release"
        tone="danger"
        onClose={() => setOpen(false)}
        onConfirm={async () => {
          try {
            const result = await api.cancelRelease(release.release_id);

            toast.success(result.status === "CANCELLED" ? "Release cancelled" : "Cancel requested", result.message);
            setOpen(false);
            onDone?.();
          } catch (caught) {
            toast.error("Could not cancel", describeError(caught));
          }
        }}
      />
    </>
  );
}

/** Whether a release can be made live again: a successful deployment, not live, artifact still stored. */
export function canRollbackTo(release: Release): boolean {
  return release.mode === "deploy" && release.status === "SUCCESS" && !release.is_active && !release.artifacts_pruned && release.artifact_path !== null;
}

export function RollbackButton({ release, onDone }: { release: Release; onDone?: () => void }) {
  const api = useApi();
  const toast = useToast();
  const [open, setOpen] = useState(false);

  if (!canRollbackTo(release)) return null;

  return (
    <>
      <Button icon={<RotateCcw size={14} aria-hidden />} onClick={() => setOpen(true)}>
        Roll back to this release
      </Button>
      <ConfirmDialog
        open={open}
        title={`Roll back ${release.project} to ${release.release_id}?`}
        description={
          <>
            This makes <code>{release.release_id}</code> the live release of <strong>{release.project}</strong> again. Nothing is rebuilt: the stored artifact is put back on the
            project&apos;s current target and health-checked first. If its live check fails, the release that was live is restored.
          </>
        }
        confirmLabel="Roll back"
        tone="danger"
        onClose={() => setOpen(false)}
        onConfirm={async () => {
          try {
            const result = await api.rollback(release.release_id);

            toast.success("Rolled back", `${result.project} now serves ${result.targetReleaseId}.`);
            setOpen(false);
            onDone?.();
          } catch (caught) {
            toast.error("Rollback failed", describeError(caught));
          }
        }}
      />
    </>
  );
}
