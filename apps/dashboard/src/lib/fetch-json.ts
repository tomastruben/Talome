/**
 * The SWR fetcher for Talome's JSON API. It always throws on a failed
 * request: a non-2xx status, a body that isn't JSON, or a JSON `{ error }`
 * (spec §4.8: no skeleton or default may outlive a failed request).
 */
export class FetchJsonError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "FetchJsonError";
    this.status = status;
    this.body = body;
  }
}

function serverMessage(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const error = (body as { error?: unknown }).error;
  return typeof error === "string" && error ? error : null;
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "include", ...init });
  let body: unknown = null;
  let parsed = true;
  try {
    body = await res.json();
  } catch {
    parsed = false;
  }
  if (!res.ok) {
    throw new FetchJsonError(serverMessage(body) ?? `Request failed (${res.status})`, res.status, body);
  }
  if (!parsed) throw new FetchJsonError("The server sent a response Talome couldn't read.", res.status, null);
  const error = serverMessage(body);
  if (error) throw new FetchJsonError(error, res.status, body);
  return body as T;
}

/** HTTP status of a fetch failure, or null for a network error. */
export function fetchErrorStatus(error: unknown): number | null {
  return error instanceof FetchJsonError ? error.status : null;
}
