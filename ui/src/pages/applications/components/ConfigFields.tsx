// Form sections shared by the creation wizard and "Edit configuration".
import { useRef } from "react";
import type { KeyboardEvent } from "react";
import { Badge, Banner, Checkbox, SelectField, TextAreaField, TextField } from "@/components/ui";
import type { TargetInfo } from "@/api/types";
import { BUILD_STRATEGIES, IMAGE_TARGETS, TARGETS } from "@/lib/projectConfig";
import type { TargetName } from "@/lib/projectConfig";
import { targetLabel } from "@/lib/status";
import { isImageTargetName, setDraftTarget, withTarget } from "../lib/configForm";
import type { ConfigDraft, FieldErrors } from "../lib/configForm";
import { EnvEditor } from "./EnvEditor";

interface SectionProps {
  draft: ConfigDraft;
  onChange: (next: ConfigDraft) => void;
  errors: FieldErrors;
}

export function RepositoryFields({ draft, onChange, errors, nameLocked = false, allowedPrefixes }: SectionProps & { nameLocked?: boolean; allowedPrefixes: readonly string[] }) {
  return (
    <div className="stack">
      <TextField
        label="Application name"
        required
        value={draft.name}
        disabled={nameLocked}
        onChange={(e) => onChange({ ...draft, name: e.target.value.toLowerCase() })}
        error={errors.get("project.name")}
        hint={nameLocked ? "The name identifies the application and cannot be changed." : "Lowercase letters, digits and dashes, up to 63 characters. It cannot be changed later."}
        autoComplete="off"
        spellCheck={false}
      />
      <TextField
        label="Repository URL"
        required
        type="url"
        inputMode="url"
        value={draft.repository}
        onChange={(e) => onChange({ ...draft, repository: e.target.value })}
        error={errors.get("project.repository")}
        placeholder="https://github.com/acme/app"
        hint={
          <>
            Paste the repository URL. There is no GitHub sign-in: ShipFlow clones with the server&apos;s own access.{" "}
            {allowedPrefixes.length > 0 ? (
              <>
                Allowed on this server: <code>{allowedPrefixes.join(", ")}</code>. Do not include credentials in the URL.
              </>
            ) : (
              "Do not include credentials in the URL."
            )}
          </>
        }
        autoComplete="off"
        spellCheck={false}
      />
    </div>
  );
}

export function SourceFields({ draft, onChange, errors }: SectionProps) {
  return (
    <div className="stack">
      <TextField label="Branch" value={draft.branch} onChange={(e) => onChange({ ...draft, branch: e.target.value })} error={errors.get("project.branch")} hint="The branch to build by default." autoComplete="off" spellCheck={false} />
      <fieldset className="stack--sm stack plain-fieldset">
        <legend className="field__label">GitHub automation</legend>
        <Checkbox label="Deploy on push" checked={draft.deployOnPush} onChange={(e) => onChange({ ...draft, deployOnPush: e.target.checked })} description="A push to the deploy branch queues a real deployment. Requires GitHub webhooks to be enabled on this server." />
        <Checkbox label="Check pull requests" checked={draft.checkPullRequests} onChange={(e) => onChange({ ...draft, checkPullRequests: e.target.checked })} description="Pull requests run a check (prepare, build, test). They never deploy." />
        <TextField label="Deploy branch" value={draft.deployBranch} onChange={(e) => onChange({ ...draft, deployBranch: e.target.value })} error={errors.get("github.deployBranch")} placeholder={draft.branch || "main"} hint="Only pushes to this branch deploy. Empty: the branch above." autoComplete="off" spellCheck={false} />
      </fieldset>
    </div>
  );
}

function TargetCards({ value, onChange, targets }: { value: TargetName; onChange: (target: TargetName) => void; targets: TargetInfo[] | undefined }) {
  const names = (targets?.map((t) => t.name).filter((n): n is TargetName => TARGETS.includes(n)) ?? (TARGETS as TargetName[]));
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const onKey = (event: KeyboardEvent, index: number) => {
    const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;

    if (delta === 0) return;

    event.preventDefault();

    const next = (index + delta + names.length) % names.length;
    const name = names[next];

    if (name) {
      onChange(name);
      refs.current[next]?.focus();
    }
  };

  return (
    <div role="radiogroup" aria-label="Deployment method" className="choice-grid">
      {names.map((name, index) => {
        const info = targets?.find((t) => t.name === name);
        const selected = value === name;

        return (
          <button
            key={name}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected || (!names.includes(value) && index === 0) ? 0 : -1}
            ref={(el) => { refs.current[index] = el; }}
            className="choice"
            onClick={() => onChange(name)}
            onKeyDown={(e) => onKey(e, index)}
          >
            <span className="stack--sm stack" style={{ minWidth: 0 }}>
              <span className="choice__title">{targetLabel(name)}</span>
              <span className="choice__desc">{info?.description ?? "Description not available."}</span>
              <span className="row row--wrap" style={{ gap: 4 }}>
                <Badge outline>{IMAGE_TARGETS.includes(name) ? "Container image" : "Static files"}</Badge>
                {name === "docker" ? <Badge tone="success" outline>Tested end to end</Badge> : null}
                {name === "kubernetes" ? <Badge tone="warning">Experimental: not verified on a real cluster</Badge> : null}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function DeploymentMethodFields({ draft, onChange, errors, targets }: SectionProps & { targets: TargetInfo[] | undefined }) {
  const image = isImageTargetName(draft.target);

  return (
    <div className="stack">
      <TargetCards value={draft.target} onChange={(target) => onChange(withTarget(draft, target))} targets={targets} />
      {errors.get("deployment.target") ? <div className="field__error" role="alert">{errors.get("deployment.target")}</div> : null}
      {draft.target === "kubernetes" ? (
        <Banner tone="warning" title="Experimental: not verified on a real cluster">
          The Kubernetes target is implemented and tested against a fake API server only. Try it on a non-critical cluster first.
        </Banner>
      ) : null}
      <SelectField label="Build strategy" value={draft.strategy} onChange={(e) => onChange({ ...draft, strategy: e.target.value as ConfigDraft["strategy"] })} error={errors.get("build.strategy")} hint={image ? "Image targets build a container: use node or dockerfile (or let ShipFlow detect it). \"static\" is not allowed." : "Static targets serve files: \"node\" and \"dockerfile\" produce container images and are not allowed. Leave on automatic to detect."}>
        <option value="">Detect automatically</option>
        {BUILD_STRATEGIES.map((s) => (
          <option key={s} value={s} disabled={image ? s === "static" : s !== "static"}>
            {s}
            {image ? (s === "static" ? " (not for image targets)" : "") : s !== "static" ? " (needs an image target)" : ""}
          </option>
        ))}
      </SelectField>
      {draft.strategy === "dockerfile" ? (
        <TextField label="Dockerfile path" value={draft.dockerfile} onChange={(e) => onChange({ ...draft, dockerfile: e.target.value })} error={errors.get("build.dockerfile")} placeholder="Dockerfile" hint="Relative to the repository root." autoComplete="off" spellCheck={false} />
      ) : null}
      {image ? <p className="muted">Image targets need a runtime port, set in the next step.</p> : null}
    </div>
  );
}

export function BuildFields({ draft, onChange, errors }: SectionProps) {
  return (
    <div className="stack">
      <Banner tone="info" title="Commands run in the build sandbox">
        Install, build and test commands run inside ShipFlow&apos;s isolated build sandbox, not on your servers. Leave a command empty to let ShipFlow detect it.
      </Banner>
      <div className="grid grid--2">
        <SelectField label="Install dependencies" value={draft.install} onChange={(e) => onChange({ ...draft, install: e.target.value as "auto" | "none" })} error={errors.get("build.install")}>
          <option value="auto">auto (from the lockfile)</option>
          <option value="none">none (skip install)</option>
        </SelectField>
        <TextField label="Build command" value={draft.command} onChange={(e) => onChange({ ...draft, command: e.target.value })} error={errors.get("build.command")} placeholder="auto" hint="Runs in the build sandbox." autoComplete="off" spellCheck={false} />
        {!isImageTargetName(draft.target) ? (
          <TextField label="Output directory" value={draft.output} onChange={(e) => onChange({ ...draft, output: e.target.value })} error={errors.get("build.output")} placeholder="auto" hint="Relative to the repository, e.g. dist." autoComplete="off" spellCheck={false} />
        ) : null}
        <TextField label="Test command" value={draft.test} onChange={(e) => onChange({ ...draft, test: e.target.value })} error={errors.get("build.test")} placeholder="auto" hint="Runs in the build sandbox." autoComplete="off" spellCheck={false} />
      </div>
      <EnvEditor label="Build environment" prefix="build.env" rows={draft.buildEnv} onChange={(buildEnv) => onChange({ ...draft, buildEnv })} errors={errors} />
    </div>
  );
}

export function RuntimeFields({ draft, onChange, errors }: SectionProps) {
  if (!isImageTargetName(draft.target)) {
    return <p className="muted">Runtime settings only apply to image targets (Docker, Kubernetes). {targetLabel(draft.target)} serves static files.</p>;
  }

  return (
    <div className="stack">
      {errors.get("runtime") ? <div className="field__error" role="alert">{errors.get("runtime")}</div> : null}
      <div className="grid grid--2">
        <TextField label="Container port" required inputMode="numeric" value={draft.runtimePort} onChange={(e) => onChange({ ...draft, runtimePort: e.target.value })} error={errors.get("runtime.port")} hint="The port your application listens on." placeholder="3000" />
        <TextField label="Start command" value={draft.runtimeStart} onChange={(e) => onChange({ ...draft, runtimeStart: e.target.value })} error={errors.get("runtime.start")} hint="Node strategy only. Empty: the package.json start script." autoComplete="off" spellCheck={false} />
      </div>
      <TextAreaField
        label="Runtime secret names"
        value={draft.runtimeSecrets}
        onChange={(e) => onChange({ ...draft, runtimeSecrets: e.target.value })}
        error={[...[...errors.entries()].filter(([p]) => p.startsWith("runtime.secrets")).map(([, m]) => m)].join("; ") || undefined}
        hint="Names only (UPPER_CASE), one per line or comma separated. Their values are set write-only after the application exists and injected as environment variables at run time."
        rows={3}
        spellCheck={false}
        className="mono"
      />
      <EnvEditor label="Runtime environment" prefix="runtime.env" rows={draft.runtimeEnv} onChange={(runtimeEnv) => onChange({ ...draft, runtimeEnv })} errors={errors} />
    </div>
  );
}

export function TargetFields({ draft, onChange, errors }: SectionProps) {
  const e = (path: string) => errors.get(path);

  if (draft.target === "shipflow") {
    return (
      <TextField label="Hostname" value={draft.hostname} onChange={(ev) => onChange({ ...draft, hostname: ev.target.value })} error={e("deployment.shipflow.hostname")} placeholder="www.example.com" hint="Optional. The hostname ShipFlow's site server answers for. Pointing DNS at the server and TLS are your responsibility." autoComplete="off" spellCheck={false} />
    );
  }

  if (draft.target === "ssh") {
    const s = draft.ssh;
    const set = (field: keyof ConfigDraft["ssh"]) => (ev: { target: { value: string } }) => onChange(setDraftTarget(draft, "ssh", field, ev.target.value));

    return (
      <div className="grid grid--2">
        <TextField label="Host" required value={s.host} onChange={set("host")} error={e("deployment.ssh.host")} placeholder="vps.example.com" autoComplete="off" spellCheck={false} />
        <TextField label="SSH port" inputMode="numeric" value={s.port} onChange={set("port")} error={e("deployment.ssh.port")} />
        <TextField label="User" required value={s.user} onChange={set("user")} error={e("deployment.ssh.user")} hint="A dedicated deploy user, not root." autoComplete="off" />
        <TextField label="Remote path" required value={s.path} onChange={set("path")} error={e("deployment.ssh.path")} placeholder="/srv/my-site" hint="Absolute, at least two levels deep." autoComplete="off" spellCheck={false} />
        <TextField label="Public URL" required type="url" value={s.url} onChange={set("url")} error={e("deployment.ssh.url")} placeholder="https://site.example.com/" hint="Used for the live check." autoComplete="off" spellCheck={false} />
        <TextField label="Private key secret name" value={s.privateKeySecret} onChange={set("privateKeySecret")} error={e("deployment.ssh.privateKeySecret")} hint="The NAME of the secret holding the key (UPPER_CASE). The key itself is set write-only later." autoComplete="off" spellCheck={false} />
        <div style={{ gridColumn: "1 / -1" }}>
          <TextAreaField label="Server host key (public)" required value={s.hostKey} onChange={set("hostKey")} error={e("deployment.ssh.hostKey")} rows={2} className="mono" spellCheck={false} hint="From `ssh-keyscan -t ed25519 <host>`. It pins the server identity; it is public, not a secret." />
        </div>
      </div>
    );
  }

  if (draft.target === "docker") {
    const s = draft.docker;
    const set = (field: keyof ConfigDraft["docker"]) => (ev: { target: { value: string } }) => onChange(setDraftTarget(draft, "docker", field, ev.target.value));

    return (
      <div className="grid grid--2">
        <TextField label="Docker host" required value={s.host} onChange={set("host")} error={e("deployment.docker.host")} placeholder="docker.example.com" autoComplete="off" spellCheck={false} />
        <TextField label="SSH port" inputMode="numeric" value={s.port} onChange={set("port")} error={e("deployment.docker.port")} />
        <TextField label="User" required value={s.user} onChange={set("user")} error={e("deployment.docker.user")} hint="A dedicated user in the docker group, not root." autoComplete="off" />
        <TextField label="Published port" inputMode="numeric" value={s.publishPort} onChange={set("publishPort")} error={e("deployment.docker.publishPort")} hint="Host port the managed proxy publishes." />
        <TextField label="Public URL" required type="url" value={s.url} onChange={set("url")} error={e("deployment.docker.url")} placeholder="https://app.example.com/" hint="Used for the live check." autoComplete="off" spellCheck={false} />
        <TextField label="Private key secret name" value={s.privateKeySecret} onChange={set("privateKeySecret")} error={e("deployment.docker.privateKeySecret")} hint="The NAME of the secret holding the SSH key (UPPER_CASE)." autoComplete="off" spellCheck={false} />
        <div style={{ gridColumn: "1 / -1" }}>
          <TextAreaField label="Server host key (public)" required value={s.hostKey} onChange={set("hostKey")} error={e("deployment.docker.hostKey")} rows={2} className="mono" spellCheck={false} hint="From `ssh-keyscan -t ed25519 <host>`. Public, not a secret." />
        </div>
      </div>
    );
  }

  const s = draft.kubernetes;
  const set = (field: keyof ConfigDraft["kubernetes"]) => (ev: { target: { value: string } }) => onChange(setDraftTarget(draft, "kubernetes", field, ev.target.value));

  return (
    <div className="stack">
      <Banner tone="warning" title="Experimental: not verified on a real cluster">Implemented and tested against a fake Kubernetes API server only.</Banner>
      <div className="grid grid--2">
        <TextField label="Namespace" required value={s.namespace} onChange={set("namespace")} error={e("deployment.kubernetes.namespace")} autoComplete="off" spellCheck={false} />
        <TextField label="Replicas" inputMode="numeric" value={s.replicas} onChange={set("replicas")} error={e("deployment.kubernetes.replicas")} hint="1 to 20." />
        <TextField label="Registry" required value={s.registry} onChange={set("registry")} error={e("deployment.kubernetes.registry")} placeholder="registry.example.com/team" hint="Repository prefix, no scheme and no tag." autoComplete="off" spellCheck={false} />
        <TextField label="Public URL" required type="url" value={s.url} onChange={set("url")} error={e("deployment.kubernetes.url")} placeholder="https://app.example.com/" hint="Used for the live check." autoComplete="off" spellCheck={false} />
        <TextField label="Kubeconfig secret name" value={s.kubeconfigSecret} onChange={set("kubeconfigSecret")} error={e("deployment.kubernetes.kubeconfigSecret")} hint="The NAME of the secret holding the kubeconfig (UPPER_CASE)." autoComplete="off" spellCheck={false} />
        <TextField label="Registry auth secret name" value={s.registryAuthSecret} onChange={set("registryAuthSecret")} error={e("deployment.kubernetes.registryAuthSecret")} hint="Optional. Secret holding a Docker config.json." autoComplete="off" spellCheck={false} />
      </div>
    </div>
  );
}

export function VerificationFields({ draft, onChange, errors }: SectionProps) {
  return (
    <div className="grid grid--2">
      <TextField label="Verification path" value={draft.verifyPath} onChange={(e) => onChange({ ...draft, verifyPath: e.target.value })} error={errors.get("verification.path")} hint="Requested on the candidate before it goes live, e.g. /healthz." autoComplete="off" spellCheck={false} />
      <TextField label="Expected status" inputMode="numeric" value={draft.expectStatus} onChange={(e) => onChange({ ...draft, expectStatus: e.target.value })} error={errors.get("verification.expectStatus")} hint="An HTTP status from 200 to 399." />
    </div>
  );
}

/** Everything the build & runtime step shows, in the order a deployment uses it. */
export function BuildAndRuntimeFields(props: SectionProps) {
  return (
    <div className="stack--lg stack">
      <section className="stack" aria-labelledby="sec-build"><h3 id="sec-build" className="section-title">Build</h3><BuildFields {...props} /></section>
      {isImageTargetName(props.draft.target) ? <section className="stack" aria-labelledby="sec-runtime"><h3 id="sec-runtime" className="section-title">Runtime</h3><RuntimeFields {...props} /></section> : null}
      <section className="stack" aria-labelledby="sec-target"><h3 id="sec-target" className="section-title">{targetLabel(props.draft.target)} settings</h3><TargetFields {...props} /></section>
      <section className="stack" aria-labelledby="sec-verify"><h3 id="sec-verify" className="section-title">Verification</h3><VerificationFields {...props} /></section>
    </div>
  );
}
