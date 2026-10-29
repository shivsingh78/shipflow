/**
 * Generate the RSA key pair that seals customers' AI provider keys.
 *
 *   node dist/src/repopilot/keygen.js <directory>
 *
 * Writes <directory>/credential_public.pem (give this to the API) and
 * <directory>/credential_private.pem (worker only, mode 0600). Refuses to
 * overwrite an existing key. Never prints key material.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { generateCredentialKeyPair } from "./credentials.js";

export function writeKeyPair(directory: string): { publicPath: string; privatePath: string } {
  const publicPath = path.join(directory, "credential_public.pem");
  const privatePath = path.join(directory, "credential_private.pem");

  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  if (fs.existsSync(publicPath) || fs.existsSync(privatePath)) {
    throw new Error(`Refusing to overwrite existing keys in ${directory}. Rotating keys invalidates every stored provider key.`);
  }

  const { publicKeyPem, privateKeyPem } = generateCredentialKeyPair();

  // "wx" fails if the file appeared since the check above.
  fs.writeFileSync(privatePath, privateKeyPem, { mode: 0o600, flag: "wx" });
  fs.writeFileSync(publicPath, publicKeyPem, { mode: 0o644, flag: "wx" });

  return { publicPath, privatePath };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2];

  if (!directory) {
    console.error("usage: node dist/src/repopilot/keygen.js <directory>");
    process.exit(2);
  }

  try {
    const { publicPath, privatePath } = writeKeyPair(directory);

    console.log(`Public key (API):   ${publicPath}\nPrivate key (worker only, keep secret): ${privatePath}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "key generation failed");
    process.exit(1);
  }
}
