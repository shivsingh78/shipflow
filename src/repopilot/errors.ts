/** A stage failure with a stable code and an explicit retry decision. */
export class StageError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false
  ) {
    super(message);
    this.name = "StageError";
  }
}
