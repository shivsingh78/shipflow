// An in-memory GitHub REST API for tests: a `fetch` replacement that serves
// repos, commits, trees and blobs (with correct git object ids), records
// every request, and can inject failures. No network is ever used.
import crypto from "node:crypto";

import { gitBlobSha } from "../../dist/src/repopilot/github.js";

const sha1 = (text) => crypto.createHash("sha1").update(text).digest("hex");

export function createFakeGithub(spec) {
  const requests = [];
  const fail = new Map(); // path substring -> { status, headers?, body? }
  const commits = new Map();
  const blobs = new Map();
  // Write-side state: branches, created objects, pull requests, and a log of every write.
  const refs = new Map(Object.entries(spec.branches ?? {}));
  const trees = new Map();
  const madeCommits = new Map();
  const pulls = [];
  const writes = [];

  const addCommit = (sha, files) => {
    const entries = [];

    for (const [path, value] of Object.entries(files)) {
      const spec = typeof value === "string" || Buffer.isBuffer(value) ? { content: value } : value;
      const content = Buffer.isBuffer(spec.content) ? spec.content : Buffer.from(spec.content ?? "", "utf-8");
      const blob = gitBlobSha(content);

      blobs.set(blob, content);
      entries.push({ path, mode: spec.mode ?? "100644", type: spec.type ?? "blob", sha: spec.type === "commit" ? "c".repeat(40) : blob, size: content.length });
    }

    commits.set(sha, entries);
  };

  for (const [sha, files] of Object.entries(spec.commits)) addCommit(sha, files);

  const reply = (status, json, headers = {}) => {
    const body = typeof json === "string" ? json : JSON.stringify(json);

    return { status, headers: { get: (name) => headers[name.toLowerCase()] ?? null }, body: new Response(body).body };
  };

  const fetch = async (url, init) => {
    const parsed = new URL(url);
    requests.push({ url, method: init.method, host: parsed.host, headers: { ...init.headers }, redirect: init.redirect });

    for (const [needle, response] of fail) {
      if (url.includes(needle)) {
        if (response.throw) throw new Error(response.throw);
        return reply(response.status, response.body ?? { message: "injected failure" }, response.headers);
      }
    }

    const path = parsed.pathname;
    const base = `/repos/${spec.owner}/${spec.name}`;

    if (path === base) {
      return reply(200, { full_name: `${spec.owner}/${spec.name}`, default_branch: spec.defaultBranch ?? "main", private: spec.private ?? false, archived: false, fork: false, size: 100, permissions: { pull: true } });
    }

    const commitMatch = path.match(new RegExp(`^${base}/commits/(.+)$`));

    if (commitMatch) {
      const ref = decodeURIComponent(commitMatch[1]);
      const sha = commits.has(ref) ? ref : spec.branches?.[ref];

      return sha ? reply(200, { sha }) : reply(404, { message: "Not Found" });
    }

    const treeMatch = path.match(new RegExp(`^${base}/git/trees/([0-9a-f]{40})$`));

    if (treeMatch) {
      const entries = commits.get(treeMatch[1]);
      return entries ? reply(200, { sha: treeMatch[1], truncated: spec.truncated ?? false, tree: entries }) : reply(404, { message: "Not Found" });
    }

    const blobMatch = path.match(new RegExp(`^${base}/git/blobs/([0-9a-f]{40})$`));

    if (blobMatch) {
      const content = spec.corruptBlobs?.has(blobMatch[1]) ? Buffer.from("tampered") : blobs.get(blobMatch[1]);
      return content ? reply(200, { sha: blobMatch[1], encoding: "base64", size: content.length, content: content.toString("base64") }) : reply(404, { message: "Not Found" });
    }

    // ------------------------------------------------------------ write side
    const body = init.body ? JSON.parse(init.body) : undefined;

    if (init.method !== "GET") writes.push({ method: init.method, path, body });

    const refMatch = path.match(new RegExp(`^${base}/git/ref/heads/(.+)$`));

    if (refMatch) {
      const branch = decodeURIComponent(refMatch[1]);
      return refs.has(branch) ? reply(200, { ref: `refs/heads/${branch}`, object: { sha: refs.get(branch) } }) : reply(404, { message: "Not Found" });
    }

    const gitCommit = path.match(new RegExp(`^${base}/git/commits/([0-9a-f]{40})$`));

    if (gitCommit && init.method === "GET") {
      const known = commits.has(gitCommit[1]) || madeCommits.has(gitCommit[1]);
      return known ? reply(200, { sha: gitCommit[1], tree: { sha: madeCommits.get(gitCommit[1])?.tree ?? sha1(`tree:${gitCommit[1]}`) } }) : reply(404, { message: "Not Found" });
    }

    if (path === `${base}/git/blobs` && init.method === "POST") {
      const content = Buffer.from(body.content, "utf-8");
      blobs.set(gitBlobSha(content), content);
      return reply(201, { sha: gitBlobSha(content) });
    }

    if (path === `${base}/git/trees` && init.method === "POST") {
      const sha = sha1(JSON.stringify(body));
      trees.set(sha, body);
      return reply(201, { sha });
    }

    if (path === `${base}/git/commits` && init.method === "POST") {
      const sha = sha1(JSON.stringify(body));
      madeCommits.set(sha, body);
      return reply(201, { sha });
    }

    if (path === `${base}/git/refs` && init.method === "POST") {
      const branch = body.ref.replace(/^refs\/heads\//, "");
      if (refs.has(branch)) return reply(422, { message: "Reference already exists" });
      refs.set(branch, body.sha);
      return reply(201, { ref: body.ref, object: { sha: body.sha } });
    }

    const cmp = path.match(new RegExp(`^${base}/compare/([0-9a-f]{40})\\.\\.\\.(.+)$`));

    if (cmp) {
      const [, baseSha, headRef] = cmp;
      const head = decodeURIComponent(headRef);
      const headSha = refs.get(head) ?? head;
      const made = madeCommits.get(headSha);

      if (made && made.parents[0] === baseSha) {
        return reply(200, { ahead_by: 1, behind_by: 0, files: [...trees.get(made.tree).tree].map((e) => ({ filename: e.path })) });
      }

      const moved = spec.moved && spec.moved.sha === headSha ? spec.moved : null;
      return reply(200, { ahead_by: moved ? moved.aheadBy ?? 1 : 0, behind_by: 0, files: (moved?.files ?? []).map((filename) => ({ filename })) });
    }

    if (path === `${base}/pulls` && init.method === "GET") {
      const head = parsed.searchParams.get("head") ?? "";
      return reply(200, pulls.filter((p) => `${spec.owner}:${p.head.ref}` === head).map(({ number, html_url, state, head: h }) => ({ number, html_url, state, head: { sha: h.sha } })));
    }

    if (path === `${base}/pulls` && init.method === "POST") {
      const sha = refs.get(body.head) ?? "0".repeat(40);
      const pull = { number: pulls.length + 1, html_url: `https://github.com/${spec.owner}/${spec.name}/pull/${pulls.length + 1}`, state: "open", draft: body.draft, head: { ref: body.head, sha }, body };
      pulls.push(pull);
      return reply(201, { number: pull.number, html_url: pull.html_url, state: "open", head: { sha } });
    }

    return reply(404, { message: "Not Found" });
  };

  return { fetch, requests, fail, blobs, refs, pulls, writes, madeCommits, trees };
}
