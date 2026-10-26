// The deployment key pair and host-key fingerprints.
import crypto from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

import { errorCode, errorMessage } from "../errors.js";

const execFileAsync = promisify(execFile);

/** A private (0700) temporary directory for the deployment key. */
export async function createKeyDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shipflow-key-"));
  await fs.chmod(dir, 0o700);
  return dir;
}

/** Runs a command; the real one is promisified execFile. */
type RunCommand = (file: string, args: string[]) => Promise<unknown>;

/**
 * Generate an Ed25519 key pair with ssh-keygen (no passphrase) inside `dir`.
 * Returns the PUBLIC key text and the path of the private key.
 */
export async function generateDeployKey({
  dir,
  comment,
  run = execFileAsync,
}: {
  dir: string;
  comment: string;
  run?: RunCommand;
}): Promise<{ privateKeyPath: string; publicKey: string }> {
  const privateKeyPath = path.join(dir, "id_ed25519");

  try {
    await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", privateKeyPath]);
  } catch (error) {
    const { stderr } = error as { stderr?: unknown }; // execFile errors carry the child's stderr
    const detail = (typeof stderr === "string" && stderr) || errorMessage(error);
    throw new Error(
      errorCode(error) === "ENOENT"
        ? "ssh-keygen was not found. Install an OpenSSH client (it is included with Windows 10+, macOS and most Linux distributions)."
        : `ssh-keygen failed: ${detail.split("\n")[0]}`,
      { cause: error }
    );
  }

  await fs.chmod(privateKeyPath, 0o600);
  const publicKey = (await fs.readFile(`${privateKeyPath}.pub`, "utf8")).trim();

  if (!/^ssh-ed25519 /.test(publicKey)) {
    throw new Error("ssh-keygen did not produce an ssh-ed25519 public key");
  }

  return { privateKeyPath, publicKey };
}

/**
 * Overwrite the files in `dir` with zeros, then delete it. Best effort: a
 * failure is reported to the caller, never thrown past cleanup paths.
 */
export async function wipeDir(dir: string): Promise<boolean> {
  try {
    for (const entry of await fs.readdir(dir)) {
      const file = path.join(dir, entry);
      const { size } = await fs.stat(file);
      await fs.writeFile(file, Buffer.alloc(size));
    }
  } catch {
    // keep going: removal below is what matters
  }

  try {
    await fs.rm(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** OpenSSH-style fingerprint: SHA256:<base64 without padding>. */
export function hostKeyFingerprint(hostKey: string): string {
  const blob = Buffer.from(hostKey.trim().split(/\s+/)[1] ?? "", "base64");
  const digest = crypto.createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
  return `SHA256:${digest}`;
}
