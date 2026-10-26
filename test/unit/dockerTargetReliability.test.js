// Regression tests for the three docker-target reliability defects, replaying
// whole deploy / failed-live-check / revert sequences against a stateful fake
// Docker host (test/unit/helpers/fakeDockerHost.js).
//
//   1. After a failed live check the previous release must be restorable even
//      though its container was stopped (or is gone), and its health checked.
//   2. nginx must resolve the upstream per request (see renderProxyConfig);
//      the real-nginx / real-Docker proof is in test/e2e/images.test.js.
//   3. Redaction applies where text is reported, never to bytes that are
//      parsed or restored (a secret that is a substring of the nginx config).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createDockerTarget, renderProxyConfig, parseActiveUpstream, parseHandshakeToken, handshakePath, DOCKER_DNS_RESOLVER } from "../../dist/src/targets/docker.js";
import { revertToPrevious, discardUnusedCandidate } from "../../dist/src/pipeline.js";
import { createFakeHost, releaseContext, fakeStore, digestOf, HOME } from "./helpers/fakeDockerHost.js";

const [R1, R2, R3, R4, R5, R6] = ["Rel00001", "Rel00002", "Rel00003", "Rel00004", "Rel00005", "Rel00006"];

/** The pipeline's DEPLOY → VERIFY → ACTIVATE → (failed live check) → revert path for the docker target. */
async function deploy({ host, deps, releaseId, previous, secrets = {}, logs = [] }) {
  const target = createDockerTarget(deps);
  const ctx = releaseContext(host, releaseId, { secrets, logs });

  await target.prepare(ctx);
  await target.verifyCandidate(ctx);
  await target.activate(ctx);

  try {
    await target.verifyLive(ctx);
    return { ok: true };
  } catch (error) {
    const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "sf-dockerrev-"));

    try {
      const message = await revertToPrevious({
        project: host.project,
        releaseId,
        previousReleaseId: previous,
        target,
        settings: { targetConfig: ctx.targetConfig, verification: ctx.verification, runtime: ctx.runtime },
        secrets: ctx.secrets,
        store: fakeStore(),
        scratchDir,
        log: (m) => logs.push(m),
        // activateRelease's lock and DB pointer are covered by activation tests; this runs the target change.
        revert: async ({ apply }) => { await apply(); return true; },
        loadRelease: async (id) => {
          const artifact = releaseContext(host, id).artifact;
          return { artifact_type: "image", artifact, artifact_path: `releases/${id}/image` };
        },
      });

      return { ok: false, message, error };
    } finally {
      await fs.rm(scratchDir, { recursive: true, force: true });
    }
  }
}

async function liveRelease(host, deps, releaseId, previous = null) {
  host.behave(releaseId, { candidate: 200, live: 200 });
  const result = await deploy({ host, deps, releaseId, previous });
  assert.equal(result.ok, true);
  assert.equal(host.serving(), releaseId);
}

// ===================================================== Issue 1: failed live check

test("a failed live check restores the previous release that the activation had left running", async () => {
  const { host, deps } = createFakeHost();
  await liveRelease(host, deps, R1);

  host.behave(R2, { candidate: 200, live: 500 }); // healthy inside the network, broken once public
  const result = await deploy({ host, deps, releaseId: R2, previous: R1 });

  assert.equal(result.ok, false);
  assert.match(result.message, new RegExp(`restored previous release ${R1}; its live check passed`));
  assert.equal(host.serving(), R1, "the original release serves traffic again");
  assert.deepEqual(host.running(), [R1], "the failed release is stopped once the restored one is verified");
});

test("the previous release is not stopped while the new one is still on probation", async () => {
  const { host, deps } = createFakeHost();
  await liveRelease(host, deps, R1);

  const target = createDockerTarget(deps);
  const ctx = releaseContext(host, R2);
  host.behave(R2, { live: 500 });
  await target.prepare(ctx);
  await target.verifyCandidate(ctx);
  await target.activate(ctx);

  assert.deepEqual(host.running(), [R1, R2], "both run between activation and the live check");
  assert.equal(host.serving(), R2);

  await assert.rejects(target.verifyLive(ctx));
  assert.deepEqual(host.running(), [R1, R2], "a failed live check stops nothing");
});

test("a stopped previous container is restarted and health-checked before traffic returns to it", async () => {
  const { host, deps } = createFakeHost();
  await liveRelease(host, deps, R1);
  host.containers.get(`shipflow-shop-${R1}`).running = false; // e.g. stopped by an operator or a reboot

  host.behave(R2, { live: 500 });
  const result = await deploy({ host, deps, releaseId: R2, previous: R1 });

  assert.match(result.message, new RegExp(`restored previous release ${R1}; its live check passed`));
  assert.equal(host.serving(), R1);

  const commands = host.commands.map((c) => c.command);
  const started = commands.findIndex((c) => c.includes(`'start' 'shipflow-shop-${R1}'`));
  const probed = commands.findIndex((c, i) => i > started && c.includes("'wget'") && c.includes(`shipflow-shop-${R1}:`));
  const switched = commands.map((c, i) => [c, i]).filter(([c]) => c.includes("'nginx' '-s' 'reload'")).at(-1)[1];

  assert.ok(started >= 0 && probed > started && switched > probed, "start → health probe → switch traffic");
});

test("a missing previous container is recreated from its stored image", async () => {
  const { host, deps } = createFakeHost();
  await liveRelease(host, deps, R1);
  host.containers.delete(`shipflow-shop-${R1}`);

  host.behave(R2, { live: 500 });
  const result = await deploy({ host, deps, releaseId: R2, previous: R1 });

  assert.match(result.message, /restored previous release Rel00001; its live check passed/);
  assert.equal(host.serving(), R1);
  assert.ok(host.ranContainer(R1), "the container was started again");
});

test("a missing previous image is reloaded from the artifact store, then verified", async () => {
  const { host, deps } = createFakeHost();
  await liveRelease(host, deps, R1);
  host.containers.delete(`shipflow-shop-${R1}`);
  host.images.delete(`shipflow/shop:${R1}`);
  host.digests.delete(digestOf(R1));

  host.behave(R2, { live: 500 });
  const result = await deploy({ host, deps, releaseId: R2, previous: R1 });

  assert.match(result.message, /restored previous release Rel00001; its live check passed/);
  assert.equal(host.serving(), R1);
  assert.ok(host.commands.some((c) => c.command.includes("'load'") && c.options?.stdin?.file.includes(`image-${R1}.tar`)));
});

test("a previous release that is itself unhealthy is never switched to, and the report says so", async () => {
  const { host, deps } = createFakeHost();
  await liveRelease(host, deps, R1);
  host.containers.get(`shipflow-shop-${R1}`).running = false;
  host.behave(R1, { candidate: 500, live: 500 }); // cannot be brought back healthy

  host.behave(R2, { live: 500 });
  const result = await deploy({ host, deps, releaseId: R2, previous: R1 });

  assert.match(result.message, new RegExp(`ALSO FAILED to restore ${R1}`));
  assert.equal(parseActiveUpstream(host.conf()).releaseId, R2, "traffic was not pointed at an unhealthy release");
});

test("first deployment: a failed live check takes the release offline and leaves no container", async () => {
  const { host, deps } = createFakeHost();
  host.behave(R1, { live: 500 });

  const result = await deploy({ host, deps, releaseId: R1, previous: null });

  assert.equal(result.ok, false);
  assert.match(result.message, /no earlier release existed, so Rel00001 was taken offline/);
  assert.equal(host.serving(), null);
  assert.match(host.conf(), /No active release/);
  assert.deepEqual(host.existing(), [], "the failed candidate was removed");
  assert.equal((await deps.httpGet()).status, 503);
});

test("a candidate that fails verification never touches the live release", async () => {
  const { host, deps } = createFakeHost();
  await liveRelease(host, deps, R1);
  const before = host.conf();
  const reloads = host.commands.filter((c) => c.command.includes("'-s' 'reload'")).length;

  host.behave(R2, { candidate: 500 });
  const target = createDockerTarget(deps);
  const ctx = releaseContext(host, R2);
  await target.prepare(ctx);
  await assert.rejects(target.verifyCandidate(ctx), /did not answer/);

  assert.equal(host.conf(), before);
  assert.equal(host.commands.filter((c) => c.command.includes("'-s' 'reload'")).length, reloads);
  assert.equal(host.serving(), R1);
  assert.deepEqual(host.existing(), [R1], "the failed candidate was removed, the live release kept");
});

test("an older deployment never stops the release a newer one made live", async () => {
  const { host, deps } = createFakeHost();
  await liveRelease(host, deps, R1);
  await liveRelease(host, deps, R2, R1);
  await liveRelease(host, deps, R3, R2); // R3 is live; R1 and R2 were stopped by the post-check, so restart them to mimic a race
  for (const id of [R1, R2]) host.containers.get(`shipflow-shop-${id}`).running = true;

  const target = createDockerTarget(deps);
  await target.verifyLive(releaseContext(host, R2)); // an older release finishing its live check late

  assert.deepEqual(host.running(), [R1, R2, R3], "R2's late check must not stop R3 (the live one) or anything else");

  await target.verifyLive(releaseContext(host, R3));
  assert.deepEqual(host.running(), [R3], "the live release's check stops the superseded ones");
});

test("pruning never removes the live release, even when it is older than the retained ones", async () => {
  const { host, deps } = createFakeHost();
  await liveRelease(host, deps, R1);
  for (const id of [R2, R3, R4, R5]) {
    host.images.set(`shipflow/shop:${id}`, digestOf(id));
    host.digests.add(digestOf(id));
    host.containers.set(`shipflow-shop-${id}`, { running: false, image: digestOf(id), release: id, role: "release" });
  }

  host.behave(R6, {});
  const ctx = releaseContext(host, R6);
  host.images.set(`shipflow/shop:${R6}`, digestOf(R6));
  host.digests.add(digestOf(R6));
  await createDockerTarget(deps).prepare(ctx);

  assert.ok(host.existing().includes(R1), "the live release survives");
  assert.ok(host.existing().includes(R6));
  assert.ok(!host.existing().includes(R2), "an old, non-live release is pruned");
});

test("pruning is skipped when the live release cannot be determined", async () => {
  const { host, deps } = createFakeHost();
  await liveRelease(host, deps, R1);
  for (const id of [R2, R3, R4, R5]) {
    host.images.set(`shipflow/shop:${id}`, digestOf(id));
    host.containers.set(`shipflow-shop-${id}`, { running: false, image: digestOf(id), release: id, role: "release" });
  }
  host.images.set(`shipflow/shop:${R6}`, digestOf(R6));
  host.digests.add(digestOf(R6));
  host.failConfRead = true;

  await createDockerTarget(deps).prepare(releaseContext(host, R6)).catch(() => undefined);

  assert.deepEqual(host.existing().filter((id) => [R1, R2, R3, R4, R5].includes(id)), [R1, R2, R3, R4, R5], "nothing was removed");
});

test("preparing the release that is already live does not recreate its container", async () => {
  const { host, deps } = createFakeHost();
  await liveRelease(host, deps, R1);
  const removals = () => host.commands.filter((c) => c.command.includes(`'rm' '-f' 'shipflow-shop-${R1}'`)).length;
  const before = removals();

  const result = await createDockerTarget(deps).prepare(releaseContext(host, R1));

  assert.match(result.detail, /already the live release/);
  assert.equal(removals(), before);
  assert.equal(host.serving(), R1);
});

test("activation is not done until the proxy itself reports the new release (reload is asynchronous)", async () => {
  const { host, deps } = createFakeHost();
  await liveRelease(host, deps, R1);

  host.behave(R2, {});
  const target = createDockerTarget(deps);
  const ctx = releaseContext(host, R2);
  await target.prepare(ctx);
  await target.verifyCandidate(ctx);
  await target.activate(ctx);

  const commands = host.commands.map((c) => c.command);
  const reload = commands.map((c, i) => [c, i]).filter(([c]) => c.includes("'-s' 'reload'")).at(-1)[1];
  const handshake = commands.findIndex((c, i) => i > reload && /127\.0\.0\.1\/__shipflow_[a-f0-9]{16}/.test(c));

  assert.ok(handshake > reload, "the switch is confirmed after the reload, from inside the proxy");
  assert.equal(host.serving(), R2);
});

test("workers that never pick up the new config fail the activation and the previous config is reloaded", async () => {
  const { host, deps } = createFakeHost();
  await liveRelease(host, deps, R1);
  const original = host.conf();

  host.behave(R2, {});
  const target = createDockerTarget(deps);
  const ctx = releaseContext(host, R2);
  await target.prepare(ctx);
  await target.verifyCandidate(ctx);

  host.proxyIgnoresReload = true;
  await assert.rejects(target.activate(ctx), /did not start serving release Rel00002/);

  assert.equal(host.conf(), original, "the previous configuration is restored on disk");
  assert.equal(host.serving(), R1, "and R1 keeps serving");
  assert.ok(
    host.commands.filter((c) => c.command.includes("'-s' 'reload'")).length >= 3,
    "the restored config is reloaded as well, so disk and running config agree"
  );
});

test("the live check opens a fresh connection (a pooled one may still be attached to an old proxy worker)", async () => {
  const { host, deps } = createFakeHost();
  const seen = [];
  deps.httpGet = async (url, options) => { seen.push(options); return { status: 200, headers: {}, body: Buffer.alloc(0) }; };
  await liveRelease(host, { ...deps, httpGet: deps.httpGet }, R1).catch(() => undefined);

  assert.ok(seen.length > 0 && seen.every((o) => o?.freshConnection === true));
});

test("the handshake path is unguessable, differs per rendered config, and carries only the release ID", () => {
  const first = renderProxyConfig({ container: "shipflow-shop-Rel00001", port: 3000, releaseId: R1 });
  const second = renderProxyConfig({ container: "shipflow-shop-Rel00001", port: 3000, releaseId: R1 });
  const token = parseHandshakeToken(first);

  assert.match(token, /^[a-f0-9]{16}$/);
  assert.notEqual(token, parseHandshakeToken(second), "a fresh token for every rendered config");
  assert.ok(first.includes(`location = /${handshakePath(token)} {`));
  assert.match(first, /return 200 "Rel00001";/);
  assert.match(renderProxyConfig(null), /return 200 "none";/);
  assert.equal(parseHandshakeToken(renderProxyConfig(null, "0123456789abcdef")), "0123456789abcdef");
  assert.doesNotMatch(first, /location = \/__shipflow_release/, "no fixed, guessable path");

  for (const bad of ["", "xyz", "0123456789ABCDEF", "../../etc/pass", "0123456789abcde"]) {
    assert.throws(() => handshakePath(bad), /Invalid handshake token/, bad);
  }
});

// ===================================================== candidate left behind after a failed activation

async function preparedCandidate(host, deps, releaseId, logs = []) {
  host.behave(releaseId, {});
  const target = createDockerTarget(deps);
  const ctx = releaseContext(host, releaseId, { logs });
  await target.prepare(ctx);
  await target.verifyCandidate(ctx);

  return { target, ctx, logs };
}

test("activation throwing after preparation leaves a running candidate until the pipeline discards it (and never touches the live release)", async () => {
  const { host, deps } = createFakeHost();
  await liveRelease(host, deps, R1);
  const liveConf = host.conf();
  const { target, ctx, logs } = await preparedCandidate(host, deps, R2);

  host.failNginxTest = true;
  await assert.rejects(target.activate(ctx), /nginx -t/);

  // The documented failure mode: without cleanup the candidate (and its environment) stays.
  assert.deepEqual(host.running(), [R1, R2], "the unused candidate is still running");

  await discardUnusedCandidate({ target, ctx, log: (m) => logs.push(m) });

  assert.deepEqual(host.existing(), [R1], "only the candidate was removed");
  assert.equal(host.serving(), R1);
  assert.equal(host.conf(), liveConf);
});

test("a release cancelled after verification, before activation, is removed", async () => {
  const { host, deps } = createFakeHost();
  await liveRelease(host, deps, R1);
  const { target, ctx } = await preparedCandidate(host, deps, R2);

  await discardUnusedCandidate({ target, ctx, log: () => undefined });

  assert.deepEqual(host.existing(), [R1]);
  assert.equal(host.serving(), R1);
});

test("a first deployment whose activation fails leaves no container and a 503 proxy", async () => {
  const { host, deps } = createFakeHost();
  const { target, ctx } = await preparedCandidate(host, deps, R1);

  host.proxyIgnoresReload = true; // the proxy never picks the new config up
  await assert.rejects(target.activate(ctx), /did not start serving release Rel00001/);
  await discardUnusedCandidate({ target, ctx, log: () => undefined });

  assert.deepEqual(host.existing(), []);
  assert.equal(host.serving(), null);
  assert.match(host.conf(), /No active release/);
  assert.ok(!host.conf().includes("shipflow-upstream: shipflow-shop"), "the rejected upstream is not left in the config");
});

test("the release the proxy serves is never discarded, and nothing is removed when what is live cannot be read", async () => {
  const { host, deps } = createFakeHost();
  await liveRelease(host, deps, R1);
  const target = createDockerTarget(deps);
  const logs = [];

  // e.g. a failed revert left the failed release as the only thing serving
  await target.discardCandidate(releaseContext(host, R1, { logs }));
  assert.deepEqual(host.existing(), [R1]);

  host.containers.set(`shipflow-shop-${R2}`, { running: true, image: digestOf(R2), release: R2, role: "release" });
  host.failConfRead = true;
  await target.discardCandidate(releaseContext(host, R2, { logs }));

  assert.deepEqual(host.existing(), [R1, R2], "unknown live state: leave everything in place");
  assert.ok(logs.some((m) => /cannot tell whether it is live/.test(m)));
});

test("discard failures are logged and never replace the original error; targets without the hook are skipped", async () => {
  const logs = [];
  const failing = { discardCandidate: async () => { throw new Error("ssh: connection refused"); } };

  await discardUnusedCandidate({ target: failing, ctx: {}, log: (m, level) => logs.push([m, level]) });
  assert.deepEqual(logs, [["Could not remove the unused candidate: ssh: connection refused", "WARN"]]);

  await discardUnusedCandidate({ target: {}, ctx: {}, log: () => assert.fail("nothing to report") });
});

test("a previous release that is running but unhealthy is not switched back to", async () => {
  const { host, deps } = createFakeHost();
  await liveRelease(host, deps, R1);
  host.behave(R1, { candidate: 500, live: 200 }); // up, but no longer answering

  host.behave(R2, { live: 500 });
  const result = await deploy({ host, deps, releaseId: R2, previous: R1 });

  assert.match(result.message, new RegExp(`ALSO FAILED to restore ${R1}.*did not answer`));
  assert.equal(parseActiveUpstream(host.conf()).releaseId, R2, "traffic was not pointed at an unhealthy release");
});

test("a rejected config is not left behind when there was no previous config to restore", async () => {
  const { host, deps } = createFakeHost();
  const { target, ctx } = await preparedCandidate(host, deps, R1);

  host.files.delete(`${HOME}/.shipflow/shop/conf/default.conf`);
  host.failNginxTest = true;
  await assert.rejects(target.activate(ctx), /nginx -t/);

  assert.match(host.conf(), /No active release/);
});

test("the target asks the pipeline to re-check a restored release", () => {
  assert.equal(createDockerTarget(createFakeHost().deps).capabilities.verifyAfterRevert, true);
});

// ===================================================== Issue 2: upstream resolution

test("the proxy resolves the upstream per request through Docker's embedded DNS", () => {
  const conf = renderProxyConfig({ container: "shipflow-shop-Rel00001", port: 3000, releaseId: R1 });

  assert.equal(DOCKER_DNS_RESOLVER, "127.0.0.11");
  assert.match(conf, /resolver 127\.0\.0\.11 valid=5s ipv6=off;/);
  assert.match(conf, /set \$shipflow_upstream "shipflow-shop-Rel00001:3000";/);
  assert.match(conf, /proxy_pass http:\/\/\$shipflow_upstream;/);
  assert.doesNotMatch(conf, /proxy_pass http:\/\/shipflow-/, "no name baked into proxy_pass (it would be resolved once)");
  const addresses = conf.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g) ?? [];
  assert.deepEqual(
    [...new Set(addresses)].sort(),
    ["127.0.0.1", "127.0.0.11"],
    "only loopback (handshake ACL) and Docker's resolver appear; no container IP is hard-coded"
  );
  assert.match(conf, /error_page 502 504 = @shipflow_unavailable;/);
  assert.match(conf, /location @shipflow_unavailable \{[^}]*Retry-After 5[^}]*return 503/s);
  assert.deepEqual(parseActiveUpstream(conf), { container: "shipflow-shop-Rel00001", port: 3000, releaseId: R1 });
});

test("generated configuration is structurally sound and only interpolates validated values", () => {
  for (const upstream of [null, { container: "shipflow-shop-Rel00001", port: 3000, releaseId: R1 }]) {
    const conf = renderProxyConfig(upstream);
    const opens = (conf.match(/\{/g) ?? []).length;
    const closes = (conf.match(/\}/g) ?? []).length;

    assert.equal(opens, closes, "balanced braces");

    for (const line of conf.split("\n").map((l) => l.trim()).filter(Boolean)) {
      assert.ok(line.startsWith("#") || /[;{}]$/.test(line), `directive without terminator: ${line}`);
    }
  }

  for (const container of ['a";b', "a b", "a$b", "a\nb", "", "x".repeat(200)]) {
    assert.throws(() => renderProxyConfig({ container, port: 3000, releaseId: R1 }), /Invalid upstream/, JSON.stringify(container));
  }

  for (const port of [0, 70000, 3000.5, Number.NaN]) {
    assert.throws(() => renderProxyConfig({ container: "ok", port, releaseId: R1 }), /Invalid upstream port/);
  }
});

test("the no-release block needs no resolver and starts with no upstream", () => {
  const conf = renderProxyConfig(null);

  assert.doesNotMatch(conf, /resolver|proxy_pass/);
  assert.match(conf, /return 503/);
  assert.equal(parseActiveUpstream(conf), null);
});

// ===================================================== Issue 3: redaction boundary

const NGINX_WORD = "resolver"; // a "secret" that is a substring of legitimate nginx configuration

test("restoring the previous nginx config writes back the exact bytes even when a secret is a substring of them", async () => {
  const { host, deps } = createFakeHost();
  await liveRelease(host, deps, R1);
  const original = host.conf();
  assert.ok(original.includes(NGINX_WORD), "the fixture config really contains the secret text");

  const logs = [];
  host.behave(R2, {});
  const ctx = releaseContext(host, R2, { secrets: { API_TOKEN: NGINX_WORD }, logs });
  const target = createDockerTarget(deps);
  await target.prepare(ctx);
  await target.verifyCandidate(ctx);

  host.failNginxTest = true;
  host.nginxOutput = `nginx: [emerg] unknown directive "${NGINX_WORD}" in /etc/nginx/conf.d/default.conf:5`;

  await assert.rejects(target.activate(ctx), (error) => {
    assert.match(error.message, /nginx -t/);
    assert.ok(error.message.includes("[REDACTED]"), "the report is redacted");
    assert.ok(!error.message.includes(NGINX_WORD), "no raw secret in the user-facing error");
    return true;
  });

  assert.equal(host.conf(), original, "restored byte for byte, not as redacted text");
  assert.equal(host.serving(), R1, "the previous release keeps serving");
  assert.ok(!logs.join("\n").includes(NGINX_WORD));
});

test("parsing is never corrupted by secrets that match parts of docker output", async () => {
  const { host, deps } = createFakeHost();
  const secrets = { SHORT_BOOL: "true", SHORT_HASH: "sha256", SHORT_NAME: "shop" };
  const logs = [];

  host.behave(R1, {});
  const result = await deploy({ host, deps, releaseId: R1, previous: null, secrets, logs });

  assert.equal(result.ok, true, "inspect output like 'sha256:…|true|false|0' still parses");
  assert.equal(host.serving(), R1);
});

test("errors and check details never carry raw secrets, whatever the command output was", async () => {
  const { host, deps } = createFakeHost();
  const secret = "hunter2hunter2";
  const ctx = releaseContext(host, R1, { secrets: { DB_PASSWORD: secret }, runtimeSecrets: ["DB_PASSWORD"] });
  const original = deps.openRemote;

  deps.openRemote = async (c) => {
    const remote = await original(c);
    return {
      ...remote,
      exec: async (command, options) =>
        command.includes("'wget'")
          ? { exitCode: 1, timedOut: false, output: `wget: server said ${secret}` }
          : command.includes("'logs'")
            ? { exitCode: 0, timedOut: false, output: `boot with ${secret}` }
            : remote.exec(command, options),
    };
  };

  const target = createDockerTarget(deps); // created after the override: deps are copied at creation
  host.behave(R1, {});
  await target.prepare(ctx);
  await assert.rejects(target.verifyCandidate(ctx), (error) => {
    assert.ok(!error.message.includes(secret));
    assert.match(error.message, /boot with \[REDACTED\]/);
    return true;
  });
});

test("temp files are removed on failed writes and the env file's temp copy is cleaned up", async () => {
  const { host, deps } = createFakeHost();
  host.behave(R1, {});
  const ctx = releaseContext(host, R1, { secrets: { DB_PASSWORD: "pw-value-1" }, runtimeSecrets: ["DB_PASSWORD"] });
  await createDockerTarget(deps).prepare(ctx);

  const write = host.commands.find((c) => c.command.startsWith("umask 077"));
  assert.match(write.command, /\|\| \{ rm -f '[^']+\.tmp'; exit 1; \}/, "a failed write removes its temp file");

  const cleanup = host.commands.filter((c) => c.command.startsWith("rm -f ")).at(-1).command;
  assert.ok(cleanup.includes(`env-${R1}'`) && cleanup.includes(`env-${R1}.tmp'`), "both env files are removed");
  assert.ok(![...host.files.keys()].some((f) => f.includes("private/env-")), "no env file remains on the host");
  assert.equal(HOME, "/home/deploy");
});
