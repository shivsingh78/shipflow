/**
 * Pull-request title, commit message and description. Pure.
 *
 * Built from stored records (never from fresh model output) and written for a
 * human reviewer: what was proposed, what evidence exists, and what it does
 * NOT show. Model-written text is neutralised so it cannot @-mention people,
 * inject links or HTML, or reference unrelated issues.
 */

import type { OutcomeRow, PatchRow, FindingRow, RunRow, VerificationRow } from "./store.js";

const ZWSP = "​";

/** Make untrusted text inert in GitHub-flavoured Markdown. */
export function neutralize(text: string, max = 600): string {
  const clipped = text.length > max ? `${text.slice(0, max)}…` : text;

  return clipped
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/@/g, `@${ZWSP}`)
    .replace(/#(?=\d)/g, `#${ZWSP}`)
    .replace(/[[\]]/g, (c) => `\\${c}`)
    .replace(/`/g, "'")
    .replace(/\r?\n/g, " ")
    .trim();
}

export function pullRequestTitle(finding: Pick<FindingRow, "title">): string {
  return `RepoPilot: ${neutralize(finding.title, 100)}`.slice(0, 120);
}

export function commitMessage(finding: Pick<FindingRow, "title">, patch: Pick<PatchRow, "diffSha256">): string {
  return `${neutralize(finding.title, 90)}\n\nProposed by ShipFlow RepoPilot (AI-assisted); not reviewed until a human approves this pull request.\nPatch digest: sha256:${patch.diffSha256}\n`;
}

interface ArmLine {
  arm: string;
  runs: number;
  passed: number;
  failed: number;
  other: number;
}

function armLines(verifications: readonly VerificationRow[]): ArmLine[] {
  const lines: ArmLine[] = [];

  for (const arm of ["baseline", "control", "patched"]) {
    const rows = verifications.filter((v) => v.arm === arm);

    if (rows.length > 0) {
      lines.push({
        arm,
        runs: rows.length,
        passed: rows.filter((v) => v.kind === "exited" && v.exitCode === 0).length,
        failed: rows.filter((v) => v.kind === "exited" && v.exitCode !== 0).length,
        other: rows.filter((v) => v.kind !== "exited").length,
      });
    }
  }

  return lines;
}

const OUTCOME_TEXT: Record<OutcomeRow["outcome"], string> = {
  improved: "the new regression test failed on the original code and the patched code passed, consistently",
  unchanged: "the project's tests passed before and after, with no control run to show the new test discriminates",
  regressed: "tests that passed before failed after the change",
  inconclusive: "the available evidence does not support a conclusion",
};

export function buildPullRequestBody(input: {
  run: Pick<RunRow, "id" | "commitSha" | "defaultBranch">;
  finding: FindingRow;
  patch: Pick<PatchRow, "id" | "diffSha256" | "baseCommit" | "explanation">;
  changedFiles: { source: string[]; tests: string[] };
  outcome: OutcomeRow;
  verifications: readonly VerificationRow[];
  authorizedBy: string;
  authorizedAt: Date;
  baseMoved: { aheadBy: number } | null;
}): string {
  const f = input.finding;
  const arms = armLines(input.verifications);
  const verified = arms.length > 0;

  return [
    "## RepoPilot proposal — AI-assisted, human review required",
    "",
    "> RepoPilot never merges. This pull request was opened only after a person explicitly authorised this exact change.",
    "",
    "### Finding (an AI suggestion, not a confirmed defect)",
    `- **${neutralize(f.title)}** — \`${f.file}\` lines ${f.lineStart}-${f.lineEnd}`,
    `- ${f.category} / ${f.severity} severity / ${f.evidenceKind === "observed" ? "cited as observed in the code" : "a hypothesis"}`,
    `- The model rated its own confidence ${Math.round(f.confidence * 100)}%. That is its estimate, not a measurement.`,
    `- Evidence: ${neutralize(f.evidence)}`,
    `- Impact: ${neutralize(f.impact)}`,
    `- Explanation of the change: ${neutralize(input.patch.explanation, 800)}`,
    "",
    "### Change",
    `- Source: ${input.changedFiles.source.map((p) => `\`${p}\``).join(", ") || "(none)"}`,
    `- Regression test added: ${input.changedFiles.tests.map((p) => `\`${p}\``).join(", ") || "(none)"} (written by the AI model; it may not capture the real defect)`,
    "",
    "### Verification evidence",
    `**Outcome: ${input.outcome.outcome}** — ${OUTCOME_TEXT[input.outcome.outcome]}.`,
    input.outcome.reasons.length > 0 ? `Reasons: ${input.outcome.reasons.map((r) => r.replace(/_/g, " ")).join(", ")}.` : "",
    "",
    verified
      ? ["| Run | Attempts | Passed | Failed | Timeout / error |", "| --- | --- | --- | --- | --- |", ...arms.map((a) => `| ${a.arm} | ${a.runs} | ${a.passed} | ${a.failed} | ${a.other} |`)].join("\n")
      : "No sandbox verification was run for this patch, so there are no test results.",
    "",
    "### What this does not show",
    "- Passing tests are evidence, not proof that the change is correct or secure.",
    "- The finding, the patch and the test were all produced by an AI model.",
    "- Nothing here replaces reading the diff and running your own CI.",
    input.baseMoved ? `- \`${input.run.defaultBranch ?? "the base branch"}\` has moved ${input.baseMoved.aheadBy} commit(s) since analysis; none of them touch these files, but re-run your CI after rebasing.` : "",
    "",
    "### Provenance",
    `- Analysed commit: \`${input.patch.baseCommit}\``,
    `- Patch digest: \`sha256:${input.patch.diffSha256}\``,
    `- Authorised by \`${neutralize(input.authorizedBy, 80)}\` at ${input.authorizedAt.toISOString()}`,
    `- ShipFlow RepoPilot run #${input.run.id}`,
  ].filter((line, i, all) => line !== "" || all[i - 1] !== "").join("\n");
}
