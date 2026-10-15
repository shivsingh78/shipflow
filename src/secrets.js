// Per-project deployment secrets (for example an SSH private key).
//
// Values are encrypted with AES-256-GCM using SHIPFLOW_SECRETS_KEY and the
// "project/name" pair as additional authenticated data, so a ciphertext
// cannot be copied to another project or name. Plaintext is never written to
// the database, returned by the API, logged, or passed to build sandboxes;
// it is decrypted only in trusted worker/API code for the deploy stages that
// need it.
import crypto from "crypto";

import { pool } from "./db.js";

const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_SECRET_BYTES = 16 * 1024;

export class SecretsError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "SecretsError";
    this.statusCode = statusCode;
  }
}

export function parseSecretsKey(raw) {
  if (!raw) return null;

  const key = /^[0-9a-f]{64}$/i.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64");

  if (key.length !== 32) {
    throw new Error(
      "SHIPFLOW_SECRETS_KEY must be 32 bytes as 64 hex characters (generate with: openssl rand -hex 32)"
    );
  }

  return key;
}

export function encryptSecret(key, aad, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  cipher.setAAD(Buffer.from(aad));
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}

export function decryptSecret(key, aad, stored) {
  const [version, iv, tag, data] = stored.split(":");

  if (version !== "v1") {
    throw new Error("Unsupported secret format");
  }

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tag, "base64"));

  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

export function createSecretStore({ key, db = pool }) {
  const requireKey = () => {
    if (!key) {
      throw new SecretsError(
        "Secret storage is disabled: set SHIPFLOW_SECRETS_KEY on the server (openssl rand -hex 32)",
        503
      );
    }
  };

  const validateName = (name) => {
    if (!SECRET_NAME.test(name || "")) {
      throw new SecretsError("Secret names must be UPPER_CASE letters, digits and underscores");
    }
  };

  return {
    enabled: Boolean(key),

    async set(project, name, value) {
      requireKey();
      validateName(name);

      if (typeof value !== "string" || value.length === 0) {
        throw new SecretsError("Secret value must be a non-empty string");
      }

      if (Buffer.byteLength(value) > MAX_SECRET_BYTES) {
        throw new SecretsError(`Secret value must be at most ${MAX_SECRET_BYTES} bytes`);
      }

      await db.query(
        `
        INSERT INTO project_secrets (project, name, ciphertext, updated_at)
        VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
        ON CONFLICT (project, name)
        DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_at = CURRENT_TIMESTAMP
        `,
        [project, name, encryptSecret(key, `${project}/${name}`, value)]
      );
    },

    async list(project) {
      const result = await db.query(
        "SELECT name, updated_at FROM project_secrets WHERE project = $1 ORDER BY name",
        [project]
      );

      return result.rows;
    },

    async remove(project, name) {
      validateName(name);
      const result = await db.query(
        "DELETE FROM project_secrets WHERE project = $1 AND name = $2",
        [project, name]
      );

      return result.rowCount > 0;
    },

    /**
     * Decrypt the named secrets for trusted deploy code. Throws if any is
     * missing, naming the secret (never the value).
     */
    async resolve(project, names) {
      if (names.length === 0) return {};

      requireKey();

      const result = await db.query(
        "SELECT name, ciphertext FROM project_secrets WHERE project = $1 AND name = ANY($2)",
        [project, names]
      );
      const found = Object.fromEntries(result.rows.map((row) => [row.name, row.ciphertext]));
      const missing = names.filter((name) => !found[name]);

      if (missing.length > 0) {
        throw new SecretsError(
          `Missing secret(s) for project ${project}: ${missing.join(", ")}. Set with: shipflow secrets set <NAME> --project ${project}`,
          409
        );
      }

      return Object.fromEntries(
        names.map((name) => [name, decryptSecret(key, `${project}/${name}`, found[name])])
      );
    },
  };
}
