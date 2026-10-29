/**
 * Evidence storage on top of ShipFlow's existing artifact store.
 *
 * Only what a reviewer needs is stored (manifest, findings report, patch and
 * validation report, verification logs, outcome). Keys are built here from
 * integers and a fixed kind list, never from request data, and are checked
 * with the store's own assertSafeKey. Nothing is public: objects are only
 * reachable through the owner-scoped API route.
 */

import crypto from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";

import { assertSafeKey } from "../artifactStore.js";
import type { ArtifactStore } from "../artifactStore.js";
import { redactSensitive } from "./redact.js";
import type { ArtifactRow, StageTx } from "./store.js";

export const EVIDENCE_KINDS_ALLOWED = ["manifest", "findings", "patch", "patch_validation", "verification_log", "outcome", "pr_body"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS_ALLOWED)[number];

export const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;

export interface EvidenceStore {
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  /** Up to maxBytes of an object, or null when it does not exist. */
  get(key: string, maxBytes: number): Promise<Buffer | null>;
  remove(keys: string[]): Promise<void>;
}

export function evidenceKey(input: { runId: number; kind: EvidenceKind; patchId?: number; arm?: string; attempt?: number }): string {
  if (!Number.isInteger(input.runId) || input.runId < 1 || (input.patchId !== undefined && (!Number.isInteger(input.patchId) || input.patchId < 1))) {
    throw new TypeError("invalid evidence key input");
  }

  if (!(EVIDENCE_KINDS_ALLOWED as readonly string[]).includes(input.kind)) {
    throw new TypeError("unknown evidence kind");
  }

  if (input.arm !== undefined && !/^(baseline|control|patched)$/.test(input.arm)) {
    throw new TypeError("invalid arm");
  }

  const parts = [`repopilot/runs/${input.runId}`, input.kind];

  if (input.patchId !== undefined) parts.push(`p${input.patchId}`);
  if (input.arm !== undefined) parts.push(input.arm);
  if (input.attempt !== undefined) parts.push(`a${input.attempt}`);

  return assertSafeKey(`${parts.join("/")}.txt`);
}

/** Adapter over ShipFlow's artifact store (S3 or local). */
export function createEvidenceStore(store: ArtifactStore): EvidenceStore {
  return {
    async put(key, bytes, contentType) {
      assertSafeKey(key);

      if (bytes.length > MAX_EVIDENCE_BYTES) {
        throw new RangeError("evidence is too large");
      }

      // The store takes a file path; use a private temp directory.
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repopilot-evidence-"));

      try {
        const file = path.join(dir, "object");
        await fs.writeFile(file, bytes, { mode: 0o600 });
        await store.put(key, file, contentType);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    },

    async get(key, maxBytes) {
      assertSafeKey(key);

      let body;

      try {
        body = await store.get(key);
      } catch (error) {
        if (store.isNotFound(error)) return null;
        throw error;
      }

      const chunks: Buffer[] = [];
      let total = 0;

      for await (const chunk of body.Body) {
        const buffer = Buffer.from(chunk as Uint8Array);
        total += buffer.length;

        if (total > maxBytes) {
          body.Body.destroy();
          throw new RangeError("evidence object exceeds the read limit");
        }

        chunks.push(buffer);
      }

      return Buffer.concat(chunks);
    },

    async remove(keys) {
      for (const key of keys) assertSafeKey(key);
      await store.remove(keys);
    },
  };
}

/**
 * Write evidence and index it, inside a stage's persist callback. Text kinds
 * are credential-scrubbed; `redact: false` keeps exact bytes (a patch must
 * hash to the digest a human approves).
 */
export async function saveEvidence(
  tx: StageTx,
  evidence: EvidenceStore,
  input: { kind: EvidenceKind; data: string | Buffer; patchId?: number; arm?: string; attempt?: number; redact?: boolean }
): Promise<ArtifactRow> {
  const text = typeof input.data === "string" ? input.data : input.data.toString("utf-8");
  const bytes = Buffer.from(input.redact === false ? text : redactSensitive(text), "utf-8");
  const key = evidenceKey({ runId: tx.run.id, kind: input.kind, ...(input.patchId === undefined ? {} : { patchId: input.patchId }), ...(input.arm === undefined ? {} : { arm: input.arm }), ...(input.attempt === undefined ? {} : { attempt: input.attempt }) });

  await evidence.put(key, bytes, "text/plain; charset=utf-8");

  return tx.insertArtifact({ kind: input.kind, objectKey: key, bytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), patchId: input.patchId ?? null });
}
