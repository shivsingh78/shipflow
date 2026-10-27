// Wizard drafts live in sessionStorage so a refresh does not lose the form.
// They never contain secret VALUES: those are only ever typed into write-only
// fields after the application exists. Public env values that look like
// credentials are dropped as well, and a repository URL with credentials is
// not stored.
import type { ConfigDraft, EnvRow } from "./configForm";
import { emptyDraft } from "./configForm";

export const DRAFT_KEY = "shipflow.wizard.draft";

const SECRETISH_KEY = /(password|passwd|secret|token|private_?key|api_?key|access_?key)$/i;
const SECRETISH_VALUE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|github_pat_/;

const cleanRows = (list: EnvRow[]): EnvRow[] => list.map((r) => (SECRETISH_KEY.test(r.key) || SECRETISH_VALUE.test(r.value) ? { key: r.key, value: "" } : r));

export function sanitizeDraft(draft: ConfigDraft): ConfigDraft {
  const hasCredentials = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(draft.repository);

  return {
    ...draft,
    repository: hasCredentials ? "" : draft.repository,
    buildEnv: cleanRows(draft.buildEnv),
    runtimeEnv: cleanRows(draft.runtimeEnv),
    // hostKey is public; private keys are never form fields.
    ssh: { ...draft.ssh, hostKey: SECRETISH_VALUE.test(draft.ssh.hostKey) ? "" : draft.ssh.hostKey },
  };
}

interface StoredDraft {
  step: number;
  draft: ConfigDraft;
}

export function saveDraft(step: number, draft: ConfigDraft): void {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ step, draft: sanitizeDraft(draft) } satisfies StoredDraft));
  } catch {
    // Storage unavailable or full: the wizard still works, it just will not survive a refresh.
  }
}

export function loadDraft(): StoredDraft | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);

    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<StoredDraft>;

    if (!parsed.draft || typeof parsed.draft !== "object") return null;

    // Fill any field added since the draft was stored.
    const base = emptyDraft();
    const draft = { ...base, ...parsed.draft, ssh: { ...base.ssh, ...parsed.draft.ssh }, docker: { ...base.docker, ...parsed.draft.docker }, kubernetes: { ...base.kubernetes, ...parsed.draft.kubernetes } };
    const step = typeof parsed.step === "number" ? Math.min(Math.max(Math.round(parsed.step), 1), 5) : 1;

    return { step, draft };
  } catch {
    return null;
  }
}

export function clearDraft(): void {
  try {
    sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // Nothing to clear.
  }
}
