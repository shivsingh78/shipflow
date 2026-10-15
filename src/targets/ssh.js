// Target "ssh": deploy static files to a server the user controls.
//
// Layout on the server (deployment.ssh.path, e.g. /srv/my-site):
//   releases/<releaseId>/   one immutable directory per release
//   current -> releases/<releaseId>   symlink the web server serves
//
// Safety rules:
//   * the server's host key comes from configuration and is enforced
//     (StrictHostKeyChecking=yes); host-key checking is never disabled
//   * the private key is a server-side secret, written to a 0600 temp file
//     only for the duration of one operation
//   * every remote command is a fixed template; the only dynamic parts are
//     the validated path and release ID, single-quoted
//   * a release directory is uploaded under a .tmp name, its checksums are
//     compared with the local build, and only then is it renamed into place
//   * activation is `ln -sfn` + `mv -T` (rename(2)), an atomic switch;
//     earlier release directories are kept for rollback
//   * no remote deletion outside <path>/releases/<id>.tmp
import fs from "fs/promises";
import os from "os";
import path from "path";
import { spawn } from "child_process";

import { getAllFiles } from "../file.js";
import { runCommand } from "../runCommand.js";
import { httpGet, sha256 } from "../verify.js";

const RELEASE_ID = /^[A-Za-z0-9]{8}$/;
const SSH_TIMEOUT_MS = 120_000;
const UPLOAD_TIMEOUT_MS = 600_000;

const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

function releaseDir(targetConfig, releaseId) {
  if (!RELEASE_ID.test(releaseId)) {
    throw new Error(`Invalid release ID ${releaseId}`);
  }

  return `${targetConfig.path}/releases/${releaseId}`;
}

/**
 * Temporary key and known_hosts files for one SSH operation.
 */
async function openSession(ctx) {
  const { targetConfig, secrets } = ctx;
  const key = secrets?.[targetConfig.privateKeySecret];

  if (!key) {
    throw new Error(
      `Secret ${targetConfig.privateKeySecret} is not available; set it with: shipflow secrets set ${targetConfig.privateKeySecret} --project ${ctx.project}`
    );
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shipflow-ssh-"));
  const keyFile = path.join(dir, "id");
  const knownHosts = path.join(dir, "known_hosts");
  const hostEntry =
    targetConfig.port === 22 ? targetConfig.host : `[${targetConfig.host}]:${targetConfig.port}`;

  await fs.writeFile(keyFile, key.endsWith("\n") ? key : `${key}\n`, { mode: 0o600 });
  await fs.writeFile(knownHosts, `${hostEntry} ${targetConfig.hostKey}\n`, { mode: 0o600 });

  const args = [
    "-i", keyFile,
    "-p", String(targetConfig.port),
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${knownHosts}`,
    "-o", "GlobalKnownHostsFile=/dev/null",
    "-o", "IdentitiesOnly=yes",
    "-o", "IdentityAgent=none",
    "-o", "ConnectTimeout=15",
    "-o", "ServerAliveInterval=15",
    "-o", "LogLevel=ERROR",
    "-F", "/dev/null",
    "--",
    `${targetConfig.user}@${targetConfig.host}`,
  ];

  const env = { PATH: process.env.PATH, HOME: dir };

  const run = async (command, { timeoutMs = SSH_TIMEOUT_MS } = {}) => {
    const result = await runCommand("ssh", [...args, command], { env, timeoutMs });

    if (result.timedOut) {
      throw new Error(`SSH command timed out after ${timeoutMs / 1000}s`);
    }

    if (result.exitCode !== 0) {
      throw new Error(explainSshFailure(result.output, targetConfig));
    }

    return result.output;
  };

  /**
   * Stream a local directory as a tar archive into a remote command.
   */
  const upload = (localDir, remoteCommand) =>
    new Promise((resolve, reject) => {
      const tar = spawn("tar", ["-C", localDir, "-cf", "-", "."], { env });
      const ssh = spawn("ssh", [...args, remoteCommand], { env });
      let output = "";

      const timer = setTimeout(() => {
        tar.kill("SIGKILL");
        ssh.kill("SIGKILL");
      }, UPLOAD_TIMEOUT_MS);

      tar.stdout.pipe(ssh.stdin);
      ssh.stdout.on("data", (d) => (output += d));
      ssh.stderr.on("data", (d) => (output += d));
      tar.on("error", reject);
      ssh.on("error", reject);
      ssh.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Upload failed: ${explainSshFailure(output, targetConfig)}`));
      });
    });

  const close = () => fs.rm(dir, { recursive: true, force: true });

  return { run, upload, close };
}

export function explainSshFailure(output, targetConfig) {
  const text = String(output).trim().split("\n").slice(-5).join(" ").slice(0, 600);

  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(text)) {
    return `Host key of ${targetConfig.host} does not match deployment.ssh.hostKey. If the server was rebuilt, verify its new key out-of-band and update shipflow.yml. (${text})`;
  }

  if (/Permission denied \(publickey/i.test(text)) {
    return `Server rejected the key for ${targetConfig.user}@${targetConfig.host}: check the secret ${targetConfig.privateKeySecret} and the user's authorized_keys. (${text})`;
  }

  if (/Connection refused|timed out|No route to host|Could not resolve/i.test(text)) {
    return `Cannot connect to ${targetConfig.host}:${targetConfig.port}. (${text})`;
  }

  return text || "SSH command failed";
}

async function withSession(ctx, work) {
  const session = await openSession(ctx);

  try {
    return await work(session);
  } finally {
    await session.close();
  }
}

async function localManifest(dir) {
  const files = await getAllFiles(dir);
  const manifest = {};

  for (const file of files) {
    const relative = path.relative(dir, file).split(path.sep).join("/");
    manifest[relative] = sha256(await fs.readFile(file));
  }

  return manifest;
}

export function parseRemoteManifest(output) {
  const manifest = {};

  for (const line of output.split("\n")) {
    const match = /^([0-9a-f]{64})\s+\*?\.\/(.+)$/.exec(line.trim());
    if (match) manifest[match[2]] = match[1];
  }

  return manifest;
}

export function compareManifests(local, remote) {
  const problems = [];

  for (const [file, hash] of Object.entries(local)) {
    if (!remote[file]) problems.push(`missing ${file}`);
    else if (remote[file] !== hash) problems.push(`checksum mismatch ${file}`);
  }

  for (const file of Object.keys(remote)) {
    if (!(file in local)) problems.push(`unexpected ${file}`);
  }

  return problems;
}

export const sshTarget = {
  name: "ssh",
  description: "Static files on your own server over SSH (versioned dirs + atomic symlink)",
  capabilities: {
    candidateVerification: "checksum",
    atomicActivation: true,
    rollback: true,
  },

  requiredSecrets: (targetConfig) => [targetConfig.privateKeySecret],

  async check(ctx) {
    const { targetConfig } = ctx;

    return withSession(ctx, async ({ run }) => {
      const output = await run(
        `test -d ${quote(targetConfig.path)} && test -w ${quote(targetConfig.path)} && echo writable; ` +
          `command -v tar >/dev/null && echo tar; ` +
          `command -v sha256sum >/dev/null && echo sha256sum; ` +
          `mv --help 2>&1 | grep -q -- '-T' && echo mvT; ` +
          `readlink ${quote(`${targetConfig.path}/current`)} || true`
      );

      const has = (word) => output.split("\n").includes(word);

      return [
        { name: "ssh connection", ok: true, detail: `${targetConfig.user}@${targetConfig.host}:${targetConfig.port}` },
        { name: `${targetConfig.path} writable`, ok: has("writable"), detail: has("writable") ? "ok" : `create it and give ${targetConfig.user} write access` },
        { name: "tar", ok: has("tar"), detail: has("tar") ? "ok" : "install tar on the server" },
        { name: "sha256sum", ok: has("sha256sum"), detail: has("sha256sum") ? "ok" : "install coreutils on the server" },
        { name: "mv -T", ok: has("mvT"), detail: has("mvT") ? "ok" : "needs GNU coreutils mv (atomic symlink swap)" },
      ];
    });
  },

  async prepare(ctx) {
    const { targetConfig, releaseId } = ctx;
    const dir = releaseDir(targetConfig, releaseId);
    const temp = `${dir}.tmp`;

    return withSession(ctx, async ({ run, upload }) => {
      const exists = await run(`test -d ${quote(dir)} && echo exists || true`);

      if (exists.includes("exists")) {
        return { detail: `${dir} already on the server` };
      }

      const artifactDir = await ctx.ensureArtifactDir();

      await run(
        `mkdir -p ${quote(`${targetConfig.path}/releases`)} && rm -rf ${quote(temp)} && mkdir ${quote(temp)}`
      );
      await upload(artifactDir, `tar -C ${quote(temp)} -xf -`);

      const remote = parseRemoteManifest(
        await run(`cd ${quote(temp)} && find . -type f -exec sha256sum {} +`)
      );
      const problems = compareManifests(await localManifest(artifactDir), remote);

      if (problems.length > 0) {
        throw new Error(`Uploaded files do not match the build: ${problems.slice(0, 5).join(", ")}`);
      }

      await run(`mv ${quote(temp)} ${quote(dir)}`);

      return { detail: `uploaded ${Object.keys(remote).length} files to ${dir}` };
    });
  },

  async verifyCandidate(ctx) {
    const { targetConfig, releaseId } = ctx;
    const dir = releaseDir(targetConfig, releaseId);

    return withSession(ctx, async ({ run }) => {
      const remote = parseRemoteManifest(
        await run(`cd ${quote(dir)} && find . -type f -exec sha256sum {} +`)
      );
      const problems = compareManifests(await localManifest(await ctx.ensureArtifactDir()), remote);

      if (problems.length > 0) {
        throw new Error(`Release directory does not match the build: ${problems.slice(0, 5).join(", ")}`);
      }

      if (!remote["index.html"]) {
        throw new Error("Release directory has no index.html");
      }

      return { detail: `${Object.keys(remote).length} files verified by SHA-256 in ${dir}` };
    });
  },

  async activate(ctx) {
    const { targetConfig, releaseId } = ctx;
    const dir = releaseDir(targetConfig, releaseId);
    const link = `${targetConfig.path}/.current-${releaseId}.tmp`;

    await withSession(ctx, ({ run }) =>
      run(
        `test -d ${quote(dir)} && ln -sfn ${quote(`releases/${releaseId}`)} ${quote(link)} && ` +
          `mv -Tf ${quote(link)} ${quote(`${targetConfig.path}/current`)}`
      )
    );
  },

  async verifyLive(ctx) {
    const { targetConfig, verification } = ctx;
    const url = new URL(verification.path, targetConfig.url).toString();
    let expectedHash = null;

    // When checking the home page, require the exact index.html we built,
    // which proves the new release (not a cached or old one) is being served.
    if (verification.path === "/") {
      expectedHash = sha256(await fs.readFile(path.join(await ctx.ensureArtifactDir(), "index.html")));
    }

    let lastError;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await httpGet(url, { timeoutMs: 10_000 });

        if (response.status !== verification.expectStatus) {
          throw new Error(`${url} returned HTTP ${response.status}, expected ${verification.expectStatus}`);
        }

        if (expectedHash && sha256(response.body) !== expectedHash) {
          throw new Error(`${url} does not serve this release's index.html yet`);
        }

        return {
          url,
          detail: `${url} returned HTTP ${response.status}${expectedHash ? " with this release's index.html" : ""}`,
        };
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    throw lastError;
  },

  liveUrl: ({ targetConfig }) => targetConfig.url,
};
