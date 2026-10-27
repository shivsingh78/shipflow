export interface ApiIssue {
  path?: string;
  message: string;
}

/** An error response from the ShipFlow API, or a failure to reach it. */
export class ApiError extends Error {
  readonly status: number;
  readonly issues: ApiIssue[];

  constructor(message: string, status = 0, issues: ApiIssue[] = []) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.issues = issues;
  }

  get isAuth(): boolean {
    return this.status === 401;
  }

  get isNetwork(): boolean {
    return this.status === 0;
  }
}

/** A message that is safe and useful to show to the user. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.isNetwork) return "Cannot reach the ShipFlow API. Check that the server is running and reachable.";
    if (error.status === 401) return "The API token was rejected. Sign in again.";
    return error.message;
  }

  return error instanceof Error ? error.message : "Something went wrong.";
}
