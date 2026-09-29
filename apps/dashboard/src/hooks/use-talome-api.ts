import { CORE_URL } from "@/lib/constants";

/**
 * Error thrown by talomeFetch for non-2xx responses. `message` keeps the
 * server's `error` string (plus the error id) as before; `status` and the
 * parsed `body` let callers react to specific responses such as a 409
 * operation conflict.
 */
export class TalomeApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "TalomeApiError";
    this.status = status;
    this.body = body;
  }
}

export async function talomeFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${CORE_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    let message = `API error: ${res.status} ${res.statusText}`;
    let body: unknown = null;
    try {
      body = await res.json();
      const parsed = body as { error?: unknown; errorId?: unknown } | null;
      if (typeof parsed?.error === "string" && parsed.error) message = parsed.error;
      if (parsed?.errorId) message += ` · ID: ${String(parsed.errorId)}`;
    } catch {
      // non-JSON error body — keep default message
    }
    throw new TalomeApiError(message, res.status, body);
  }
  return res.json();
}

export async function talomePost<T>(path: string, body?: unknown): Promise<T> {
  return talomeFetch<T>(path, {
    method: "POST",
    body: body ? JSON.stringify(body) : undefined,
  });
}

export async function talomeDelete<T>(path: string): Promise<T> {
  return talomeFetch<T>(path, { method: "DELETE" });
}

export async function talomePatch<T>(path: string, body?: unknown): Promise<T> {
  return talomeFetch<T>(path, {
    method: "PATCH",
    body: body ? JSON.stringify(body) : undefined,
  });
}
