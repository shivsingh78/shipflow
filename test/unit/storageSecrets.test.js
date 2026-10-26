import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import crypto from "crypto";

import { createLocalStore, assertSafeKey, downloadArtifact } from "../../dist/src/artifactStore.js";
import {
  encryptSecret,
  decryptSecret,
  parseSecretsKey,
  createSecretStore,
} from "../../dist/src/secrets.js";

async function readBody(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

test("local artifact store: put, list, get, remove", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sf-store-"));
  const src = path.join(root, "..", `sf-src-${Date.now()}.html`);
  await fs.writeFile(src, "<h1>hi</h1>");
  const store = createLocalStore(path.join(root, "artifacts"));

  await store.put("releases/Abcdefgh/build/index.html", src);
  await store.put("releases/Abcdefgh/build/assets/app.js", src);

  const listed = await store.list("releases/Abcdefgh/build/");
  assert.deepEqual(listed.map((o) => o.key).sort(), [
    "releases/Abcdefgh/build/assets/app.js",
    "releases/Abcdefgh/build/index.html",
  ]);

  const object = await store.get("releases/Abcdefgh/build/index.html");
  assert.match(object.ContentType, /text\/html/);
  assert.equal(await readBody(object.Body), "<h1>hi</h1>");

  await assert.rejects(store.get("releases/Abcdefgh/build/missing.js"), (e) => store.isNotFound(e));
  assert.deepEqual(await store.list("releases/none/"), []);

  const out = path.join(root, "download");
  assert.equal(await downloadArtifact(store, "releases/Abcdefgh/build", out), 2);
  assert.equal(await fs.readFile(path.join(out, "assets/app.js"), "utf8"), "<h1>hi</h1>");

  await store.remove(listed.map((o) => o.key));
  assert.deepEqual(await store.list("releases/Abcdefgh/"), []);
});

test("artifact keys cannot escape the store", () => {
  for (const key of ["../x", "a/../../x", "/etc/passwd", "a//b", "a/./b", "a b", ""]) {
    assert.throws(() => assertSafeKey(key), /Invalid artifact key/, key);
  }
  assert.equal(assertSafeKey("releases/Ab12CdEf/build/index.html"), "releases/Ab12CdEf/build/index.html");
});

test("secret encryption round-trips and is bound to project/name", () => {
  const key = crypto.randomBytes(32);
  const stored = encryptSecret(key, "site/SSH_KEY", "super secret");

  assert.doesNotMatch(stored, /super secret/);
  assert.equal(decryptSecret(key, "site/SSH_KEY", stored), "super secret");
  assert.throws(() => decryptSecret(key, "other/SSH_KEY", stored), "AAD must match");
  assert.throws(() => decryptSecret(crypto.randomBytes(32), "site/SSH_KEY", stored), "wrong key");

  const parts = stored.split(":");
  parts[3] = Buffer.from("tampered").toString("base64");
  assert.throws(() => decryptSecret(key, "site/SSH_KEY", parts.join(":")), "tampering detected");
});

test("secrets key must be 32 bytes", () => {
  assert.equal(parseSecretsKey(""), null);
  assert.equal(parseSecretsKey("a".repeat(64)).length, 32);
  assert.throws(() => parseSecretsKey("abc"), /32 bytes/);
});

test("secret store validates names, refuses when disabled, and reports missing secrets by name", async () => {
  const rows = new Map();
  const db = {
    async query(sql, params) {
      if (sql.includes("INSERT")) rows.set(`${params[0]}/${params[1]}`, params[2]);
      if (sql.includes("ANY")) {
        return {
          rows: params[1]
            .filter((name) => rows.has(`${params[0]}/${name}`))
            .map((name) => ({ name, ciphertext: rows.get(`${params[0]}/${name}`) })),
        };
      }
      return { rows: [], rowCount: 1 };
    },
  };

  const disabled = createSecretStore({ key: null, db });
  await assert.rejects(disabled.set("site", "KEY", "v"), /disabled/);

  const store = createSecretStore({ key: crypto.randomBytes(32), db });
  await assert.rejects(store.set("site", "lower-case", "v"), /UPPER_CASE/);
  await assert.rejects(store.set("site", "EMPTY", ""), /non-empty/);

  await store.set("site", "SSH_KEY", "value-123");
  assert.doesNotMatch([...rows.values()][0], /value-123/, "stored encrypted");
  assert.deepEqual(await store.resolve("site", ["SSH_KEY"]), { SSH_KEY: "value-123" });

  await assert.rejects(store.resolve("site", ["SSH_KEY", "OTHER"]), (error) => {
    assert.match(error.message, /OTHER/);
    assert.doesNotMatch(error.message, /value-123/);
    return true;
  });
});
