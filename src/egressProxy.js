// Egress proxy for build sandboxes.
//
// Sandboxes sit on an internal-only Docker network. During dependency
// install their only route out is this HTTP CONNECT proxy, which allows TLS
// connections to an allowlist of hostnames (package registries by default)
// and refuses any destination that resolves to a private, loopback,
// link-local (cloud metadata) or otherwise non-public address.
//
// Run: node src/egressProxy.js   (port SHIPFLOW_EGRESS_PORT, default 3128)
import http from "http";
import net from "net";
import dns from "dns/promises";
import { fileURLToPath } from "url";

export const DEFAULT_ALLOWLIST = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "repo.yarnpkg.com",
];

/**
 * True for addresses a sandbox must never reach: RFC 1918, loopback,
 * link-local (169.254.0.0/16 includes cloud metadata), CGNAT, multicast,
 * reserved, and their IPv6 equivalents.
 */
export function isBlockedAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);

    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }

  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);

    if (mapped) {
      return isBlockedAddress(mapped[1]);
    }

    return (
      lower === "::" ||
      lower === "::1" ||
      lower.startsWith("fe8") ||
      lower.startsWith("fe9") ||
      lower.startsWith("fea") ||
      lower.startsWith("feb") ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("ff")
    );
  }

  return true;
}

export function isAllowedHost(host, allowlist) {
  const name = host.toLowerCase().replace(/\.$/, "");

  return allowlist.some((entry) => {
    const allowed = entry.toLowerCase();

    return allowed.startsWith(".")
      ? name.endsWith(allowed) && name.length > allowed.length
      : name === allowed;
  });
}

/**
 * Decide whether host:port may be reached. Returns the vetted IP so the
 * proxy connects to exactly the address it checked (no DNS rebinding).
 */
export async function vetDestination(
  target,
  { allowlist, allowedPorts = [443], lookup = dns.lookup }
) {
  const match = /^([A-Za-z0-9.-]+):(\d{1,5})$/.exec(target || "");

  if (!match) {
    return { allowed: false, reason: "malformed destination" };
  }

  const [, host, portText] = match;
  const port = Number(portText);

  if (!allowedPorts.includes(port)) {
    return { allowed: false, reason: `port ${port} not allowed` };
  }

  if (net.isIP(host) || !isAllowedHost(host, allowlist)) {
    return { allowed: false, reason: `host ${host} not in allowlist` };
  }

  let addresses;

  try {
    addresses = await lookup(host, { all: true });
  } catch {
    return { allowed: false, reason: `cannot resolve ${host}` };
  }

  if (addresses.length === 0 || addresses.some((a) => isBlockedAddress(a.address))) {
    return { allowed: false, reason: `${host} resolves to a non-public address` };
  }

  return { allowed: true, host, port, address: addresses[0].address };
}

export function createEgressProxy({
  allowlist = DEFAULT_ALLOWLIST,
  allowedPorts = [443],
  lookup,
  log = console.log,
} = {}) {
  const server = http.createServer((req, res) => {
    // Only CONNECT tunnels are supported; plain HTTP is refused.
    if (req.url === "/health") {
      res.end("ok");
      return;
    }

    res.writeHead(403).end("Only HTTPS CONNECT is allowed\n");
  });

  server.on("connect", async (req, clientSocket, head) => {
    const verdict = await vetDestination(req.url, { allowlist, allowedPorts, lookup });

    if (!verdict.allowed) {
      log(`egress DENY ${req.url}: ${verdict.reason}`);
      clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }

    const upstream = net.connect(verdict.port, verdict.address, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });

    const close = () => {
      upstream.destroy();
      clientSocket.destroy();
    };

    upstream.setTimeout(60_000, close);
    upstream.on("error", () => {
      clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
    clientSocket.on("error", close);
  });

  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const allowlist = (process.env.SHIPFLOW_EGRESS_ALLOWLIST || DEFAULT_ALLOWLIST.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const port = Number(process.env.SHIPFLOW_EGRESS_PORT || 3128);

  createEgressProxy({ allowlist }).listen(port, () => {
    console.log(`Egress proxy on :${port}, allowing ${allowlist.join(", ")}`);
  });
}
