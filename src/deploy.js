import fs from "fs/promises";
import path from "path";

import { config } from "./config.js";
import { getAllFiles, toObjectKey } from "./file.js";
import { uploadFile, listS3Objects } from "./aws.js";

// Checked in order; the first one the build produced is deployed.
const OUTPUT_DIRECTORIES = ["dist", "build", "out"];

export function artifactPrefix(releaseId) {
  return `releases/${releaseId}/build`;
}

/**
 * Copy the build output out of the sandbox into `destination`.
 */
export async function collectBuildOutput({ sandbox, destination }) {
  for (const directory of OUTPUT_DIRECTORIES) {
    if (await sandbox.copyOut(directory, destination)) {
      return directory;
    }
  }

  throw new Error(
    `Build output not found: expected one of ${OUTPUT_DIRECTORIES.map(
      (d) => `${d}/`
    ).join(", ")}`
  );
}

const EXTERNAL_REFERENCE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

/**
 * Local asset references in index.html (src="/assets/app.js", href="style.css").
 * Only paths that look like files are returned, so SPA routes are ignored.
 */
export function localAssetReferences(html) {
  const references = new Set();
  const pattern = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;

  for (const match of html.matchAll(pattern)) {
    const value = match[1].trim();

    if (!value || EXTERNAL_REFERENCE.test(value)) {
      continue;
    }

    const cleanPath = value.split(/[?#]/)[0].replace(/^\.?\//, "");
    const lastSegment = cleanPath.split("/").pop() || "";

    if (cleanPath && lastSegment.includes(".")) {
      references.add(cleanPath);
    }
  }

  return [...references];
}

/**
 * Validate the build output before anything is uploaded or activated.
 */
export async function validateArtifact(artifactDirectory) {
  const skipped = [];
  const files = await getAllFiles(artifactDirectory, { skipped });

  if (files.length === 0) {
    throw new Error("Build output directory is empty");
  }

  if (files.length > config.maxArtifactFiles) {
    throw new Error(
      `Build output has ${files.length} files; the limit is ${config.maxArtifactFiles}`
    );
  }

  let totalBytes = 0;

  for (const file of files) {
    totalBytes += (await fs.stat(file)).size;
  }

  if (totalBytes > config.maxArtifactBytes) {
    throw new Error(
      `Build output is ${totalBytes} bytes; the limit is ${config.maxArtifactBytes}`
    );
  }

  const indexPath = path.join(artifactDirectory, "index.html");

  if (!files.includes(indexPath)) {
    throw new Error("Build output has no index.html at its root");
  }

  const relativeFiles = new Set(
    files.map((file) =>
      path.relative(artifactDirectory, file).split(path.sep).join("/")
    )
  );

  const html = await fs.readFile(indexPath, "utf-8");
  const missing = localAssetReferences(html).filter(
    (reference) => !relativeFiles.has(reference)
  );

  if (missing.length > 0) {
    throw new Error(
      `index.html references files missing from the build: ${missing
        .slice(0, 10)
        .join(", ")}`
    );
  }

  return {
    files,
    totalBytes,
    skippedSymlinks: skipped.length,
  };
}

/**
 * Upload the artifact to its immutable, release-specific location and
 * confirm every file landed with the expected size.
 * This never touches the active deployment.
 */
export async function uploadArtifact({
  releaseId,
  artifactDirectory,
  files,
}) {
  const prefix = artifactPrefix(releaseId);
  const expected = new Map();

  for (const file of files) {
    const key = toObjectKey(prefix, artifactDirectory, file);

    await uploadFile(key, file);
    expected.set(key, (await fs.stat(file)).size);
  }

  const uploaded = new Map(
    (await listS3Objects(`${prefix}/`)).map((object) => [
      object.Key,
      object.Size,
    ])
  );

  for (const [key, size] of expected) {
    if (uploaded.get(key) !== size) {
      throw new Error(`Uploaded artifact is incomplete: ${key}`);
    }
  }

  return {
    artifactPath: prefix,
    fileCount: expected.size,
  };
}
