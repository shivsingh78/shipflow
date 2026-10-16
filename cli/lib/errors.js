// Errors shared by the CLI commands.

/** Bad arguments or answers; the CLI exits with code 2. */
export class UsageError extends Error {}

/**
 * An operation failed for a reason the user can act on (AWS, SSH, ShipFlow
 * server). `exitCode` follows the CLI's exit codes: 1 failed, 2 usage,
 * 3 unreachable/unauthorized. Messages must never contain secrets.
 */
export class CloudError extends Error {
  constructor(message, { exitCode = 1, hint } = {}) {
    super(message);
    this.name = "CloudError";
    this.exitCode = exitCode;
    this.hint = hint;
  }
}
