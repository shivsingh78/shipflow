// Reads the image identity out of a `docker save` archive without extracting
// it. The archive's manifest.json names the image config blob; the blob's
// file name is the sha256 of its content, which is the image ID on a Docker
// host using the classic image store. (`docker image inspect {{.Id}}` on a
// build host using the containerd image store returns the digest of the image
// *index* instead, which a classic-store host never reports after `docker load`.)
import fs from "fs/promises";

const BLOCK = 512;
const MAX_ENTRIES = 100_000;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const CONFIG_BLOB = /(?:^|\/)([a-f0-9]{64})(?:\.json)?$/;

function octal(buffer: Buffer): number {
  const text = buffer.toString("ascii").replace(/\0.*$/s, "").trim();

  return text === "" ? 0 : parseInt(text, 8);
}

/** "sha256:<hex>" of the image config in the archive, or null when it cannot be determined. */
export async function archiveConfigDigest(archivePath: string): Promise<string | null> {
  const handle = await fs.open(archivePath, "r");

  try {
    const header = Buffer.alloc(BLOCK);
    let offset = 0;

    for (let entry = 0; entry < MAX_ENTRIES; entry++) {
      const { bytesRead } = await handle.read(header, 0, BLOCK, offset);

      if (bytesRead < BLOCK || header.every((byte) => byte === 0)) return null;

      const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
      const size = octal(header.subarray(124, 136));

      if (!Number.isFinite(size) || size < 0) return null;

      if (name === "manifest.json" || name === "./manifest.json") {
        if (size > MAX_MANIFEST_BYTES) return null;

        const data = Buffer.alloc(size);
        await handle.read(data, 0, size, offset + BLOCK);

        const manifest: unknown = JSON.parse(data.toString("utf8"));
        const first: unknown = Array.isArray(manifest) ? manifest[0] : null;
        const config: unknown = typeof first === "object" && first !== null && "Config" in first ? first.Config : null;
        const hex = typeof config === "string" ? CONFIG_BLOB.exec(config)?.[1] : undefined;

        return hex ? `sha256:${hex}` : null;
      }

      offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    }

    return null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}
