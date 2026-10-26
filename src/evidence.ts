// Structured release evidence and a deterministic diagnosis.
//
// Evidence is a plain JSON summary of what happened to a release, built only
// from data ShipFlow already stored (and already redacted when it was
// written): stage timeline, strategy, artifact identity, target, failure.
// The diagnosis is a fixed rule table, never a model: same evidence, same
// answer, no network call. An optional *advisory* analyzer can be attached
// (see AdvisoryAnalyzer); its output is labelled as such, never affects the
// release or the diagnosis, and is off unless an analyzer is supplied.
import type { ReleaseRow } from "./releaseStore.js";
import type { ReleaseLogRow } from "./logStore.js";
import { artifactOf } from "./artifacts.js";

export interface StageSummary {
  stage: string;
  startedAt: string | null;
  lastAt: string | null;
  errors: number;
  warnings: number;
}

export interface Diagnosis {
  category: string;
  summary: string;
  suggestions: string[];
}

export interface Evidence {
  releaseId: string;
  project: string;
  mode: string;
  status: string;
  stage: string;
  commitSha: string | null;
  ref: string | null;
  trigger: string;
  target: string;
  buildStrategy: string | null;
  artifact:
    | { type: "static"; path: string }
    | { type: "image"; digest: string; sizeBytes: number; port: number }
    | null;
  testStatus: string | null;
  createdAt: string;
  updatedAt: string;
  timeline: StageSummary[];
  failure: { stage: string; message: string } | null;
  diagnosis: Diagnosis | null;
}

/** Pluggable, advisory only: receives redacted evidence, returns free text. */
export interface AdvisoryAnalyzer {
  analyze(evidence: Evidence): Promise<string>;
}

interface Rule {
  category: string;
  pattern: RegExp;
  summary: string;
  suggestions: string[];
}

// Order matters: the first match wins, so specific rules come first.
const RULES: Rule[] = [
  {
    category: "image-builds-disabled",
    pattern: /SHIPFLOW_IMAGE_BUILDS/,
    summary: "Container image builds are disabled on this ShipFlow server.",
    suggestions: [
      "Set SHIPFLOW_IMAGE_BUILDS=enabled on the worker only if you accept that Dockerfile RUN steps execute through the host Docker daemon with weaker isolation than the build sandbox.",
      "Otherwise deploy this project as a static site, or build the image in your own CI.",
    ],
  },
  {
    category: "strategy-detection",
    pattern: /could not (?:choose|detect) a build strategy|cannot run (?:static|image) artifacts|no Dockerfile|set build\.strategy/i,
    summary: "ShipFlow could not pick, or the target cannot run, the build strategy for this repository.",
    suggestions: [
      "Set build.strategy in shipflow.yml (static, node, or dockerfile).",
      "Image targets (docker, kubernetes) need a Dockerfile or a package.json start script, plus runtime.port.",
    ],
  },
  {
    category: "missing-secret",
    pattern: /missing (?:project )?secrets?|secret .* (?:is|are) not set|Secret store is not available/i,
    summary: "A secret the deployment needs has not been stored on the server.",
    suggestions: ["Run `shipflow secrets set <NAME>` for each name listed, then deploy again."],
  },
  {
    category: "ssh-host-key",
    pattern: /Host key verification failed|does not match deployment\.\w+\.hostKey/i,
    summary: "The server's SSH host key does not match the pinned hostKey.",
    suggestions: [
      "Confirm the server identity out of band, then update hostKey in shipflow.yml (`ssh-keyscan -t ed25519 <host>`).",
    ],
  },
  {
    category: "target-unreachable",
    pattern: /Cannot connect|Connection refused|Permission denied \(publickey\)|rejected the key|ECONNREFUSED|ETIMEDOUT/i,
    summary: "ShipFlow could not reach or authenticate to the deployment target.",
    suggestions: ["Run `shipflow doctor` to check connectivity and credentials for the target."],
  },
  {
    category: "image-pull",
    pattern: /ImagePullBackOff|ErrImagePull|pull access denied|manifest unknown/i,
    summary: "The target could not pull the release image.",
    suggestions: [
      "Check the registry address, that the registry credentials secret is set, and that the cluster nodes can reach the registry.",
    ],
  },
  {
    category: "crash-loop",
    pattern: /CrashLoopBackOff|exited with code|container .* (?:exited|is not running)/i,
    summary: "The application started and then exited.",
    suggestions: [
      "Read the container log lines above; check the start command, runtime.port, required environment variables and runtime.secrets.",
    ],
  },
  {
    category: "live-check-failed",
    pattern: /Live check failed|live check|did not become healthy|expected status/i,
    summary: "The release was activated but failed its health check, so ShipFlow switched back.",
    suggestions: [
      "Check that verification.path returns the expected status, that the application listens on runtime.port, and that the public url reaches this deployment.",
    ],
  },
  {
    category: "tests-failed",
    pattern: /tests? failed|test script failed|npm ERR! Test failed/i,
    summary: "The repository's tests failed.",
    suggestions: ["Run the tests locally; fix them, or set build.test to a different command or \"none\"."],
  },
  {
    category: "build-output-missing",
    pattern: /Build output not found|Build output directory is empty|no index\.html|references files missing/i,
    summary: "The build did not produce a valid static site.",
    suggestions: ["Set build.output to the directory your build writes, and make sure it contains index.html."],
  },
  {
    category: "build-failed",
    pattern: /No "build" script|Command failed|build failed|exit code|npm ERR!|ERR_PNPM|error TS\d+/i,
    summary: "The build or dependency install failed.",
    suggestions: [
      "Reproduce locally with a clean checkout and the same Node version; check the command output in the logs.",
    ],
  },
  {
    category: "disk-space",
    pattern: /MB free in .*need at least/i,
    summary: "The worker is low on disk space.",
    suggestions: ["Free space on the worker (or raise SHIPFLOW_MIN_FREE_DISK_MB only if you understand the risk)."],
  },
];

export function diagnose(failureMessage: string, logText = ""): Diagnosis {
  const haystack = `${failureMessage}\n${logText}`;

  for (const rule of RULES) {
    if (rule.pattern.test(haystack)) {
      return { category: rule.category, summary: rule.summary, suggestions: rule.suggestions };
    }
  }

  return {
    category: "unknown",
    summary: "No known failure pattern matched.",
    suggestions: ["Read the release logs (`shipflow logs <releaseId>`), starting at the first ERROR line."],
  };
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function buildEvidence(release: ReleaseRow, logs: ReleaseLogRow[]): Evidence {
  const stages = new Map<string, StageSummary>();

  for (const row of logs) {
    const at = iso(row.created_at);
    const summary = stages.get(row.stage) ?? { stage: row.stage, startedAt: at, lastAt: at, errors: 0, warnings: 0 };

    summary.lastAt = at ?? summary.lastAt;
    if (row.level === "ERROR") summary.errors += 1;
    if (row.level === "WARN") summary.warnings += 1;
    stages.set(row.stage, summary);
  }

  const artifact = artifactOf(release);
  const failed = release.status === "FAILED" ? (release.error_message ?? "Release failed") : null;
  const errorLogs = logs.filter((row) => row.level === "ERROR").map((row) => row.message).join("\n");

  return {
    releaseId: release.release_id,
    project: release.project,
    mode: release.mode,
    status: release.status,
    stage: release.current_stage,
    commitSha: release.commit_sha,
    ref: release.ref,
    trigger: release.trigger,
    target: release.target,
    buildStrategy: release.build_strategy ?? null,
    artifact:
      artifact?.type === "image"
        ? { type: "image", digest: artifact.digest, sizeBytes: artifact.sizeBytes, port: artifact.port }
        : artifact?.type === "static"
          ? { type: "static", path: artifact.path }
          : null,
    testStatus: release.test_status,
    createdAt: iso(release.created_at) ?? "",
    updatedAt: iso(release.updated_at) ?? "",
    timeline: [...stages.values()],
    failure: failed === null ? null : { stage: release.current_stage, message: failed },
    diagnosis: failed === null ? null : diagnose(failed, errorLogs),
  };
}

export interface AdvisoryResult {
  /** Always true: advisory text is never authoritative and never blocks a release. */
  advisory: true;
  text: string | null;
  error: string | null;
}

/** Run an optional analyzer; any failure is reported, never thrown. */
export async function advise(evidence: Evidence, analyzer: AdvisoryAnalyzer | undefined): Promise<AdvisoryResult | null> {
  if (!analyzer) return null;

  try {
    return { advisory: true, text: await analyzer.analyze(evidence), error: null };
  } catch (error) {
    return { advisory: true, text: null, error: error instanceof Error ? error.message : String(error) };
  }
}
