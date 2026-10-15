import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "stream";
import http from "http";

import { createApiApp, createSiteApp } from "../../src/app.js";

const TOKEN = "unit-test-token-0123456789abcdef";
const auth = { Authorization: `Bearer ${TOKEN}` };

function fakeDeps() {
  const store = new Map();
  const objects = new Map();
  const state = { active: null, queued: [], jobCounts: { waiting: 0 } };

  store.set("Queued01", {
    release_id: "Queued01",
    status: "QUEUED",
    current_stage: "RELEASE",
  });
  store.set("Good0001", {
    release_id: "Good0001",
    status: "SUCCESS",
    current_stage: "ACTIVATE",
    artifact_path: "releases/Good0001/build",
  });

  objects.set("releases/Good0001/build/index.html", {
    body: "<h1>good</h1>",
    type: "text/html; charset=utf-8",
  });
  objects.set("releases/Good0001/build/assets/app.js", {
    body: "console.log(1)",
    type: "application/javascript; charset=utf-8",
  });

  const notFound = Object.assign(new Error("missing"), { name: "NoSuchKey" });

  return {
    state,
    deps: {
      config: {
        apiToken: TOKEN,
        allowedRepoPrefixes: ["https://github.com/shiv/"],
        maxQueuedReleases: 2,
      },
      releases: {
        createRelease: async (r) => {
          const row = {
            release_id: r.releaseId,
            repo_url: r.repoUrl,
            status: r.status,
            current_stage: r.currentStage,
          };
          store.set(r.releaseId, row);
          return row;
        },
        getRelease: async (id) => store.get(id),
        getAllReleases: async () => [...store.values()],
        updateRelease: async () => {},
      },
      logs: { getReleaseLogs: async () => [] },
      notifications: { getReleaseNotifications: async () => [] },
      queue: {
        add: async (name, data) => state.queued.push(data),
        getJobCounts: async () => state.jobCounts,
      },
      activation: { getActiveReleaseId: async () => state.active },
      rollback: {
        rollbackRelease: async (id) => {
          const error = new Error(`Release ${id} not found`);
          error.statusCode = 404;
          throw error;
        },
      },
      storage: {
        getObject: async (key) => {
          const object = objects.get(key);
          if (!object) throw notFound;
          return {
            Body: Readable.from([Buffer.from(object.body)]),
            ContentType: object.type,
            ContentLength: Buffer.byteLength(object.body),
          };
        },
        isNotFoundError: (error) => error === notFound,
      },
      healthCheck: async () => {},
      generateId: () => "NewRel01",
    },
  };
}

let api;
let site;
let apiUrl;
let siteUrl;
let state;

before(async () => {
  const fake = fakeDeps();
  state = fake.state;

  api = createApiApp(fake.deps).listen(0);
  site = createSiteApp(fake.deps).listen(0);

  apiUrl = `http://127.0.0.1:${api.address().port}`;
  siteUrl = `http://127.0.0.1:${site.address().port}`;
});

after(() => {
  api.close();
  site.close();
});

test("health is public", async () => {
  const response = await fetch(`${apiUrl}/health`);
  assert.equal(response.status, 200);
});

test("API rejects missing or wrong tokens", async () => {
  assert.equal((await fetch(`${apiUrl}/releases`)).status, 401);
  assert.equal(
    (await fetch(`${apiUrl}/releases`, { headers: { Authorization: "Bearer nope" } })).status,
    401
  );
  assert.equal(
    (await fetch(`${apiUrl}/deploy`, { method: "POST" })).status,
    401
  );
});

test("invalid release IDs are rejected before any lookup", async () => {
  const response = await fetch(`${apiUrl}/releases/..%2F..%2Fetc`, { headers: auth });
  assert.equal(response.status, 400);
});

test("unknown release returns 404 for status and logs", async () => {
  assert.equal((await fetch(`${apiUrl}/releases/Missing1`, { headers: auth })).status, 404);

  const logs = await fetch(`${apiUrl}/releases/Missing1/logs`, { headers: auth });
  assert.equal(logs.status, 404);
  assert.match((await logs.json()).message, /not found/);
});

test("queued release with no logs is not a 404", async () => {
  const response = await fetch(`${apiUrl}/releases/Queued01/logs`, { headers: auth });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.logs, []);
  assert.equal(body.release.status, "QUEUED");
});

test("deploy validates the repository URL", async () => {
  const response = await fetch(`${apiUrl}/deploy`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ repoUrl: "https://github.com/someone-else/x" }),
  });

  assert.equal(response.status, 400);
  assert.match((await response.json()).message, /not in the list/);
});

test("deploy rejects malformed JSON", async () => {
  const response = await fetch(`${apiUrl}/deploy`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: "{bad",
  });

  assert.equal(response.status, 400);
});

test("deploy queues a valid release", async () => {
  const response = await fetch(`${apiUrl}/deploy`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ repoUrl: "https://github.com/shiv/site" }),
  });

  assert.equal(response.status, 202);
  assert.equal((await response.json()).release.release_id, "NewRel01");
  // The job carries only the ID; the worker reads everything else from
  // the release row.
  assert.deepEqual(state.queued.at(-1), { releaseId: "NewRel01" });
  assert.equal((await (await fetch(`${apiUrl}/releases/NewRel01`, { headers: auth })).json()).release.repo_url, "https://github.com/shiv/site");
});

test("deploy refuses when the queue is full", async () => {
  state.jobCounts = { waiting: 1, active: 1 };

  const response = await fetch(`${apiUrl}/deploy`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ repoUrl: "https://github.com/shiv/site" }),
  });

  state.jobCounts = { waiting: 0 };
  assert.equal(response.status, 429);
});

test("rollback errors keep their status code", async () => {
  const response = await fetch(`${apiUrl}/rollback/Missing1`, {
    method: "POST",
    headers: auth,
  });

  assert.equal(response.status, 404);
});

test("preview serves uploaded artifacts with release header", async () => {
  const response = await fetch(`${apiUrl}/preview/Good0001/`, { headers: auth });

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.equal(response.headers.get("x-shipflow-release"), "Good0001");
  assert.equal(await response.text(), "<h1>good</h1>");
});

test("preview requires auth and an uploaded artifact", async () => {
  assert.equal((await fetch(`${apiUrl}/preview/Good0001/`)).status, 401);
  assert.equal(
    (await fetch(`${apiUrl}/preview/Queued01/`, { headers: auth })).status,
    404
  );
});

test("site returns 404 when nothing is active", async () => {
  state.active = null;
  const response = await fetch(`${siteUrl}/`);
  assert.equal(response.status, 404);
});

test("site serves the active release at the root path", async () => {
  state.active = "Good0001";

  const index = await fetch(`${siteUrl}/`);
  assert.equal(index.status, 200);
  assert.equal(index.headers.get("x-shipflow-release"), "Good0001");

  const asset = await fetch(`${siteUrl}/assets/app.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type"), /javascript/);

  // SPA route falls back to index.html; missing assets do not.
  assert.equal((await fetch(`${siteUrl}/some/route`)).status, 200);
  assert.equal((await fetch(`${siteUrl}/assets/missing.js`)).status, 404);
});

// URL parsers normalize "%2e%2e" client-side, so send the raw path.
function rawGet(base, rawPath) {
  const { hostname, port } = new URL(base);

  return new Promise((resolve, reject) => {
    http
      .get({ hostname, port, path: rawPath }, (res) => {
        res.resume();
        resolve(res.statusCode);
      })
      .on("error", reject);
  });
}

test("site blocks path traversal and non-GET methods", async () => {
  state.active = "Good0001";

  assert.equal(await rawGet(siteUrl, "/%2e%2e/%2e%2e/secret"), 400);
  assert.equal(await rawGet(siteUrl, "/assets/..%2f..%2fsecret"), 400);
  assert.equal((await fetch(`${siteUrl}/`, { method: "POST" })).status, 405);
});
