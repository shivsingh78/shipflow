import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { detectStrategy, getStrategy, DetectionError } from "../../dist/src/strategies/index.js";
import { generateNodeDockerfile, createNodeStrategy, NODE_DOCKERIGNORE } from "../../dist/src/strategies/node.js";
import { createDockerfileStrategy, resolveDockerfile } from "../../dist/src/strategies/dockerfile.js";
import { buildImage, candidateTag } from "../../dist/src/strategies/imageBuilder.js";
import { archiveConfigDigest } from "../../dist/src/strategies/archive.js";
import { config } from "../../dist/src/config.js";

const projects = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/projects");
const fixture = (name) => path.join(projects, name);
const baseBuild = { install: "auto", command: "auto", output: "auto", test: "auto", env: {} };
const runtime = { port: 3000, env: {}, secrets: [] };

const detect = (name, targetName, extra = {}) =>
  detectStrategy({ workspacePath: fixture(name), build: baseBuild, targetName, ...extra });

test("static targets always detect static, even with a Dockerfile", async () => {
  for (const target of ["shipflow", "ssh"]) {
    for (const name of ["static-site", "node-api", "dockerfile-app", "ambiguous"]) {
      assert.equal((await detect(name, target)).strategy, "static", `${name} on ${target}`);
    }
  }
});

test("image targets: Dockerfile wins, then node start script", async () => {
  const docker = await detect("dockerfile-app", "docker", { runtime });
  assert.equal(docker.strategy, "dockerfile");
  assert.match(docker.reason, /takes precedence/);

  assert.equal((await detect("node-api", "kubernetes", { runtime })).strategy, "node");
  assert.equal((await detect("ambiguous", "docker", { runtime: { ...runtime, start: "node x.js" } })).strategy, "node");
});

test("image targets: unclear repositories get an actionable error", async () => {
  await assert.rejects(detect("ambiguous", "docker", { runtime }), (error) => {
    assert.ok(error instanceof DetectionError);
    assert.match(error.message, /Dockerfile: not found/);
    assert.match(error.message, /no "start" script/);
    assert.match(error.message, /build\.strategy/);
    return true;
  });
});

test("image targets: static frontends are refused for image targets", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sf-det-"));
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ scripts: { build: "vite build", start: "vite preview" } }));
  await assert.rejects(
    detectStrategy({ workspacePath: dir, build: baseBuild, targetName: "docker", runtime }),
    /static frontend/
  );
  await fs.rm(dir, { recursive: true });
});

test("image target without runtime config is an error", async () => {
  await assert.rejects(detect("missing-runtime-config", "docker"), /no runtime section/);
  await assert.rejects(detect("missing-runtime-config", "kubernetes", { runtime: null }), DetectionError);
});

test("explicit strategy wins but must match the target", async () => {
  const explicit = (strategy, target, extra = {}) =>
    detectStrategy({ workspacePath: fixture("dockerfile-app"), build: { ...baseBuild, strategy }, targetName: target, ...extra });

  assert.equal((await explicit("node", "docker", { runtime })).strategy, "node");
  assert.equal((await explicit("static", "ssh")).strategy, "static");
  await assert.rejects(explicit("static", "docker", { runtime }), /produces static files/);
  await assert.rejects(explicit("dockerfile", "shipflow"), /serves static files/);
  await assert.rejects(explicit("node", "kubernetes"), /no runtime section/);
});

test("custom build.dockerfile must exist", async () => {
  await assert.rejects(
    detectStrategy({ workspacePath: fixture("node-api"), build: { ...baseBuild, dockerfile: "deploy/Dockerfile" }, targetName: "docker", runtime }),
    /does not exist/
  );
});

test("registry returns strategies with expected metadata", () => {
  assert.deepEqual(
    ["static", "node", "dockerfile"].map((id) => [getStrategy(id).artifactType, getStrategy(id).usesSandbox]),
    [["static", true], ["image", true], ["image", false]]
  );
});

const npm = { name: "npm", hasLockfile: true, yarnBerry: false };
const gen = (overrides = {}) =>
  generateNodeDockerfile({ packageManager: npm, startCommand: "node server.js", port: 3000, hasBuildScript: false, nodeMajor: 22, ...overrides });

test("generated Dockerfile is deterministic, multi-stage, non-root, with no secrets", () => {
  const dockerfile = gen();
  assert.equal(dockerfile, gen());
  assert.match(dockerfile, /^FROM node:22-alpine AS build$/m);
  assert.equal(dockerfile.match(/^FROM /gm).length, 2);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /^EXPOSE 3000$/m);
  assert.match(dockerfile, /npm ci --no-audit --no-fund/);
  assert.match(dockerfile, /npm ci --omit=dev/);
  assert.match(dockerfile, /^CMD \["sh","-c","exec node server\.js"\]$/m);
  assert.doesNotMatch(dockerfile, /^ARG /m);
  assert.doesNotMatch(dockerfile, /SECRET|TOKEN|PASSWORD/i);
  assert.doesNotMatch(dockerfile, /RUN .*npm run build/);
});

test("generated Dockerfile: frozen lockfile installs per package manager", () => {
  const pnpm = gen({ packageManager: { name: "pnpm", hasLockfile: true, yarnBerry: false }, hasBuildScript: true });
  assert.match(pnpm, /corepack pnpm install --frozen-lockfile$/m);
  assert.match(pnpm, /corepack pnpm install --frozen-lockfile --prod/);
  assert.match(pnpm, /RUN corepack pnpm run build/);

  const yarn = gen({ packageManager: { name: "yarn", hasLockfile: true, yarnBerry: false } });
  assert.match(yarn, /corepack yarn install --frozen-lockfile$/m);
  assert.match(yarn, /corepack yarn install --frozen-lockfile --production/);

  const noLock = gen({ packageManager: { name: "npm", hasLockfile: false, yarnBerry: false } });
  assert.match(noLock, /npm install --omit=dev/);
});

test("generated Dockerfile: CMD escapes compound commands and rejects bad input", () => {
  const compound = gen({ startCommand: 'node a.js && echo "hi"' });
  assert.match(compound, /^CMD \["sh","-c","node a\.js && echo \\"hi\\""\]$/m);
  assert.throws(() => gen({ port: 0 }), /Invalid port/);
  assert.throws(() => gen({ startCommand: "  " }), /start command/);
  assert.match(gen({ buildCommand: "make assets" }), /^RUN make assets$/m);
  assert.match(NODE_DOCKERIGNORE, /\.git\n/);
  assert.match(NODE_DOCKERIGNORE, /node_modules/);
  assert.match(NODE_DOCKERIGNORE, /\.env\.\*/);
});

function fakeDocker({ id = `sha256:${"a".repeat(64)}`, archiveBytes = 10, failOn = null } = {}) {
  const calls = [];
  const run = async (label, _command, args) => {
    calls.push({ label, args });
    if (failOn === label) throw new Error(`${label} failed`);
    if (args[0] === "image") return { output: `${id}\n` };
    if (args[0] === "save") await fs.writeFile(args[2], Buffer.alloc(archiveBytes));
    return { output: "ok" };
  };
  return { calls, run };
}

async function withImageBuilds(enabled, fn) {
  const before = config.imageBuilds;
  config.imageBuilds = enabled;
  try {
    return await fn();
  } finally {
    config.imageBuilds = before;
  }
}

const imageInput = async (run) => ({
  releaseId: "Rel_1",
  contextDir: fixture("node-api"),
  dockerfilePath: fixture("dockerfile-app/Dockerfile"),
  port: 3000,
  scratchDir: await fs.mkdtemp(path.join(os.tmpdir(), "sf-img-")),
  log: async () => {},
  run,
});

test("buildImage parses the digest, exports the archive and cleans up", async () => {
  await withImageBuilds(true, async () => {
    const docker = fakeDocker();
    const image = await buildImage(await imageInput(docker.run));
    assert.equal(image.digest, `sha256:${"a".repeat(64)}`);
    assert.equal(image.sizeBytes, 10);
    assert.equal(image.port, 3000);
    const build = docker.calls[0].args;
    assert.equal(build[0], "build");
    assert.ok(build.includes(candidateTag("Rel_1")));
    assert.equal(candidateTag("Rel_1"), "shipflow-build/rel_1:candidate");
    assert.ok(build.includes("shipflow.release=Rel_1"));
    assert.ok(!build.some((arg) => arg.startsWith("--build-arg") || arg === "--secret"));
    assert.deepEqual(docker.calls.at(-1).args.slice(0, 2), ["rmi", "--force"]);
  });
});

test("buildImage always removes the local image, even when a step fails", async () => {
  await withImageBuilds(true, async () => {
    for (const failOn of ["Image build", "Image inspect", "Image export"]) {
      const docker = fakeDocker({ failOn });
      await assert.rejects(buildImage(await imageInput(docker.run)), new RegExp(failOn));
      assert.equal(docker.calls.at(-1).label, "Image cleanup");
    }
    const bad = fakeDocker({ id: "not-a-digest" });
    await assert.rejects(buildImage(await imageInput(bad.run)), /unexpected image ID/);
    assert.equal(bad.calls.at(-1).label, "Image cleanup");
  });
});

test("buildImage refuses oversized images and removes the archive", async () => {
  await withImageBuilds(true, async () => {
    const before = config.maxImageBytes;
    config.maxImageBytes = 5;
    try {
      const docker = fakeDocker({ archiveBytes: 10 });
      const input = await imageInput(docker.run);
      await assert.rejects(buildImage(input), /limit is 5/);
      await assert.rejects(fs.stat(path.join(input.scratchDir, "image.tar")));
      assert.equal(docker.calls.at(-1).label, "Image cleanup");
    } finally {
      config.maxImageBytes = before;
    }
  });
});

test("image builds are off by default and name the flag", async () => {
  await withImageBuilds(false, async () => {
    const docker = fakeDocker();
    await assert.rejects(buildImage(await imageInput(docker.run)), /SHIPFLOW_IMAGE_BUILDS=enabled.*isolat/s);
    assert.equal(docker.calls.length, 0);

    const strategyInput = { releaseId: "r", workspacePath: fixture("dockerfile-app"), build: baseBuild, runtime, scratchDir: os.tmpdir(), log: async () => {} };
    await assert.rejects(createDockerfileStrategy({ run: docker.run }).produce(strategyInput, null, { dockerfilePath: "x" }), /SHIPFLOW_IMAGE_BUILDS=enabled/);
    await assert.rejects(
      createNodeStrategy({ run: docker.run }).produce({ ...strategyInput, workspacePath: fixture("node-api") }, null, {
        packageJson: {}, packageManager: npm, startCommand: "node server.js", hasBuildScript: false,
      }),
      /SHIPFLOW_IMAGE_BUILDS=enabled/
    );
    assert.equal(docker.calls.length, 0);
  });
});

test("dockerfile strategy: build validates path, test is skipped, produce builds repo context", async () => {
  const logs = [];
  const input = {
    releaseId: "r1", workspacePath: fixture("dockerfile-app"), build: baseBuild, runtime,
    scratchDir: await fs.mkdtemp(path.join(os.tmpdir(), "sf-df-")), log: async (m) => { logs.push(m); },
  };
  const docker = fakeDocker();
  const strategy = createDockerfileStrategy({ run: docker.run });
  const built = await strategy.build(input, null);
  assert.deepEqual(await strategy.test(input, null, built), { testStatus: "SKIPPED" });
  assert.ok(logs.some((m) => /not executed in pull-request checks/.test(m)));

  await withImageBuilds(true, async () => {
    const artifact = await strategy.produce(input, null, built);
    assert.equal(artifact.type, "image");
    assert.equal(artifact.port, 3000);
    assert.equal(docker.calls[0].args.at(-1), input.workspacePath);
  });
});

test("dockerfile path cannot escape the workspace", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sf-esc-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "sf-out-"));
  await fs.writeFile(path.join(outside, "Dockerfile"), "FROM scratch\n");
  await fs.symlink(path.join(outside, "Dockerfile"), path.join(dir, "Dockerfile"));
  await assert.rejects(resolveDockerfile(dir), /outside the repository/);
  await assert.rejects(resolveDockerfile(dir, "../x/Dockerfile"), /relative path/);
  await assert.rejects(resolveDockerfile(dir, "/etc/passwd"), /relative path/);
  await assert.rejects(resolveDockerfile(dir, "missing"), /not found/);
  assert.equal(await resolveDockerfile(fixture("dockerfile-app")), await fs.realpath(fixture("dockerfile-app/Dockerfile")));
});

test("node strategy refuses a repository without a start command", async () => {
  const sandbox = { kind: "none", exec: async () => ({ output: "" }), disableNetwork: async () => {} };
  const input = { releaseId: "r", workspacePath: fixture("ambiguous"), build: baseBuild, runtime, scratchDir: os.tmpdir(), log: async () => {} };
  await assert.rejects(createNodeStrategy().build(input, sandbox), /No start command/);
});

test("node strategy installs, builds only when a script exists, then runs tests", async () => {
  const execs = [];
  const sandbox = {
    kind: "none",
    exec: async (label, argv) => { execs.push([label, argv.join(" ")]); return { output: "" }; },
    disableNetwork: async () => { execs.push(["network", "off"]); },
  };
  const input = { releaseId: "r", workspacePath: fixture("node-api"), build: baseBuild, runtime, scratchDir: os.tmpdir(), log: async () => {} };
  const strategy = createNodeStrategy();
  const built = await strategy.build(input, sandbox);
  assert.deepEqual(execs.map((e) => e[0]), ["Dependency install", "network"]);
  assert.equal(built.startCommand, "node server.js");
  assert.deepEqual(await strategy.test(input, sandbox, built), { testStatus: "SKIPPED" });

  execs.length = 0;
  await strategy.build({ ...input, build: { ...baseBuild, install: "none", command: "make" } }, sandbox);
  assert.deepEqual(execs, [["network", "off"], ["Build", "sh -c make"]]);
});

test("broken-build fixture surfaces the sandbox build failure", async () => {
  const sandbox = {
    kind: "none",
    exec: async (label) => { if (label === "Build") throw new Error("Build failed with exit code 1"); return { output: "" }; },
    disableNetwork: async () => {},
  };
  const input = { releaseId: "r", workspacePath: fixture("broken-build"), build: baseBuild, runtime: { ...runtime, start: "node x.js" }, scratchDir: os.tmpdir(), log: async () => {} };
  await assert.rejects(createNodeStrategy().build(input, sandbox), /Build failed/);
  await assert.rejects(getStrategy("static").build(input, sandbox), /Build failed/);
});

function tarEntry(name, content) {
  const header = Buffer.alloc(512);
  header.write(name, 0);
  header.write(content.length.toString(8).padStart(11, "0"), 124);
  const padded = Buffer.alloc(Math.ceil(content.length / 512) * 512);
  Buffer.from(content).copy(padded);
  return Buffer.concat([header, padded]);
}

test("archiveConfigDigest reads the config blob digest from manifest.json (OCI and legacy layouts)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sf-tar-"));
  const hex = "b".repeat(64);
  const write = async (file, entries) => {
    await fs.writeFile(path.join(dir, file), Buffer.concat([...entries, Buffer.alloc(1024)]));
    return archiveConfigDigest(path.join(dir, file));
  };

  const oci = JSON.stringify([{ Config: `blobs/sha256/${hex}`, Layers: [] }]);
  assert.equal(await write("oci.tar", [tarEntry("blobs/sha256/x", "x".repeat(700)), tarEntry("manifest.json", oci)]), `sha256:${hex}`);
  assert.equal(await write("legacy.tar", [tarEntry("manifest.json", JSON.stringify([{ Config: `${hex}.json` }]))]), `sha256:${hex}`);
  assert.equal(await write("none.tar", [tarEntry("other", "x")]), null);
  assert.equal(await write("bad.tar", [tarEntry("manifest.json", "not json")]), null);
  assert.equal(await archiveConfigDigest(path.join(dir, "missing.tar")).catch(() => "threw"), "threw");
});
