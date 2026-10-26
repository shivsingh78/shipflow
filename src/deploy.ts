import fs from "fs/promises";
import path from "path";

import { config } from "./config.js";
import { getAllFiles, toObjectKey } from "./file.js";
import { contentTypeFor } from "./artifactStore.js";

/** The part of the release sandbox used to collect build output. */
export interface OutputSandbox {
  copyOut(relativeDir: string, destination: string): Promise<boolean>;
}

/** The part of the artifact store used to upload artifacts. */
export interface UploadStore {
  put(key: string, filePath: string, contentType: string): Promise<unknown>;
  list(prefix: string): Promise<{ key: string; size: number }[]>;
}

export interface ValidatedArtifact {
  files: string[];
  totalBytes: number;
  skippedSymlinks: number;
}

export interface UploadedArtifact {
  artifactPath: string;
  fileCount: number;
}

// Checked in order; the first one the build produced is deployed.
const OUTPUT_DIRECTORIES = ["dist", "build", "out"];

export function artifactPrefix(releaseId: string): string {
  return `releases/${releaseId}/build`;
}

/**
 * Copy the build output out of the sandbox into `destination`.
 */
export async function collectBuildOutput({
  sandbox,
  destination,
  output = "auto",
}: {
  sandbox: OutputSandbox;
  destination: string;
  output?: string;
}): Promise<string> {
  if (output !== "auto") {
    if (await sandbox.copyOut(output, destination)) {
      return output;
    }

    throw new Error(`Build output not found: build.output is "${output}/" but the build did not create it`);
  }

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
export function localAssetReferences(html: string): string[] {
  const references = new Set<string>();
  const pattern = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;

  for (const match of html.matchAll(pattern)) {
    const value = (match[1] ?? "").trim();

    if (!value || EXTERNAL_REFERENCE.test(value)) {
      continue;
    }

    const cleanPath = (value.split(/[?#]/)[0] ?? "").replace(/^\.?\//, "");
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
export async function validateArtifact(artifactDirectory: string): Promise<ValidatedArtifact> {
  const skipped: string[] = [];
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
  store,
  releaseId,
  artifactDirectory,
  files,
}: {
  store: UploadStore;
  releaseId: string;
  artifactDirectory: string;
  files: string[];
}): Promise<UploadedArtifact> {
  const prefix = artifactPrefix(releaseId);
  const expected = new Map<string, number>();

  for (const file of files) {
    const key = toObjectKey(prefix, artifactDirectory, file);

    await store.put(key, file, contentTypeFor(file));
    expected.set(key, (await fs.stat(file)).size);
  }

  const uploaded = new Map(
    (await store.list(`${prefix}/`)).map((object) => [object.key, object.size])
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
