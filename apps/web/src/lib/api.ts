export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly correlationId?: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    credentials: "include",
    headers: {
      ...(init.body && typeof init.body === "string"
        ? { "content-type": "application/json" }
        : {}),
      ...init.headers,
    },
    ...init,
  });
  if (!res.ok) {
    let code = "request_failed";
    let message = `Request failed (${res.status}).`;
    let correlationId: string | undefined;
    let details: unknown;
    try {
      const body = (await res.json()) as {
        error?: { code?: string; message?: string; details?: unknown };
        correlationId?: string;
      };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
      correlationId = body.correlationId;
      details = body.error?.details;
    } catch {
      // non-JSON error body
    }
    throw new ApiRequestError(
      res.status,
      code,
      message,
      correlationId,
      details,
    );
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return (await res.json()) as T;
  }
  return (await res.text()) as unknown as T;
}

export function wsUrl(path: string): string {
  return API_URL.replace(/^http/, "ws") + path;
}
