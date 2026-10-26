// Where the CLI keeps the server address and API token.
//
// Precedence: SHIPFLOW_API_URL / SHIPFLOW_API_TOKEN environment variables
// (for CI) > the credentials file written by `shipflow login`.
// The file is created with mode 0600 inside a 0700 directory.
import fs from "fs";
import os from "os";
import path from "path";

export interface StoredCredentials {
  server?: string;
  token?: string;
}

export interface ConnectionOverrides {
  server?: string | undefined;
  token?: string | undefined;
}

export function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "shipflow");
}

export function credentialsPath(): string {
  return path.join(configDir(), "credentials.json");
}

export function readCredentials(): StoredCredentials {
  try {
    const file = credentialsPath();
    const stat = fs.statSync(file);

    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      process.stderr.write(
        `Warning: ${file} is readable by other users; run: chmod 600 ${file}\n`
      );
    }

    return JSON.parse(fs.readFileSync(file, "utf8")) as StoredCredentials;
  } catch {
    return {};
  }
}

export function writeCredentials(credentials: StoredCredentials): string {
  const dir = configDir();

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = credentialsPath();
  const temp = `${file}.${process.pid}.tmp`;

  fs.writeFileSync(temp, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);

  return file;
}

export function removeCredentials(): void {
  fs.rmSync(credentialsPath(), { force: true });
}

/**
 * Effective server URL and token, and where each came from.
 */
export function resolveConnection(overrides: ConnectionOverrides = {}): {
  url: string;
  token: string;
  source: string;
} {
  const stored = readCredentials();
  const url =
    overrides.server || process.env.SHIPFLOW_API_URL || stored.server || "http://localhost:8000";
  const normalize = (value: string | undefined) => (value || "").replace(/\/+$/, "");
  // A stored token is only sent to the server it was saved for.
  const storedToken = normalize(url) === normalize(stored.server) ? stored.token : "";
  const token = overrides.token || process.env.SHIPFLOW_API_TOKEN || storedToken || "";

  return {
    url: url.replace(/\/+$/, ""),
    token,
    source: overrides.token
      ? "command line"
      : process.env.SHIPFLOW_API_TOKEN
        ? "environment"
        : storedToken
          ? credentialsPath()
          : "none",
  };
}

/**
 * http:// is only acceptable for loopback/private development addresses.
 */
export function isInsecureRemote(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol === "https:") return false;
    return !/^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[a-z0-9-]+)$/i.test(hostname);
  } catch {
    return true;
  }
}
