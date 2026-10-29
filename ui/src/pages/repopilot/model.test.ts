import { describe, expect, it } from "vitest";
import type { RpOutcome, RpPatch, RpPullRequest } from "@/api/repopilotTypes";
import { OUTCOME, authorizationBlocker, canCancel, isActive, ladderFor, needsPerson, percent, reasonText, RUN_STATE } from "./model";

const patch = (passed: boolean): RpPatch => ({ id: 1, findingId: 1, baseCommit: "a".repeat(40), title: "t", explanation: "e", diff: "d", testDiff: "t", diffSha256: "b".repeat(64), policy: { passed, details: {} }, createdAt: "2026-10-28T00:00:00Z" });
const outcome = (o: RpOutcome["outcome"]): RpOutcome => ({ patchId: 1, outcome: o, reasons: [], details: {}, computedAt: "2026-10-28T00:00:00Z" });
const pr = (state: RpPullRequest["state"], extra: Partial<RpPullRequest> = {}): RpPullRequest => ({ id: 1, patchId: 1, state, authorizedBy: "user:a", authorizedAt: "2026-10-28T00:00:00Z", authorizedDiffSha256: "b".repeat(64), authorizedOutcome: "improved", baseBranch: "main", baseSha: "a".repeat(40), branch: "repopilot/x", number: null, url: null, headSha: null, error: null, updatedAt: "2026-10-28T00:00:00Z", ...extra });

describe("ladderFor keeps four facts separate", () => {
  it("a generated patch is not a validated, verified or proposed one", () => {
    const steps = ladderFor(patch(true), undefined, null);

    expect(steps.map((s) => [s.key, s.status])).toEqual([["generated", "done"], ["policy", "done"], ["verification", "pending"], ["pr", "pending"]]);
    expect(steps[1]?.detail).toMatch(/does not mean it is correct/);
  });

  it("a rejected patch is never verified or proposed", () => {
    const steps = ladderFor(patch(false), undefined, null);

    expect(steps.map((s) => s.status)).toEqual(["done", "fail", "pending", "pending"]);
    expect(steps[2]?.detail).toMatch(/Only validated patches/);
  });

  it("verification shows done only for 'improved'; inconclusive is unclear, regression is a failure", () => {
    expect(ladderFor(patch(true), outcome("improved"), null)[2]?.status).toBe("done");
    expect(ladderFor(patch(true), outcome("unchanged"), null)[2]?.status).toBe("warn");
    expect(ladderFor(patch(true), outcome("inconclusive"), null)[2]?.status).toBe("warn");
    expect(ladderFor(patch(true), outcome("regressed"), null)[2]?.status).toBe("fail");
  });

  it("an opened pull request does not rewrite the verification result", () => {
    const steps = ladderFor(patch(true), outcome("inconclusive"), pr("opened", { number: 7 }));

    expect(steps[2]?.status).toBe("warn");
    expect(steps[3]).toMatchObject({ status: "done", detail: "#7" });
  });

  it("pull request states map to done / pending / fail", () => {
    expect(ladderFor(patch(true), outcome("improved"), pr("creating"))[3]?.status).toBe("pending");
    expect(ladderFor(patch(true), outcome("improved"), pr("failed", { error: { code: "x", detail: "branch exists" } }))[3]).toMatchObject({ status: "fail", detail: "branch exists" });
  });
});

describe("authorizationBlocker", () => {
  it("allows only a validated, verified-or-inconclusive patch in ready_for_review", () => {
    expect(authorizationBlocker({ state: "ready_for_review" }, patch(true), outcome("improved"))).toBeNull();
    expect(authorizationBlocker({ state: "ready_for_review" }, patch(true), outcome("inconclusive"))).toBeNull();
    expect(authorizationBlocker({ state: "ready_for_review" }, patch(true), outcome("unchanged"))).toBeNull();
  });

  it.each([
    ["not ready", { state: "verifying" as const }, patch(true), outcome("improved"), /not waiting for review/],
    ["no patch", { state: "ready_for_review" as const }, undefined, outcome("improved"), /no patch/],
    ["policy failed", { state: "ready_for_review" as const }, patch(false), outcome("improved"), /failed validation/],
    ["no outcome", { state: "ready_for_review" as const }, patch(true), undefined, /no verification outcome/],
    ["regressed", { state: "ready_for_review" as const }, patch(true), outcome("regressed"), /made passing tests fail/],
  ])("blocks: %s", (_name, run, p, o, message) => {
    expect(authorizationBlocker(run, p, o)).toMatch(message);
  });
});

describe("labels", () => {
  it("never describe an outcome as proof", () => {
    for (const o of Object.values(OUTCOME)) expect(o.meaning).not.toMatch(/\b(proves?|guarantees?|verified correct|safe)\b/i);
    expect(OUTCOME.improved.meaning).toMatch(/evidence, not proof/);
  });

  it("explains inconclusive reasons in plain language", () => {
    expect(reasonText("verification_unavailable")).toMatch(/No isolated sandbox/);
    expect(reasonText("flaky_patched")).toMatch(/flaky/);
    expect(reasonText("something_new")).toBe("something new");
  });

  it("classifies run states", () => {
    expect(isActive("verifying")).toBe(true);
    expect(isActive("pr_opened")).toBe(false);
    expect(needsPerson("awaiting_patch")).toBe(true);
    expect(needsPerson("analyzing")).toBe(false);
    expect(canCancel({ state: "analyzing", cancelRequested: false })).toBe(true);
    expect(canCancel({ state: "analyzing", cancelRequested: true })).toBe(false);
    expect(canCancel({ state: "failed", cancelRequested: false })).toBe(false);
    expect(RUN_STATE.ready_for_review.tone).toBe("warning");
    expect(percent(0.704)).toBe("70%");
  });
});
