// What a release produces. Build strategies create artifacts, the pipeline
// stores them immutably, and deployment targets consume them. Keeping the
// artifact type separate from both the strategy and the target is what lets
// any compatible strategy/target pair work together.
//
//   static  a directory of files (index.html at its root), kept in the
//           artifact store under releases/<id>/build/
//   image   a container image, kept in the artifact store as a `docker save`
//           archive under releases/<id>/image/, identified by its content
//           digest (the image ID, sha256:...). No registry is required to
//           build, store, or roll back; targets that need a registry (e.g.
//           Kubernetes) push the stored archive themselves and reference the
//           registry digest.

export type ArtifactType = "static" | "image";

export interface StaticArtifact {
  type: "static";
  /** Artifact-store prefix of the files. */
  path: string;
  fileCount: number;
}

export interface ImageArtifact {
  type: "image";
  /** Artifact-store key of the `docker save` archive. */
  key: string;
  /** Content digest (image ID) of the built image: "sha256:" + 64 hex. Immutable identity. */
  digest: string;
  /** Archive size in bytes. */
  sizeBytes: number;
  /** Port the application listens on inside the container. */
  port: number;
}

export type Artifact = StaticArtifact | ImageArtifact;

const DIGEST = /^sha256:[a-f0-9]{64}$/;

export function isImageDigest(value: string): boolean {
  return DIGEST.test(value);
}

export function staticPrefix(releaseId: string): string {
  return `releases/${releaseId}/build`;
}

export function imagePrefix(releaseId: string): string {
  return `releases/${releaseId}/image`;
}

export function imageKey(releaseId: string): string {
  return `${imagePrefix(releaseId)}/image.tar`;
}

/** The release columns an artifact is rebuilt from (see releaseStore). */
export interface ArtifactRecord {
  artifact_type?: string | null;
  artifact?: unknown;
  artifact_path?: string | null;
}

/**
 * The artifact of a stored release. Releases created before artifact types
 * existed have only artifact_path and are static.
 */
export function artifactOf(release: ArtifactRecord): Artifact | null {
  const stored = release.artifact;

  if (typeof stored === "object" && stored !== null && "type" in stored) {
    if (stored.type === "image") {
      const image = stored as Partial<ImageArtifact>;

      if (
        typeof image.key === "string" &&
        typeof image.digest === "string" &&
        isImageDigest(image.digest) &&
        typeof image.sizeBytes === "number" &&
        typeof image.port === "number"
      ) {
        return { type: "image", key: image.key, digest: image.digest, sizeBytes: image.sizeBytes, port: image.port };
      }

      return null;
    }

    if (stored.type === "static") {
      const files = stored as Partial<StaticArtifact>;

      if (typeof files.path === "string") {
        return { type: "static", path: files.path, fileCount: typeof files.fileCount === "number" ? files.fileCount : 0 };
      }

      return null;
    }
  }

  if (release.artifact_path) {
    return { type: "static", path: release.artifact_path, fileCount: 0 };
  }

  return null;
}

/** The artifact-store location holding a release's files (for any artifact type). */
export function artifactLocation(artifact: Artifact): string {
  return artifact.type === "static" ? artifact.path : artifact.key;
}
