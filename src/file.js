import fs from "fs/promises";
import path from "path";

/**
 * Recursively list regular files. Symlinks are never followed or returned,
 * so a repository cannot point a link at worker files (e.g. /app/.env) and
 * get them uploaded.
 */
export async function getAllFiles(
  folderPath,
  { ignore = [], skipped = [] } = {}
) {
  const response = [];

  const entries = await fs.readdir(folderPath, {
    withFileTypes: true,
  });

  for (const entry of entries) {
    if (ignore.includes(entry.name)) {
      continue;
    }

    const fullFilePath = path.join(folderPath, entry.name);

    if (entry.isSymbolicLink()) {
      skipped.push(fullFilePath);
    } else if (entry.isDirectory()) {
      response.push(
        ...(await getAllFiles(fullFilePath, { ignore, skipped }))
      );
    } else if (entry.isFile()) {
      response.push(fullFilePath);
    }
  }

  return response;
}

/**
 * S3 keys always use forward slashes.
 */
export function toObjectKey(prefix, root, file) {
  return `${prefix}/${path.relative(root, file).split(path.sep).join("/")}`;
}
