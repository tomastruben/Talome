import { CORE_URL } from "@/lib/constants";

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
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
      if (body?.errorId) message += ` · ID: ${body.errorId}`;
    } catch {
      // non-JSON error body — keep default message
    }
    throw new Error(message);
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
