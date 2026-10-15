// Records what repository-controlled code can see from inside a build.
// Usage: node probe.js <phase>
import fs from "fs";
import net from "net";

const phase = process.argv[2];

const SENSITIVE_ENV = /^(AWS_|DB_|REDIS_|SHIPFLOW_|S3_|PG|POSTGRES|INTERNAL_|PUBLIC_SITE|DOCKER_)/;

const SENSITIVE_PATHS = [
  "/app/.env",
  "/app/index.js",
  "/var/run/docker.sock",
  "/workspaces",
];

// Internal ShipFlow services (compose network names) and the public internet.
const INTERNAL_HOSTS = [
  ["postgres", 5432],
  ["redis", 6379],
  ["api", 8000],
  ["api", 8080],
  ["s3", 9090],
  ["fixtures", 9000],
  ["host.docker.internal", 8000],
];

function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 2000 });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.on("connect", () => done(true));
    socket.on("timeout", () => done(false));
    socket.on("error", () => done(false));
  });
}

const reachableInternal = [];

for (const [host, port] of INTERNAL_HOSTS) {
  if (await canConnect(host, port)) {
    reachableInternal.push(`${host}:${port}`);
  }
}

const result = {
  phase,
  uid: process.getuid(),
  leakedEnv: Object.keys(process.env).filter((key) => SENSITIVE_ENV.test(key)),
  readablePaths: SENSITIVE_PATHS.filter((p) => fs.existsSync(p)),
  reachableInternal,
  internet: await canConnect("registry.npmjs.org", 443),
};

fs.writeFileSync(`.probe-${phase}.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
