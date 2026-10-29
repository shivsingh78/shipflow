/**
 * Worker capability heartbeats. Workers publish WHAT they can do (never any
 * secret) under a short-lived Redis key; the API reads them to tell the user
 * the truth about GitHub access, credential decryption and the sandbox.
 */

import type { WorkerCapabilities } from "./routes.js";
import type { SandboxStatus } from "./verifySandbox.js";

export interface Heartbeat {
  at: string;
  github: boolean;
  credentialDecryption: boolean;
  sandbox: SandboxStatus;
  concurrency: number;
}

export const heartbeatPrefix = (instance: string): string => `shipflow:repopilot-worker:${instance}:`;

export interface KeyValueReader {
  keys(pattern: string): Promise<string[]>;
  get(key: string): Promise<string | null>;
}

export async function readCapabilities(redis: KeyValueReader, instance: string): Promise<WorkerCapabilities> {
  const keys = await redis.keys(`${heartbeatPrefix(instance)}*`);
  const beats: Heartbeat[] = [];

  for (const key of keys) {
    try {
      const raw = await redis.get(key);

      if (raw) beats.push(JSON.parse(raw) as Heartbeat);
    } catch {
      // A malformed heartbeat counts as no heartbeat.
    }
  }

  const sandboxes = beats.map((b) => b.sandbox);

  return {
    workers: beats.length,
    github: beats.some((b) => b.github === true),
    credentialDecryption: beats.some((b) => b.credentialDecryption === true),
    sandbox: sandboxes.includes("ready") ? "ready" : sandboxes.includes("unavailable") ? "unavailable" : "off",
  };
}
