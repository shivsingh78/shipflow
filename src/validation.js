const RELEASE_ID_PATTERN = /^[A-Za-z0-9]{8}$/;

export function isValidReleaseId(releaseId) {
  return (
    typeof releaseId === "string" &&
    RELEASE_ID_PATTERN.test(releaseId)
  );
}

/**
 * Validate a repository URL against the configured prefix allowlist.
 * Returns the normalized URL or throws an Error with a user-facing message.
 */
export function validateRepoUrl(repoUrl, allowedPrefixes) {
  if (typeof repoUrl !== "string" || repoUrl.trim() === "") {
    throw new Error("repoUrl is required");
  }

  const value = repoUrl.trim();

  if (value.length > 300) {
    throw new Error("repoUrl is too long");
  }

  if (/[\s\\]/.test(value) || value.startsWith("-")) {
    throw new Error("repoUrl contains invalid characters");
  }

  let url;

  try {
    url = new URL(value);
  } catch {
    throw new Error("repoUrl must be a valid http(s) URL");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("repoUrl must use https");
  }

  if (url.username || url.password) {
    throw new Error("repoUrl must not contain credentials");
  }

  if (url.search || url.hash) {
    throw new Error("repoUrl must not contain a query string or fragment");
  }

  const segments = url.pathname.split("/").filter(Boolean);

  if (
    segments.length !== 2 ||
    segments.some((segment) => segment === "." || segment === "..") ||
    !segments.every((segment) => /^[A-Za-z0-9._-]+$/.test(segment))
  ) {
    throw new Error(
      "repoUrl must look like https://<host>/<owner>/<repo>"
    );
  }

  const normalized = `${url.protocol}//${url.host}/${segments.join("/")}`;

  const allowed = allowedPrefixes.some((prefix) =>
    normalized.toLowerCase().startsWith(prefix.toLowerCase())
  );

  if (!allowed) {
    throw new Error(
      "repoUrl is not in the list of allowed repositories"
    );
  }

  return normalized;
}

/**
 * Turn a request path into a safe relative object path.
 * Returns null when the path tries to escape its root.
 */
export function safeRelativePath(requestedPath) {
  let decoded;

  try {
    decoded = decodeURIComponent(requestedPath || "");
  } catch {
    return null;
  }

  if (decoded.includes("\0") || decoded.includes("\\")) {
    return null;
  }

  const segments = [];

  for (const segment of decoded.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }

    if (segment === "..") {
      return null;
    }

    segments.push(segment);
  }

  const relative = segments.join("/");

  if (relative === "" || decoded.endsWith("/")) {
    return relative === "" ? "index.html" : `${relative}/index.html`;
  }

  return relative;
}
