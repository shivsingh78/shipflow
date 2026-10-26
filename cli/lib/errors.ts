// Errors shared by the CLI commands.

/** Bad arguments or answers; the CLI exits with code 2. */
export class UsageError extends Error {}

/**
 * An operation failed for a reason the user can act on (AWS, SSH, ShipFlow
 * server). `exitCode` follows the CLI's exit codes: 1 failed, 2 usage,
 * 3 unreachable/unauthorized. Messages must never contain secrets.
 */
export class CloudError extends Error {
  exitCode: number;
  hint: string | undefined;

  constructor(
    message: string,
    { exitCode = 1, hint }: { exitCode?: number; hint?: string | undefined } = {}
  ) {
    super(message);
    this.name = "CloudError";
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

/** The message of a caught value (catch variables are `unknown`). */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The `code` property of a caught value (Node and AWS SDK errors carry one). */
export function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

/**
 * A value as text for validation: strings pass through, other primitives are
 * stringified, and null, undefined and objects become "".
 */
export function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return "";
}
