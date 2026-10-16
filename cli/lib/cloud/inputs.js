// Validation of every answer the AWS wizard accepts. Each parser returns the
// normalized value or throws InputError with a message safe to show.

export class InputError extends Error {}

const REGION = /^(us|eu|ap|sa|ca|me|af|il|mx)-[a-z]+-\d$/;
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;
const OUTPUT = /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9._/-]{1,200}$/;
const INSTANCE_TYPE = /^[a-z][a-z0-9-]{0,15}\.[a-z0-9-]{3,15}$/;
const REPO_SEGMENT = /^[A-Za-z0-9._-]+$/;

export const MAX_NAME_LENGTH = 40;
export const DISK_GIB = { min: 8, max: 100, default: 8 };
/** Single-VM test environments: refuse sizes that would be expensive by accident. */
export const LIMITS = { maxVcpus: 8, maxMemoryMiB: 32 * 1024 };

export function parseRegion(value) {
  const region = String(value ?? "").trim().toLowerCase();

  if (!REGION.test(region)) {
    throw new InputError(
      'Enter a standard AWS region such as "ap-south-1" (GovCloud and China regions are not supported)'
    );
  }

  return region;
}

export function parseName(value) {
  const name = String(value ?? "").trim().toLowerCase();

  if (!NAME.test(name)) {
    throw new InputError(
      `Use lowercase letters, digits and dashes, up to ${MAX_NAME_LENGTH} characters, starting and ending with a letter or digit`
    );
  }

  return name;
}

export function parseBranch(value) {
  const branch = String(value ?? "").trim();

  if (!BRANCH.test(branch) || branch.startsWith("refs/")) {
    throw new InputError("Enter a branch name such as main (letters, digits, . _ - /)");
  }

  return branch;
}

export function parseOutput(value) {
  const output = String(value ?? "").trim() || "auto";

  if (output !== "auto" && !OUTPUT.test(output)) {
    throw new InputError(
      'Enter "auto" or a relative directory inside the repository such as dist (no leading / and no "..")'
    );
  }

  return output;
}

export function parseInstanceType(value) {
  const type = String(value ?? "").trim().toLowerCase();

  if (!INSTANCE_TYPE.test(type)) {
    throw new InputError('Enter an EC2 instance type such as "t3.micro"');
  }

  return type;
}

export function parseDiskSize(value) {
  const text = String(value ?? "").trim();
  const size = Number(text);

  if (!/^\d+$/.test(text) || size < DISK_GIB.min || size > DISK_GIB.max) {
    throw new InputError(`Enter a whole number of GiB between ${DISK_GIB.min} and ${DISK_GIB.max}`);
  }

  return size;
}

/**
 * HTTPS repository URL of the form https://host/owner/repo, optionally
 * checked against the server's allowed prefixes.
 */
export function parseRepoUrl(value, { allowedPrefixes } = {}) {
  const text = String(value ?? "").trim();
  let url;

  try {
    url = new URL(text);
  } catch {
    throw new InputError("Enter an HTTPS repository URL such as https://github.com/owner/repo");
  }

  if (url.protocol !== "https:") {
    throw new InputError("The repository URL must use https://");
  }

  if (url.username || url.password) {
    throw new InputError("The repository URL must not contain credentials; private repositories are not supported yet");
  }

  if (url.search || url.hash) {
    throw new InputError("The repository URL must not contain a query string or fragment");
  }

  if (!url.hostname.includes(".") || /^[\d.]+$/.test(url.hostname)) {
    throw new InputError("Use a repository host name such as github.com");
  }

  const segments = url.pathname.split("/").filter(Boolean);

  if (
    segments.length !== 2 ||
    !segments.every((s) => REPO_SEGMENT.test(s) && s !== "." && s !== "..")
  ) {
    throw new InputError("The repository URL must look like https://<host>/<owner>/<repo>");
  }

  const normalized = `https://${url.host}/${segments.join("/")}`;

  if (allowedPrefixes && !isRepoAllowed(normalized, allowedPrefixes)) {
    throw new InputError(
      `This ShipFlow server only deploys repositories under: ${allowedPrefixes.join(", ")}`
    );
  }

  return normalized;
}

export function isRepoAllowed(url, prefixes) {
  return prefixes.some((prefix) => url.toLowerCase().startsWith(prefix.toLowerCase()));
}

// ---- CIDR

function ipToInt(octets) {
  return octets.reduce((acc, octet) => acc * 256 + octet, 0);
}

function intToIp(value) {
  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join(".");
}

// Ranges that can never be the public egress address of a worker.
const NON_PUBLIC = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, includes the broadcast address
].map(([ip, prefix]) => {
  const start = ipToInt(ip.split(".").map(Number));
  return [start, start + 2 ** (32 - prefix) - 1];
});

/**
 * An IPv4 address or CIDR allowed to SSH to the VPS. A bare address means
 * /32. Refuses 0.0.0.0/0, very broad ranges and non-public ranges.
 */
export function parseCidr(value) {
  const text = String(value ?? "").trim();
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(text);

  if (!match) {
    throw new InputError("Enter an IPv4 address or CIDR such as 198.51.100.7 or 198.51.100.0/24");
  }

  const octets = match.slice(1, 5).map(Number);

  if (octets.some((octet) => octet > 255)) {
    throw new InputError("Each part of an IPv4 address must be between 0 and 255");
  }

  const prefix = match[5] === undefined ? 32 : Number(match[5]);

  if (prefix > 32) {
    throw new InputError("The prefix length must be between 16 and 32");
  }

  if (prefix === 0) {
    throw new InputError("Refusing 0.0.0.0/0: that would open SSH to the whole internet");
  }

  if (prefix < 16) {
    throw new InputError(`/${prefix} is too broad for SSH access; use /16 or narrower (ideally the worker's /32)`);
  }

  const size = 2 ** (32 - prefix);
  const address = ipToInt(octets);
  const base = Math.floor(address / size) * size;
  const last = base + size - 1;

  if (NON_PUBLIC.some(([start, end]) => base <= end && last >= start)) {
    throw new InputError(
      "That range is private, loopback, link-local or reserved, so the VPS will never see it as the " +
        "worker's address. Use the worker's public egress IP"
    );
  }

  return { cidr: `${intToIp(base)}/${prefix}`, adjusted: base !== address };
}
