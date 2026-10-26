// Regression: a first deployment whose live check fails must not stay live.
// (Previously revertToPrevious returned early when there was no previous
// release, leaving the failed release active and served.)
import { test } from "node:test";
import assert from "node:assert/strict";

import { pool } from "../../dist/src/db.js";
import { revertToPrevious } from "../../dist/src/pipeline.js";
import { revertActivation, getActiveReleaseId } from "../../dist/src/activation.js";
import { shipflowTarget } from "../../dist/src/targets/shipflow.js";
import { sshTarget, deactivateCommand } from "../../dist/src/targets/ssh.js";

const settings = {
  targetConfig: { path: "/srv/site" },
  verification: { path: "/", expectStatus: 200 },
};

/** A target adapter that records calls; activate/deactivate can fail. */
function recordingTarget({ failDeactivate = false } = {}) {
  const calls = [];
  return {
    calls,
    capabilities: { artifactTypes: ["static"] },
    async activate(ctx) {
      calls.push(["activate", ctx.releaseId]);
    },
    async deactivate(ctx) {
      calls.push(["deactivate", ctx.releaseId]);
      if (failDeactivate) throw new Error("ssh: connection refused");
    },
  };
}

/** Stand-in for revertActivation: applies the target change, records the pointer. */
function recordingRevert({ newerActivation = false } = {}) {
  const pointers = [];
  const revert = async ({ releaseId, previousReleaseId, apply }) => {
    if (newerActivation) return false;
    await apply({ releaseId: previousReleaseId });
    pointers.push({ from: releaseId, to: previousReleaseId });
    return true;
  };
  return { revert, pointers };
}

for (const [name, adapter] of [["shipflow", shipflowTarget], ["ssh", sshTarget]]) {
  test(`${name} target implements deactivate`, () => {
    assert.equal(typeof adapter.deactivate, "function");
  });
}

test("first deployment: failed release is taken offline and the pointer becomes null", async () => {
  const target = recordingTarget();
  const { revert, pointers } = recordingRevert();

  const message = await revertToPrevious({
    project: "site",
    releaseId: "Failed01",
    previousReleaseId: null,
    target,
    settings,
    secrets: {},
    revert,
    loadRelease: async () => assert.fail("no previous release to load"),
  });

  assert.deepEqual(target.calls, [["deactivate", "Failed01"]]);
  assert.deepEqual(pointers, [{ from: "Failed01", to: null }]);
  assert.match(message, /taken offline and is not served/);
  assert.doesNotMatch(message, /restored/, "must not claim a rollback");
});

test("first deployment: if taking it offline fails, the message says so", async () => {
  const target = recordingTarget({ failDeactivate: true });
  const { revert, pointers } = recordingRevert();

  const message = await revertToPrevious({
    project: "site",
    releaseId: "Failed01",
    previousReleaseId: null,
    target,
    settings,
    secrets: {},
    revert,
  });

  assert.deepEqual(pointers, [], "pointer not changed when the target could not be switched");
  assert.match(message, /ALSO FAILED: ssh: connection refused/);
  assert.doesNotMatch(message, /restored|taken offline and is not served/);
});

test("existing behavior: with a previous release, it is restored", async () => {
  const target = recordingTarget();
  const { revert, pointers } = recordingRevert();

  const message = await revertToPrevious({
    project: "site",
    releaseId: "Failed02",
    previousReleaseId: "Good0001",
    target,
    settings,
    secrets: {},
    revert,
    loadRelease: async (id) => ({ release_id: id, artifact_path: `releases/${id}/build` }),
  });

  assert.deepEqual(target.calls, [["activate", "Good0001"]]);
  assert.deepEqual(pointers, [{ from: "Failed02", to: "Good0001" }]);
  assert.equal(message, "restored previous release Good0001");
});

test("a newer activation is never overwritten", async () => {
  const target = recordingTarget();
  const { revert } = recordingRevert({ newerActivation: true });

  const message = await revertToPrevious({
    project: "site",
    releaseId: "Failed03",
    previousReleaseId: null,
    target,
    settings,
    secrets: {},
    revert,
  });

  assert.deepEqual(target.calls, []);
  assert.equal(message, "a newer activation has since replaced it");
});

/** Fake pg client/pool backed by an in-memory activations table. */
function fakeDatabase(rows) {
  const run = async (sql, params = []) => {
    if (sql.includes("INSERT INTO activations")) {
      rows.push({ project: params[0], release_id: params[1], previous_release_id: params[2], action: "REVERT" });
      return { rows: [] };
    }
    if (sql.includes("FROM activations")) {
      const latest = rows.filter((r) => r.project === params[0]).at(-1);
      return { rows: latest ? [{ release_id: latest.release_id, seq: null }] : [] };
    }
    return { rows: [] };
  };
  return { query: run, connect: async () => ({ query: run, release() {} }) };
}

test("revertActivation records a null pointer and getActiveReleaseId then reports nothing live", async (t) => {
  const rows = [{ project: "site", release_id: "Failed01", action: "DEPLOY" }];
  const db = fakeDatabase(rows);
  t.mock.method(pool, "connect", db.connect);
  t.mock.method(pool, "query", db.query);

  let applied = false;
  const reverted = await revertActivation({
    project: "site",
    releaseId: "Failed01",
    previousReleaseId: null,
    apply: async () => {
      applied = true;
    },
  });

  assert.equal(reverted, true);
  assert.equal(applied, true);
  assert.equal(rows.at(-1).release_id, null);
  assert.equal(rows.at(-1).previous_release_id, "Failed01");
  assert.equal(await getActiveReleaseId("site"), null);

  // If something newer is already live, nothing is changed.
  rows.push({ project: "site", release_id: "Newer001", action: "DEPLOY" });
  assert.equal(await revertActivation({ project: "site", releaseId: "Failed01", previousReleaseId: null }), false);
  assert.equal(await getActiveReleaseId("site"), "Newer001");
});

test("ssh deactivation removes only the current symlink, and only if it points at the failed release", () => {
  const command = deactivateCommand({ path: "/srv/site" }, "Failed01");

  assert.equal(
    command,
    `if [ -L '/srv/site/current' ] && [ "$(readlink '/srv/site/current')" = 'releases/Failed01' ]; then rm -f '/srv/site/current'; fi`
  );
  assert.doesNotMatch(command, /rm -rf|releases\/Failed01'?\s*;?\s*$/);
  assert.throws(() => deactivateCommand({ path: "/srv/site" }, "../../etc"), /Invalid release ID/);
});
