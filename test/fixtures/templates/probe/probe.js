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

// The container's own default gateway is the host side of its network.
function defaultGateway() {
  try {
    for (const line of fs.readFileSync("/proc/net/route", "utf8").split("\n").slice(1)) {
      const [, destination, gateway] = line.trim().split(/\s+/);
      if (destination === "00000000" && gateway) {
        return gateway.match(/../g).reverse().map((h) => parseInt(h, 16)).join(".");
      }
    }
  } catch {
    // Route lookup is best-effort; fall through to null.
  }
  return null;
}

const gateway = defaultGateway();
const HOST_PORTS = [22, 80, 443, 2375, 2376, 3128, 5432, 6379, 8000, 8080];
const reachableGateway = [];

for (const ip of [gateway, "172.17.0.1"].filter(Boolean)) {
  for (const port of HOST_PORTS) {
    if (await canConnect(ip, port)) {
      reachableGateway.push(`${ip}:${port}`);
    }
  }
}

// Ask the configured proxy (if any) to open a tunnel; returns the status line.
function proxyConnect(target) {
  const proxy = process.env.HTTPS_PROXY;
  if (!proxy) return Promise.resolve("no-proxy");
  const { hostname, port } = new URL(proxy);
  return new Promise((resolve) => {
    const socket = net.connect({ host: hostname, port: Number(port), timeout: 5000 });
    socket.on("connect", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    socket.once("data", (d) => { socket.destroy(); resolve(d.toString().split("\r\n")[0]); });
    socket.on("timeout", () => { socket.destroy(); resolve("timeout"); });
    socket.on("error", (e) => resolve(e.code));
  });
}

const proxyResults = {};
for (const target of [
  "registry.npmjs.org:443",
  "169.254.169.254:80",
  "api:8000",
  "postgres:5432",
  "example.com:443",
  "registry.npmjs.org:80",
]) {
  proxyResults[target] = await proxyConnect(target);
}

const result = {
  phase,
  uid: process.getuid(),
  leakedEnv: Object.keys(process.env).filter((key) => SENSITIVE_ENV.test(key)),
  readablePaths: SENSITIVE_PATHS.filter((p) => fs.existsSync(p)),
  reachableInternal,
  gateway,
  reachableGateway,
  metadataDirect: await canConnect("169.254.169.254", 80),
  internetDirect: await canConnect("registry.npmjs.org", 443) || await canConnect("1.1.1.1", 443),
  proxyResults,
};

fs.writeFileSync(`.probe-${phase}.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
