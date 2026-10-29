/**
 * Customer (BYOK) provider credentials.
 *
 * The API process must receive a key once, when the customer submits it, but
 * must never be able to read a stored key back. So keys are sealed to a
 * PUBLIC key (RSA-OAEP, SHA-256) before they are stored. Only the
 * orchestration worker holds the matching private key.
 *
 * Honest limits: the API process still sees the plaintext in memory for the
 * duration of the submit request; this design stops a later API (or
 * database) compromise from exposing stored keys, not a compromise of the
 * API at the moment of submission.
 */

import crypto from "crypto";

export class CredentialError extends Error {
  constructor(
    readonly code: "invalid_key" | "invalid_public_key" | "unseal_failed" | "unsupported_provider",
    message: string
  ) {
    super(message);
    this.name = "CredentialError";
  }
}

export const PROVIDERS = ["anthropic"] as const;
export type Provider = (typeof PROVIDERS)[number];

const KEY_SHAPE: Record<Provider, RegExp> = {
  anthropic: /^sk-ant-[A-Za-z0-9_-]{20,250}$/,
};

export function isProvider(value: unknown): value is Provider {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

/** Check the shape only (never logs or echoes the key). */
export function assertKeyShape(provider: Provider, key: unknown): asserts key is string {
  if (typeof key !== "string" || !KEY_SHAPE[provider].test(key)) {
    throw new CredentialError("invalid_key", `That does not look like a valid ${provider} API key`);
  }
}

/** Short, non-reversible tag so a user can tell which key is stored. */
export function credentialFingerprint(plaintext: string): string {
  return crypto.createHash("sha256").update(`repopilot-credential-fingerprint\0${plaintext}`).digest("hex").slice(0, 16);
}

export function generateCredentialKeyPair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

/**
 * Validate a configured public key. A private key pasted into the API's
 * variable would let the API decrypt every stored credential, so it is
 * refused outright (Node would otherwise happily derive the public key).
 */
export function parsePublicKeyPem(pem: string): string {
  if (/PRIVATE KEY/.test(pem)) {
    throw new CredentialError("invalid_public_key", "REPOPILOT_CREDENTIAL_PUBLIC_KEY contains a PRIVATE key; configure the public key only");
  }

  try {
    const key = crypto.createPublicKey(pem);

    if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
      throw new Error("not an RSA key of at least 2048 bits");
    }
  } catch {
    throw new CredentialError("invalid_public_key", "REPOPILOT_CREDENTIAL_PUBLIC_KEY is not a valid RSA public key (2048 bits or more)");
  }

  return pem;
}

export function sealCredential(publicKeyPem: string, plaintext: string): string {
  return crypto
    .publicEncrypt({ key: parsePublicKeyPem(publicKeyPem), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(plaintext, "utf-8"))
    .toString("base64");
}

export function openCredential(privateKeyPem: string, sealed: string): string {
  try {
    return crypto
      .privateDecrypt({ key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(sealed, "base64"))
      .toString("utf-8");
  } catch {
    // Deliberately uninformative: no key material or ciphertext in the message.
    throw new CredentialError("unseal_failed", "The stored credential could not be decrypted with the configured key");
  }
}
