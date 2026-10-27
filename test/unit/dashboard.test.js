// The dashboard is public static content served under /ui with a strict CSP;
// the API behind it stays token-protected.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import express from "express";

import { mountDashboard, resolveDashboardDir, DASHBOARD_CSP } from "../../dist/src/dashboard.js";

let dir;
let server;
let base;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "sf-dash-"));
  await fs.mkdir(path.join(dir, "assets"));
  await fs.writeFile(path.join(dir, "index.html"), "<!doctype html><title>ShipFlow</title>");
  await fs.writeFile(path.join(dir, "assets", "app-abc123.js"), "console.log(1)");
  await fs.writeFile(path.join(dir, "favicon.svg"), "<svg/>");
  await fs.writeFile(path.join(dir, ".secret"), "do not serve");
  await fs.writeFile(path.join(path.dirname(dir), "sf-dash-outside.txt"), "outside");

  const app = express();
  app.get("/health", (_req, res) => res.json({ ok: true }));
  mountDashboard(app, dir);
  app.use((_req, res) => res.status(401).json({ success: false, message: "Unauthorized" })); // stands in for the token middleware
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(path.join(path.dirname(dir), "sf-dash-outside.txt"), { force: true });
});

const get = (url, init) => fetch(`${base}${url}`, { redirect: "manual", ...init });

test("the app shell is public, with a strict CSP and no-store caching", async () => {
  const response = await get("/ui/");

  assert.equal(response.status, 200);
  assert.match(await response.text(), /ShipFlow/);
  assert.equal(response.headers.get("content-security-policy"), DASHBOARD_CSP);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
});

test("the CSP only allows this origin and no inline script", () => {
  assert.match(DASHBOARD_CSP, /default-src 'self'/);
  assert.match(DASHBOARD_CSP, /script-src 'self'(;|$)/);
  assert.match(DASHBOARD_CSP, /connect-src 'self'/);
  assert.match(DASHBOARD_CSP, /frame-ancestors 'none'/);
  assert.doesNotMatch(DASHBOARD_CSP, /unsafe-inline|unsafe-eval|\*/);
});

test("client-side routes fall back to the shell; missing files are real 404s", async () => {
  for (const route of ["/ui/applications", "/ui/applications/orders-api/deployments", "/ui/releases/Abcd1234"]) {
    const response = await get(route);
    assert.equal(response.status, 200, route);
    assert.match(await response.text(), /ShipFlow/);
  }

  assert.equal((await get("/ui/assets/missing.js")).status, 404);
  assert.equal((await get("/ui/assets/missing.js")).headers.get("content-type").startsWith("text/plain"), true, "a plain 404, not an error page or the shell");
  assert.equal((await get("/ui/missing.png")).status, 404);
});

test("hashed assets are cached for a year; other files briefly", async () => {
  const asset = await get("/ui/assets/app-abc123.js");

  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("cache-control"), /max-age=31536000.*immutable/);
  assert.match((await get("/ui/favicon.svg")).headers.get("cache-control"), /max-age=600/);
});

test("dotfiles and paths outside the directory are never served", async () => {
  assert.doesNotMatch(await (await get("/ui/.secret")).text(), /do not serve/);

  for (const attack of ["/ui/..%2fsf-dash-outside.txt", "/ui/%2e%2e/sf-dash-outside.txt", "/ui/assets/..%2f..%2fsf-dash-outside.txt"]) {
    const response = await get(attack);
    assert.notEqual(await response.text(), "outside", attack);
  }
});

test("/ui redirects to /ui/ and browsers opening / are sent to the dashboard, API clients are not", async () => {
  assert.equal((await get("/ui")).status, 301);
  assert.equal((await get("/ui")).headers.get("location"), "/ui/");

  const browser = await get("/", { headers: { Accept: "text/html,application/xhtml+xml" } });
  assert.equal(browser.status, 302);
  assert.equal(browser.headers.get("location"), "/ui/");

  const api = await get("/", { headers: { Accept: "application/json" } });
  assert.equal(api.status, 401, "JSON clients still reach the (token-protected) API");
});

test("the API stays outside the dashboard and protected", async () => {
  assert.equal((await get("/projects")).status, 401);
  assert.equal((await get("/health")).status, 200);
});

test("the dashboard directory resolves only when built and enabled", async () => {
  assert.equal(resolveDashboardDir(dir, false), path.resolve(dir));
  assert.equal(resolveDashboardDir(dir, true), null, "SHIPFLOW_UI=off disables it");
  assert.equal(resolveDashboardDir(path.join(dir, "nope"), false), null);
  assert.equal(resolveDashboardDir(path.join(dir, "assets"), false), null, "no index.html: not a dashboard");
});
