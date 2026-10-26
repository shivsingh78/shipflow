import { test } from "node:test";
import assert from "node:assert/strict";

import {
  InputError,
  parseBranch,
  parseCidr,
  parseDiskSize,
  parseInstanceType,
  parseName,
  parseOutput,
  parseRegion,
  parseRepoUrl,
} from "../../cli/dist/lib/cloud/inputs.js";
import { uniqueProjectName } from "../../cli/dist/lib/cloud/wizard.js";
import { estimateCost } from "../../cli/dist/lib/cloud/pricing.js";

const rejects = (fn, value, pattern) =>
  assert.throws(() => fn(value), (error) => error instanceof InputError && (!pattern || pattern.test(error.message)), String(value));

test("regions: standard AWS regions only", () => {
  assert.equal(parseRegion(" AP-South-1 "), "ap-south-1");
  assert.equal(parseRegion("us-east-1"), "us-east-1");
  for (const bad of ["", "mumbai", "us-gov-west-1", "cn-north-1", "ap-south", "ap-south-1; rm", "../x"]) rejects(parseRegion, bad);
});

test("project names", () => {
  assert.equal(parseName("My-Site"), "my-site");
  for (const bad of ["", "-x", "x-", "a b", "a_b", "a".repeat(41), "../x", "x;y"]) rejects(parseName, bad);
});

test("repository URLs: https, owner/repo, no credentials, allowlist", () => {
  assert.equal(parseRepoUrl(" https://github.com/octocat/hello-world/ "), "https://github.com/octocat/hello-world");
  assert.equal(parseRepoUrl("https://github.com/octocat/hello-world.git"), "https://github.com/octocat/hello-world.git");

  for (const bad of [
    "", "github.com/a/b", "http://github.com/a/b", "ssh://git@github.com/a/b", "git@github.com:a/b.git",
    "file:///etc/passwd", "https://user:token@github.com/a/b", "https://ghp_abc@github.com/a/b",
    "https://github.com/a", "https://github.com/a/b/c", "https://github.com/a/b?x=1", "https://github.com/a/b#frag",
    "https://localhost/a/b", "https://127.0.0.1/a/b", "https://github.com/a/..",
  ]) rejects(parseRepoUrl, bad);

  rejects((v) => parseRepoUrl(v, { allowedPrefixes: ["https://github.com/me/"] }), "https://github.com/other/repo", /only deploys repositories under/);
  assert.equal(parseRepoUrl("https://github.com/ME/repo", { allowedPrefixes: ["https://github.com/me/"] }), "https://github.com/ME/repo");
});

test("a token in the URL is refused with an explanation that never echoes it", () => {
  const token = "ghp_secrettoken1234567890";
  try {
    parseRepoUrl(`https://${token}@github.com/a/b`);
    assert.fail("expected an error");
  } catch (error) {
    assert.match(error.message, /must not contain credentials/);
    assert.doesNotMatch(error.message, new RegExp(token));
  }
});

test("branch, output, instance type and disk size", () => {
  assert.equal(parseBranch("feature/x-1"), "feature/x-1");
  for (const bad of ["", "-x", "a..b", "refs/pull/1/head", "a b", "x;y"]) rejects(parseBranch, bad);

  assert.equal(parseOutput(""), "auto");
  assert.equal(parseOutput("dist"), "dist");
  assert.equal(parseOutput("build/web"), "build/web");
  for (const bad of ["/etc", "../x", "a/../../b", "a b", "a;b"]) rejects(parseOutput, bad);

  assert.equal(parseInstanceType("T3.Micro"), "t3.micro");
  for (const bad of ["", "t3", "t3.", "micro", "t3.micro; x", "t3 micro"]) rejects(parseInstanceType, bad);

  assert.equal(parseDiskSize("8"), 8);
  assert.equal(parseDiskSize("100"), 100);
  for (const bad of ["", "7", "101", "8.5", "-8", "abc", "1e2"]) rejects(parseDiskSize, bad);
});

test("SSH CIDR: a bare IP is /32, host bits are normalized", () => {
  assert.deepEqual(parseCidr("198.51.100.7"), { cidr: "198.51.100.7/32", adjusted: false });
  assert.deepEqual(parseCidr("198.51.100.0/24"), { cidr: "198.51.100.0/24", adjusted: false });
  assert.deepEqual(parseCidr("198.51.100.77/24"), { cidr: "198.51.100.0/24", adjusted: true });
});

test("SSH CIDR: the whole internet, broad ranges and non-public ranges are refused", () => {
  rejects(parseCidr, "0.0.0.0/0", /whole internet/);
  for (const broad of ["0.0.0.0/1", "198.0.0.0/8", "198.51.0.0/15"]) rejects(parseCidr, broad, /too broad|private/);
  for (const nonPublic of [
    "10.0.0.5", "10.0.0.0/16", "172.16.4.4", "172.31.255.255", "192.168.1.1", "127.0.0.1",
    "169.254.169.254", "100.64.0.1", "224.0.0.1", "255.255.255.255", "0.1.2.3",
  ]) rejects(parseCidr, nonPublic, /private|reserved/);
  for (const bad of ["", "abc", "1.2.3", "1.2.3.4.5", "256.1.1.1", "1.2.3.4/33", "1.2.3.4/", "1.2.3.4/abc", "::1"]) {
    rejects(parseCidr, bad);
  }
  assert.equal(parseCidr(" 198.51.100.7 ").cidr, "198.51.100.7/32", "surrounding whitespace is trimmed");
  // An IP just outside a private block is fine.
  assert.equal(parseCidr("172.32.0.1").cidr, "172.32.0.1/32");
  assert.equal(parseCidr("11.0.0.1").cidr, "11.0.0.1/32");
});

test("project names get a suffix when taken", () => {
  let n = 0;
  const hex = () => String(++n).padStart(4, "0");
  assert.equal(uniqueProjectName("site", new Set(["other"]), hex), "site");
  assert.equal(uniqueProjectName("site", new Set(["site"]), hex), "site-0001");
  assert.equal(uniqueProjectName("site", new Set(["site", "site-0002"]), hex), "site-0003");
  assert.throws(() => uniqueProjectName("site", new Set(["site", "site-aaaa"]), () => "aaaa"), /free project name/);
  assert.ok(uniqueProjectName("a".repeat(40), new Set(["a".repeat(40)]), hex).length <= 63);
});

test("cost estimate: only prices that are known, with the unverified EBS rate labelled", () => {
  const known = estimateCost({ region: "ap-south-1", instanceType: "t3.micro", diskGiB: 8 });
  const byLabel = Object.fromEntries(known.lines.map((l) => [l.label, l]));

  assert.equal(known.complete, true);
  assert.equal(byLabel["EC2 t3.micro (Linux, on-demand)"].hourly, 0.0112);
  assert.equal(byLabel["Public IPv4 address (in use)"].hourly, 0.005);
  assert.match(byLabel["EBS gp3 8 GiB"].basis, /UNVERIFIED/);
  assert.ok(known.hourly > 0.0162 && known.hourly < 0.018);
  assert.ok(known.monthly > 11 && known.monthly < 14);
  assert.equal(known.verifiedAt, "2026-10-15");

  const unknownType = estimateCost({ region: "ap-south-1", instanceType: "c5.large", diskGiB: 8 });
  assert.equal(unknownType.complete, false);
  assert.match(unknownType.notes.join(" "), /No built-in price for c5.large/);

  const unknownRegion = estimateCost({ region: "eu-west-1", instanceType: "t3.micro", diskGiB: 8 });
  assert.equal(unknownRegion.hourly, null);
  assert.deepEqual(unknownRegion.lines, []);
  assert.match(unknownRegion.notes[0], /No built-in price table for eu-west-1/);
});
