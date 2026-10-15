// Serves the test fixtures as git repositories over HTTP so the worker can
// clone them exactly like a real remote:
//   http://fixtures:9000/shipflow/<fixture>.git
import fsp from "fs/promises";
import http from "http";
import os from "os";
import path from "path";
import { execFileSync, spawn } from "child_process";

import { FIXTURES, materializeFixture } from "../fixtures/repos.js";

const PORT = Number(process.env.FIXTURE_PORT || 9000);
const root = await fsp.mkdtemp(path.join(os.tmpdir(), "shipflow-fixtures-"));
const gitRoot = path.join(root, "git");

const git = (args, cwd) =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "inherit"] });

for (const name of Object.keys(FIXTURES)) {
  const source = path.join(root, "src", name);
  const bare = path.join(gitRoot, "shipflow", `${name}.git`);

  await materializeFixture(name, source);

  git(["init", "-q", "-b", "main"], source);
  git(["add", "-A"], source);
  git(
    [
      "-c", "user.name=ShipFlow Fixtures",
      "-c", "user.email=fixtures@shipflow.invalid",
      "commit", "-q", "-m", `fixture ${name}`,
    ],
    source
  );
  git(["clone", "-q", "--bare", source, bare], root);
}

// Smart HTTP via `git http-backend` (CGI), so shallow clones work like on GitHub.
function gitHttpBackend(req, res, url) {
  const backend = spawn("git", ["http-backend"], {
    env: {
      PATH: process.env.PATH,
      GIT_PROJECT_ROOT: gitRoot,
      GIT_HTTP_EXPORT_ALL: "1",
      REQUEST_METHOD: req.method,
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: req.headers["content-type"] || "",
      HTTP_CONTENT_ENCODING: req.headers["content-encoding"] || "",
      GIT_PROTOCOL: req.headers["git-protocol"] || "",
      REMOTE_ADDR: req.socket.remoteAddress || "",
    },
  });

  req.pipe(backend.stdin);
  backend.stderr.pipe(process.stderr);

  let buffer = Buffer.alloc(0);
  let headersSent = false;

  backend.stdout.on("data", (chunk) => {
    if (headersSent) {
      res.write(chunk);
      return;
    }

    buffer = Buffer.concat([buffer, chunk]);
    const end = buffer.indexOf("\r\n\r\n");

    if (end === -1) {
      return;
    }

    let status = 200;
    const headers = {};

    for (const line of buffer.subarray(0, end).toString().split("\r\n")) {
      const [name, ...rest] = line.split(":");
      const value = rest.join(":").trim();

      if (name.toLowerCase() === "status") {
        status = Number(value.split(" ")[0]);
      } else {
        headers[name] = value;
      }
    }

    res.writeHead(status, headers);
    res.write(buffer.subarray(end + 4));
    headersSent = true;
  });

  backend.on("close", (code) => {
    if (!headersSent) {
      res.writeHead(500);
      console.error(`git http-backend exited with ${code} before sending headers`);
    }

    res.end();
  });
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://fixtures");

    if (url.pathname === "/health") {
      res.end("ok");
      return;
    }

    gitHttpBackend(req, res, url);
  })
  .listen(PORT, () => {
    console.log(
      `Fixture git server on :${PORT} serving ${Object.keys(FIXTURES).join(", ")}`
    );
  });
