// The docker target against a scripted fake remote (no SSH, no Docker).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createDockerTarget,
  renderProxyConfig,
  parseActiveUpstream,
  buildEnvFile,
  selectContainersToRemove,
  parseReleaseContainers,
  parseWgetStatus,
  shellQuote,
  networkName,
  releaseContainerName,
  imageTag,
} from "../../dist/src/targets/docker.js";
import { getTarget } from "../../dist/src/targets/index.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const SECRET = "s3cr3t-value-123";
const KEY = "-----BEGIN KEY-----\nkeymaterial\n-----END KEY-----";
const HOME = "/home/deploy";

const targetConfig = {
  host: "docker.example.com",
  port: 22,
  user: "deploy",
  hostKey: "ssh-ed25519 AAAAC3",
  privateKeySecret: "DOCKER_KEY",
  publishPort: 8080,
  url: "http://docker.example.com:8080",
};

function makeCtx(overrides = {}) {
  const logs = [];
  return {
    logs,
    ctx: {
      project: "shop",
      releaseId: "Abcd1234",
      targetConfig,
      verification: { path: "/health", expectStatus: 200 },
      secrets: { DOCKER_KEY: KEY, DB_PASSWORD: SECRET },
      artifact: { type: "image", key: "k", digest: DIGEST, sizeBytes: 10, port: 3000 },
      runtime: { port: 3000, env: { MODE: "prod" }, secrets: ["DB_PASSWORD"] },
      ensureArtifactDir: async () => "/unused",
      ensureImageArchive: async () => "/tmp/image.tar",
      log: (m) => logs.push(m),
      ...overrides,
    },
  };
}

/**
 * Fake remote. `script(command, options, state)` may return a partial result;
 * unmatched commands succeed with empty output.
 */
function fakeRemote(script = () => undefined) {
  const calls = [];
  const state = { files: {}, ids: {}, running: true, wget: "HTTP/1.1 200 OK", conf: null, imageId: DIGEST };
  const deps = {
    openRemote: async () => ({
      exec: async (command, options) => {
        calls.push({ command, options });
        const custom = script(command, options, state);
        if (custom) return { exitCode: 0, timedOut: false, output: "", ...custom };
        const ok = (output = "") => ({ exitCode: 0, timedOut: false, output });
        const no = (output = "") => ({ exitCode: 1, timedOut: false, output });
        if (command.startsWith("printf %s")) return ok(HOME);
        if (command.includes("'image' 'inspect'")) return state.imageId ? ok(state.imageId) : no("No such image");
        if (command.includes("'load'")) return ok("Loaded image ID: " + DIGEST);
        if (command.includes("'inspect' '-f' '{{.Image}}")) {
          return ok(`${state.imageId}|${state.running}|false|0`);
        }
        if (command.includes("'inspect' '-f' '{{.State.Running}}'")) {
          if (command.includes("-proxy'")) return state.proxy ? ok("true") : no("none");
          return ok(String(state.running));
        }
        if (command.startsWith("test -f")) return state.conf === null ? no() : ok();
        if (command.startsWith("cat ") && command.includes("default.conf")) {
          return state.conf === null ? no("") : ok(state.conf);
        }
        if (command.startsWith("umask") && options?.stdin && "text" in options.stdin) {
          const target = /mv -f '[^']+' '([^']+)'/.exec(command)?.[1];
          state.files[target] = options.stdin.text;
          if (target?.endsWith("default.conf")) state.conf = options.stdin.text;
          return ok();
        }
        if (command.includes("'wget'")) return ok(state.wget);
        if (command.includes("'ps' '-a'")) return ok("");
        return ok();
      },
      close: async () => undefined,
    }),
    httpGet: async () => ({ status: 200, headers: {}, body: Buffer.alloc(0) }),
    sleep: async () => undefined,
    now: (() => { let t = 0; return () => (t += 20_000); })(),
  };
  return { calls, state, deps };
}

const commandsOf = (calls) => calls.map((c) => c.command);

test("registered and capabilities", () => {
  const target = getTarget("docker");
  assert.deepEqual(target.capabilities, {
    artifactTypes: ["image"], candidateVerification: "http", atomicActivation: true, rollback: true,
  });
  assert.deepEqual(target.requiredSecrets(targetConfig), ["DOCKER_KEY"]);
});

test("prepare loads the archive, verifies the digest and starts an unpublished candidate", async () => {
  const { calls, state, deps } = fakeRemote((command, _o, st) => {
    if (command.includes("'image' 'inspect'")) {
      // missing before load, present afterwards
      return st.loaded ? { output: DIGEST } : { exitCode: 1, output: "No such image" };
    }
    if (command.includes("'load'")) { st.loaded = true; return { output: "ok" }; }
    return undefined;
  });
  const { ctx } = makeCtx();
  const result = await createDockerTarget(deps).prepare(ctx);
  const commands = commandsOf(calls);

  const load = calls.find((c) => c.command.includes("'load'"));
  assert.deepEqual(load.options.stdin, { file: "/tmp/image.tar" });
  assert.ok(commands.some((c) => c.includes("'tag'")));
  assert.match(result.detail, /loaded/);

  const run = commands.find((c) => c.startsWith("'docker' 'run' '-d' '--name' 'shipflow-shop-Abcd1234'"));
  assert.ok(run, "candidate started");
  assert.ok(run.includes("'--cap-drop' 'ALL'") && run.includes("'no-new-privileges'") && run.includes("'--memory'"));
  assert.ok(run.includes("'--env-file' '/home/deploy/.shipflow/shop/private/env-Abcd1234'"));
  assert.ok(!/'-p'|'--publish'/.test(run), "no host port for the candidate");
  assert.ok(commands.some((c) => c.includes("'-p' '8080:80'")), "proxy publishes the port");

  // env file flows through stdin only, then is deleted
  const envWrite = calls.find((c) => c.command.includes("private/env-Abcd1234.tmp"));
  assert.ok(envWrite.options.stdin.text.includes(`DB_PASSWORD=${SECRET}`));
  assert.ok(envWrite.command.startsWith("umask 077"));
  assert.ok(commands.at(-1).startsWith("rm -f") && commands.at(-1).includes("env-Abcd1234"));
  assert.ok(state.files["/home/deploy/.shipflow/shop/conf/default.conf"].includes("return 503"));

  for (const c of commands) {
    assert.ok(!c.includes(SECRET), "secret on a command line");
    assert.ok(!c.includes("keymaterial"));
  }
});

test("prepare skips the load when the tag already has the expected image", async () => {
  const { calls, deps } = fakeRemote();
  const { ctx } = makeCtx();
  const result = await createDockerTarget(deps).prepare(ctx);

  assert.ok(!commandsOf(calls).some((c) => c.includes("'load'")));
  assert.match(result.detail, /reused/);
});

test("prepare refuses a digest mismatch and starts nothing", async () => {
  const other = `sha256:${"b".repeat(64)}`;
  const { calls, deps } = fakeRemote((command, _o, st) => {
    if (command.includes("'image' 'inspect'")) return st.loaded ? { output: other } : { exitCode: 1 };
    if (command.includes("'load'")) { st.loaded = true; return {}; }
    return undefined;
  });
  const { ctx } = makeCtx();

  await assert.rejects(() => createDockerTarget(deps).prepare(ctx), /does not match the built image/);
  assert.ok(!commandsOf(calls).some((c) => c.includes("'run'")));
});

test("prepare rejects a missing runtime secret without leaking others, and cleans up", async () => {
  const { calls, deps } = fakeRemote();
  const { ctx } = makeCtx({ secrets: { DOCKER_KEY: KEY } });

  await assert.rejects(() => createDockerTarget(deps).prepare(ctx), /DB_PASSWORD is not available/);
  assert.ok(!commandsOf(calls).some((c) => c.includes("'run' '-d' '--name' 'shipflow-shop-Abcd1234'")));
});

test("a failing docker run removes the candidate and the env file; errors are redacted", async () => {
  const { calls, deps } = fakeRemote((command) => {
    if (command.includes("'run' '-d' '--name' 'shipflow-shop-Abcd1234'")) {
      return { exitCode: 125, output: `boom ${SECRET}` };
    }
    return undefined;
  });
  const { ctx } = makeCtx();

  await assert.rejects(
    () => createDockerTarget(deps).prepare(ctx),
    (error) => /boom/.test(error.message) && !error.message.includes(SECRET)
  );
  const commands = commandsOf(calls);
  assert.ok(commands.some((c) => c.startsWith("rm -f") && c.includes("env-Abcd1234")));
  assert.ok(commands.at(-2).includes("'rm' '-f' 'shipflow-shop-Abcd1234'"));
});

test("verifyCandidate checks over HTTP from the proxy and passes", async () => {
  const { calls, deps } = fakeRemote();
  const { ctx } = makeCtx();
  const result = await createDockerTarget(deps).verifyCandidate(ctx);

  const probe = commandsOf(calls).find((c) => c.includes("'wget'"));
  assert.ok(probe.includes("'exec' 'shipflow-shop-proxy' 'wget'"));
  assert.ok(probe.includes("'http://shipflow-shop-Abcd1234:3000/health'"));
  assert.match(result.detail, /HTTP 200/);
});

test("verifyCandidate failure removes the candidate and includes redacted logs", async () => {
  const { calls, deps } = fakeRemote((command) => {
    if (command.includes("'wget'")) return { exitCode: 1, output: "HTTP/1.1 502 Bad Gateway" };
    if (command.includes("'logs'")) return { output: `starting with ${SECRET}\nlistening` };
    return undefined;
  });
  const { ctx } = makeCtx();

  await assert.rejects(
    () => createDockerTarget(deps).verifyCandidate(ctx),
    (error) => /HTTP 502/.test(error.message) && /listening/.test(error.message) && !error.message.includes(SECRET)
  );
  assert.ok(commandsOf(calls).some((c) => c.includes("'rm' '-f' 'shipflow-shop-Abcd1234'")));
  assert.ok(!commandsOf(calls).some((c) => c.includes("nginx")), "live config untouched");
});

test("verifyCandidate detects a crash-looping container", async () => {
  const { deps } = fakeRemote((command) => {
    if (command.includes("{{.Image}}")) return { output: `${DIGEST}|true|false|3` };
    return undefined;
  });
  const { ctx } = makeCtx();

  await assert.rejects(() => createDockerTarget(deps).verifyCandidate(ctx), /not staying up/);
});

test("verifyCandidate refuses a container running a different image", async () => {
  const { deps } = fakeRemote((command) => {
    if (command.includes("{{.Image}}")) return { output: `sha256:${"c".repeat(64)}|true|false|0` };
    return undefined;
  });
  const { ctx } = makeCtx();

  await assert.rejects(() => createDockerTarget(deps).verifyCandidate(ctx), /expected sha256/);
});

test("activate reloads only after nginx -t passes", async () => {
  const { calls, state, deps } = fakeRemote();
  state.conf = renderProxyConfig(null);
  const { ctx } = makeCtx();
  await createDockerTarget(deps).activate(ctx);
  const commands = commandsOf(calls);

  const write = commands.findIndex((c) => c.startsWith("umask 022") && c.includes("default.conf"));
  const test_ = commands.findIndex((c) => c.includes("'nginx' '-t'"));
  const reload = commands.findIndex((c) => c.includes("'nginx' '-s' 'reload'"));
  assert.ok(write >= 0 && write < test_ && test_ < reload);
  assert.equal(parseActiveUpstream(state.conf).container, "shipflow-shop-Abcd1234");
});

test("activate restores the previous config and does not reload when nginx -t fails", async () => {
  const previous = renderProxyConfig({ container: "shipflow-shop-Old00000", port: 3000, releaseId: "Old00000" });
  const { calls, state, deps } = fakeRemote((command) => {
    if (command.includes("'nginx' '-t'")) return { exitCode: 1, output: "host not found in upstream" };
    return undefined;
  });
  state.conf = previous;
  const { ctx } = makeCtx();

  await assert.rejects(() => createDockerTarget(deps).activate(ctx), /nginx -t/);
  assert.ok(!commandsOf(calls).some((c) => c.includes("'reload'")));
  assert.equal(state.conf, previous);
});

test("activate stops other release containers but never the new one", async () => {
  const { calls, state, deps } = fakeRemote((command) => {
    if (command.includes("'ps'") && command.includes("status") === false && command.includes("{{.Names}}") && !command.includes("'-a'")) {
      return { output: "shipflow-shop-Abcd1234\nshipflow-shop-Old00000\nother-thing\n" };
    }
    return undefined;
  });
  state.conf = renderProxyConfig(null);
  const { ctx } = makeCtx();
  await createDockerTarget(deps).activate(ctx);
  const stops = commandsOf(calls).filter((c) => c.includes("'stop'"));

  assert.deepEqual(stops.length, 1);
  assert.ok(stops[0].includes("shipflow-shop-Old00000"));
});

test("deactivate serves 503 only when the proxy points at this release, and removes the candidate", async () => {
  const mine = fakeRemote();
  mine.state.conf = renderProxyConfig({ container: "shipflow-shop-Abcd1234", port: 3000, releaseId: "Abcd1234" });
  await createDockerTarget(mine.deps).deactivate(makeCtx().ctx);
  assert.ok(mine.state.conf.includes("return 503"));
  assert.ok(commandsOf(mine.calls).some((c) => c.includes("'rm' '-f' 'shipflow-shop-Abcd1234'")));

  const other = fakeRemote();
  const before = renderProxyConfig({ container: "shipflow-shop-Old00000", port: 3000, releaseId: "Old00000" });
  other.state.conf = before;
  await createDockerTarget(other.deps).deactivate(makeCtx().ctx);
  assert.equal(other.state.conf, before);
});

test("verifyLive checks the public URL and retries", async () => {
  const { deps } = fakeRemote();
  const urls = [];
  let n = 0;
  deps.httpGet = async (url) => { urls.push(url); return { status: ++n < 2 ? 502 : 200, headers: {}, body: Buffer.alloc(0) }; };
  const result = await createDockerTarget(deps).verifyLive(makeCtx().ctx);

  assert.equal(result.url, "http://docker.example.com:8080/health");
  assert.equal(urls.length, 2);
});

test("check reports ssh failure and port conflicts", async () => {
  const bad = fakeRemote();
  bad.deps.openRemote = async () => { throw new Error("Cannot connect to docker.example.com:22."); };
  const failed = await createDockerTarget(bad.deps).check(makeCtx().ctx);
  assert.equal(failed[0].ok, false);

  const busy = fakeRemote((command) => {
    if (command.includes("'--filter' 'publish=8080'")) return { output: "nginx-other\n" };
    return undefined;
  });
  const checks = await createDockerTarget(busy.deps).check(makeCtx().ctx);
  assert.equal(checks.find((c) => c.name.startsWith("port")).ok, false);
  assert.equal(checks.find((c) => c.name === "docker daemon").ok, true);
});

test("hostile names and values are rejected or quoted", async () => {
  assert.throws(() => networkName("a; rm -rf /"), /Invalid project/);
  assert.throws(() => releaseContainerName("shop", "x y"), /Invalid release/);
  assert.throws(() => imageTag("Shop", "Abcd1234"), /Invalid project/);
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.throws(() => shellQuote("a\0b"), /NUL/);

  const { calls, deps } = fakeRemote();
  const { ctx } = makeCtx({ releaseId: "x; reboot" });
  await assert.rejects(() => createDockerTarget(deps).prepare(ctx), /Invalid release/);
  assert.equal(calls.length, 0);

  const bad = makeCtx({ targetConfig: { ...targetConfig, host: "h; id" } }).ctx;
  await assert.rejects(() => createDockerTarget(deps).prepare(bad), /Invalid deployment.docker.host/);

  assert.throws(
    () => buildEnvFile({ port: 1, env: { "A B": "x" }, secrets: [] }, {}),
    /Invalid environment variable name/
  );
  assert.throws(
    () => buildEnvFile({ port: 1, env: {}, secrets: ["S"] }, { S: "a\nb" }),
    (error) => /S contains a newline/.test(error.message) && !error.message.includes("a\nb")
  );

  const hostileVerify = makeCtx({ verification: { path: "/x'; id #", expectStatus: 200 } }).ctx;
  await assert.rejects(() => createDockerTarget(deps).verifyCandidate(hostileVerify), /Invalid verification path/);
});

test("proxy config generator", () => {
  const conf = renderProxyConfig({ container: "shipflow-shop-Abcd1234", port: 3000, releaseId: "Abcd1234" });
  assert.match(conf, /proxy_pass http:\/\/shipflow-shop-Abcd1234:3000;/);
  assert.match(conf, /# shipflow-upstream: shipflow-shop-Abcd1234:3000 release=Abcd1234/);
  assert.deepEqual(parseActiveUpstream(conf), { container: "shipflow-shop-Abcd1234", port: 3000, releaseId: "Abcd1234" });
  assert.equal(parseActiveUpstream(renderProxyConfig(null)), null);
  assert.match(renderProxyConfig(null), /return 503/);
  assert.throws(() => renderProxyConfig({ container: "a;b", port: 1, releaseId: "Abcd1234" }), /Invalid upstream/);
  assert.throws(() => renderProxyConfig({ container: "ok", port: 0, releaseId: "Abcd1234" }), /Invalid upstream port/);
});

test("env file contents", () => {
  const text = buildEnvFile({ port: 3000, env: { MODE: "prod" }, secrets: ["S"] }, { S: "v" });
  assert.equal(text, "PORT=3000\nMODE=prod\nS=v\n");
  assert.equal(buildEnvFile({ port: 3000, env: { PORT: "9" }, secrets: [] }, {}), "PORT=9\n");
});

test("container pruning planner", () => {
  const list = ["R0000005", "R0000004", "R0000003", "R0000002", "R0000001"].map((releaseId) => ({
    name: `shipflow-shop-${releaseId}`, releaseId,
  }));
  assert.deepEqual(selectContainersToRemove(list, { keep: 3 }).map((c) => c.releaseId), ["R0000002", "R0000001"]);
  assert.deepEqual(
    selectContainersToRemove(list, { keep: 3, liveReleaseId: "R0000001", protectReleaseIds: ["R0000002"] }).map((c) => c.releaseId),
    []
  );
  assert.equal(selectContainersToRemove(list, { keep: 0 }).length, 5);
  assert.equal(selectContainersToRemove([], { keep: 3 }).length, 0);
});

test("parsers", () => {
  assert.deepEqual(
    parseReleaseContainers("shipflow-shop-Abcd1234|Abcd1234\nevil|Abcd1234\nshipflow-shop-x|bad\n", "shop"),
    [{ name: "shipflow-shop-Abcd1234", releaseId: "Abcd1234" }]
  );
  assert.equal(parseWgetStatus("  HTTP/1.1 301 Moved\n  HTTP/1.1 200 OK\n"), 200);
  assert.equal(parseWgetStatus("wget: bad address"), null);
});
