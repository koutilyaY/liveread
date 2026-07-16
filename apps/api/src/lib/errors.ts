/** Structured API error with a stable machine-readable code. */
export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const Errors = {
  unauthorized: () =>
    new ApiError(401, "unauthorized", "Authentication required."),
  forbidden: () =>
    new ApiError(403, "forbidden", "You do not have access to this resource."),
  notFound: (what = "Resource") =>
    new ApiError(404, "not_found", `${what} not found.`),
  conflict: (message: string) => new ApiError(409, "conflict", message),
  invalid: (message: string, details?: unknown) =>
    new ApiError(400, "invalid_request", message, details),
  tooMany: (message = "Too many requests. Please slow down.") =>
    new ApiError(429, "rate_limited", message),
  gone: (message: string) => new ApiError(410, "gone", message),
  locked: (message: string) => new ApiError(423, "locked", message),
};
