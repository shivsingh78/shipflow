import { test } from "node:test";
import assert from "node:assert/strict";
import net from "net";

import {
  isBlockedAddress,
  isAllowedHost,
  vetDestination,
  createEgressProxy,
} from "../../dist/src/egressProxy.js";

const allowlist = ["registry.npmjs.org", ".yarnpkg.com"];
const publicLookup = async () => [{ address: "104.16.1.34", family: 4 }];

test("blocks private, loopback, link-local and metadata addresses", () => {
  for (const address of [
    "10.0.0.1", "127.0.0.1", "169.254.169.254", "172.17.0.1", "172.31.255.255",
    "192.168.1.10", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fd00::1",
    "fe80::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "not-an-ip",
  ]) {
    assert.equal(isBlockedAddress(address), true, address);
  }

  for (const address of ["104.16.1.34", "8.8.8.8", "172.32.0.1", "2606:4700::1111"]) {
    assert.equal(isBlockedAddress(address), false, address);
  }
});

test("allowlist matches exact names and leading-dot suffixes only", () => {
  assert.equal(isAllowedHost("registry.npmjs.org", allowlist), true);
  assert.equal(isAllowedHost("REGISTRY.NPMJS.ORG.", allowlist), true);
  assert.equal(isAllowedHost("repo.yarnpkg.com", allowlist), true);
  assert.equal(isAllowedHost("yarnpkg.com", allowlist), false);
  assert.equal(isAllowedHost("evil-registry.npmjs.org", allowlist), false);
  assert.equal(isAllowedHost("registry.npmjs.org.evil.com", allowlist), false);
});

test("vetDestination enforces port, allowlist, IP literals and DNS results", async () => {
  assert.equal((await vetDestination("registry.npmjs.org:443", { allowlist, lookup: publicLookup })).allowed, true);
  assert.match((await vetDestination("registry.npmjs.org:80", { allowlist, lookup: publicLookup })).reason, /port 80/);
  assert.match((await vetDestination("example.com:443", { allowlist, lookup: publicLookup })).reason, /not in allowlist/);
  assert.match((await vetDestination("169.254.169.254:443", { allowlist, lookup: publicLookup })).reason, /not in allowlist/);
  assert.match((await vetDestination("garbage", { allowlist, lookup: publicLookup })).reason, /malformed/);

  // DNS rebinding: an allowlisted name that resolves to an internal address.
  const rebinding = async () => [{ address: "104.16.1.34" }, { address: "10.0.0.5" }];
  assert.match((await vetDestination("registry.npmjs.org:443", { allowlist, lookup: rebinding })).reason, /non-public/);
});

function connectThrough(port, target) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () =>
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`)
    );
    socket.once("data", (data) => {
      socket.destroy();
      resolve(data.toString().split("\r\n")[0]);
    });
    socket.on("error", reject);
  });
}

test("the running proxy refuses disallowed tunnels and plain HTTP", async () => {
  const internalLookup = async () => [{ address: "127.0.0.1", family: 4 }];
  const server = createEgressProxy({ allowlist, lookup: internalLookup, log: () => {} });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    assert.match(await connectThrough(port, "registry.npmjs.org:443"), / 403 /, "allowlisted name resolving to loopback");
    assert.match(await connectThrough(port, "example.com:443"), / 403 /);
    assert.match(await connectThrough(port, "127.0.0.1:443"), / 403 /);

    const plain = await fetch(`http://127.0.0.1:${port}/http://example.com/`);
    assert.equal(plain.status, 403);
  } finally {
    server.close();
  }
});
