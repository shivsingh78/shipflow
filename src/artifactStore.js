// Artifact storage: where release source snapshots and build outputs are
// kept. Separate from *deployment targets* (where a site is served from).
//
//   s3    — any S3-compatible bucket (AWS S3, or a mock in tests)
//   local — a directory on the ShipFlow host (no cloud account needed)
//
// Every store exposes the same small interface:
//   put(key, filePath, contentType) · list(prefix) -> [{ key, size }]
//   get(key) -> { Body, ContentType, ContentLength } · remove(keys)
//   isNotFound(error) · describe()
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";
import mime from "mime-types";

import { config } from "./config.js";

const KEY_PATTERN = /^[A-Za-z0-9._/-]+$/;

export function assertSafeKey(key) {
  if (
    typeof key !== "string" ||
    !KEY_PATTERN.test(key) ||
    key.startsWith("/") ||
    key.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Invalid artifact key: ${JSON.stringify(key)}`);
  }

  return key;
}

export function contentTypeFor(filePath) {
  return mime.contentType(path.basename(filePath)) || "application/octet-stream";
}

export function createLocalStore(root) {
  const resolve = (key) => {
    const full = path.join(root, assertSafeKey(key));

    if (!full.startsWith(path.resolve(root) + path.sep)) {
      throw new Error(`Invalid artifact key: ${key}`);
    }

    return full;
  };

  const notFound = (key) =>
    Object.assign(new Error(`Artifact not found: ${key}`), { code: "ENOENT", name: "NoSuchKey" });

  return {
    kind: "local",

    describe: () => `local:${root}`,

    async put(key, filePath) {
      const destination = resolve(key);

      await fsp.mkdir(path.dirname(destination), { recursive: true });

      // Write then rename, so readers never see a partial file.
      const temp = `${destination}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      await fsp.copyFile(filePath, temp);
      await fsp.rename(temp, destination);
    },

    async list(prefix) {
      const base = prefix.replace(/\/+$/, "");
      const directory = resolve(base);
      const results = [];

      const walk = async (dir) => {
        let entries;

        try {
          entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch (error) {
          if (error.code === "ENOENT") return;
          throw error;
        }

        for (const entry of entries) {
          const full = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            await walk(full);
          } else if (entry.isFile() && !entry.name.endsWith(".tmp")) {
            const stat = await fsp.stat(full);
            results.push({
              key: path.relative(root, full).split(path.sep).join("/"),
              size: stat.size,
            });
          }
        }
      };

      await walk(directory);
      return results;
    },

    async get(key) {
      const full = resolve(key);
      let stat;

      try {
        stat = await fsp.stat(full);
      } catch {
        throw notFound(key);
      }

      if (!stat.isFile()) {
        throw notFound(key);
      }

      return {
        Body: fs.createReadStream(full),
        ContentType: contentTypeFor(full),
        ContentLength: stat.size,
      };
    },

    async remove(keys) {
      for (const key of keys) {
        await fsp.rm(resolve(key), { force: true });
      }
    },

    isNotFound: (error) => error?.code === "ENOENT" || error?.name === "NoSuchKey",
  };
}

export async function createS3Store() {
  const aws = await import("./aws.js");

  return {
    kind: "s3",

    describe: () => `s3://${config.s3.bucket}`,

    put: (key, filePath, contentType) =>
      aws.uploadFile(assertSafeKey(key), filePath, contentType),

    async list(prefix) {
      return (await aws.listS3Objects(prefix)).map((object) => ({
        key: object.Key,
        size: object.Size,
      }));
    },

    get: (key) => aws.getS3Object(assertSafeKey(key)),

    remove: (keys) => aws.deleteS3Objects(keys.map(assertSafeKey)),

    isNotFound: aws.isNotFoundError,
  };
}

let store;

export async function getArtifactStore() {
  if (!store) {
    if (config.artifactStore === "s3") {
      if (!config.s3.bucket) {
        throw new Error("SHIPFLOW_ARTIFACT_STORE=s3 requires S3_BUCKET_NAME");
      }
      store = await createS3Store();
    } else if (config.artifactStore === "local") {
      store = createLocalStore(path.resolve(config.artifactDir));
    } else {
      throw new Error(
        `Unknown SHIPFLOW_ARTIFACT_STORE "${config.artifactStore}" (use "s3" or "local")`
      );
    }
  }

  return store;
}

/**
 * Download every file under `prefix` into `destination`, e.g. to re-deploy
 * a stored release to a target during rollback.
 */
export async function downloadArtifact(artifactStore, prefix, destination) {
  const base = prefix.replace(/\/+$/, "");
  const objects = await artifactStore.list(`${base}/`);

  for (const object of objects) {
    const relative = object.key.slice(base.length + 1);
    const target = path.join(destination, assertSafeKey(relative));

    await fsp.mkdir(path.dirname(target), { recursive: true });

    const { Body } = await artifactStore.get(object.key);
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(target);
      Body.pipe(out);
      out.on("finish", resolve);
      out.on("error", reject);
      Body.on("error", reject);
    });
  }

  return objects.length;
}
