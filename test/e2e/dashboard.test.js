// End-to-end: the real API serves the built dashboard under /ui with a strict
// CSP, while the API itself stays token-protected.
import { test } from "node:test";
import assert from "node:assert/strict";

const API = process.env.SHIPFLOW_API_URL;
const TOKEN = process.env.SHIPFLOW_API_TOKEN;

test("the dashboard shell is served publicly with a strict CSP", async () => {
  const response = await fetch(`${API}/ui/`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(html, /<title>ShipFlow<\/title>/);
  assert.match(response.headers.get("content-security-policy"), /default-src 'self'.*script-src 'self'/);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>[^<]/, "no inline script (it would be blocked by the CSP)");
});

test("built assets load, and client-side routes fall back to the shell", async () => {
  const html = await (await fetch(`${API}/ui/`)).text();
  const script = /<script[^>]+src="(\/ui\/assets\/[^"]+\.js)"/.exec(html)?.[1];
  assert.ok(script, "index.html references a built script");

  const asset = await fetch(`${API}${script}`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type"), /javascript/);
  assert.match(asset.headers.get("cache-control"), /immutable/);

  const route = await fetch(`${API}/ui/applications/anything`);
  assert.equal(route.status, 200);
  assert.match(await route.text(), /<title>ShipFlow<\/title>/);
  assert.equal((await fetch(`${API}/ui/assets/missing.js`)).status, 404);
});

test("the self-hosted fonts are served from the same origin (the CSP forbids font CDNs)", async () => {
  for (const font of ["inter-latin.woff2", "ibm-plex-mono-latin-400.woff2", "ibm-plex-mono-latin-500.woff2", "ibm-plex-mono-latin-600.woff2"]) {
    const response = await fetch(`${API}/ui/fonts/${font}`);

    assert.equal(response.status, 200, font);
    assert.match(response.headers.get("content-type"), /font\/woff2|application\/font-woff2|octet-stream/);
    assert.ok((await response.arrayBuffer()).byteLength > 10_000, `${font} is a real font file`);
  }

  // The pre-paint theme script must be a same-origin file: the CSP forbids inline scripts.
  const theme = await fetch(`${API}/ui/theme-init.js`);

  assert.equal(theme.status, 200);
  assert.match(theme.headers.get("content-type"), /javascript/);

  const csp = (await fetch(`${API}/ui/`)).headers.get("content-security-policy");
  assert.match(csp, /font-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-|\*|https?:/, "the policy was not loosened to load fonts");
});

test("the API behind the dashboard still requires the token", async () => {
  assert.equal((await fetch(`${API}/projects`)).status, 401);
  assert.equal((await fetch(`${API}/releases`, { headers: { Authorization: "Bearer wrong" } })).status, 401);

  const ok = await fetch(`${API}/whoami`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(ok.status, 200);
});
