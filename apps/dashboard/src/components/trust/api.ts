"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { CORE_URL } from "@/lib/constants";
import { livePending, type ApprovalItem, type TokenScopes } from "@/components/trust/format";

export const MCP_TOKENS_URL = `${CORE_URL}/api/integrations/mcp/tokens`;
export const MCP_CATALOG_URL = `${CORE_URL}/api/integrations/mcp/tokens/catalog`;
export const APPROVALS_URL = `${CORE_URL}/api/approvals`;
export const AUDIT_LOG_URL = `${CORE_URL}/api/audit-log`;

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as { error: unknown }).error;
    if (typeof err === "string") return err;
    if (err && typeof err === "object") {
      const flat = err as { formErrors?: string[]; fieldErrors?: Record<string, string[] | undefined> };
      const first = flat.formErrors?.[0] ?? Object.values(flat.fieldErrors ?? {}).flat()[0];
      if (first) return first;
    }
  }
  return fallback;
}

export async function trustFetcher<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "include" });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new HttpError(errorMessage(body, `Request failed (${res.status})`), res.status);
  return body as T;
}

async function send<T>(url: string, method: "POST" | "PATCH" | "DELETE", payload?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: "include",
    headers: payload === undefined ? undefined : { "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok || (body && typeof body === "object" && (body as { ok?: unknown }).ok === false)) {
    throw new HttpError(errorMessage(body, `Request failed (${res.status})`), res.status);
  }
  return body as T;
}

// ── MCP tokens ───────────────────────────────────────────────────────────────

export interface CreatedToken {
  id: string;
  name: string;
  token: string;
  scopes: TokenScopes;
  expiresAt: string | null;
}

export function createMcpToken(input: {
  name: string;
  scopes: TokenScopes;
  expiresInDays: number | null;
}): Promise<CreatedToken> {
  return send<CreatedToken>(MCP_TOKENS_URL, "POST", {
    name: input.name,
    scopes: input.scopes,
    ...(input.expiresInDays === null ? { expiresAt: null } : { expiresInDays: input.expiresInDays }),
  });
}

export function updateMcpToken(
  id: string,
  input: { scopes?: TokenScopes; expiresAt?: string | null },
): Promise<unknown> {
  return send(`${MCP_TOKENS_URL}/${encodeURIComponent(id)}`, "PATCH", input);
}

export function revokeMcpToken(id: string): Promise<unknown> {
  return send(`${MCP_TOKENS_URL}/${encodeURIComponent(id)}`, "DELETE");
}

// ── Approvals ────────────────────────────────────────────────────────────────

export function decideApproval(id: string, decision: "approve" | "deny"): Promise<{ ok: true; approval: ApprovalItem }> {
  return send(`${APPROVALS_URL}/${encodeURIComponent(id)}/${decision}`, "POST");
}

/**
 * Live pending approvals for the current admin. Pass `enabled: false` for
 * members (the endpoint is admin-only) to skip the request entirely.
 */
export function usePendingApprovals(enabled: boolean, refreshInterval = 15_000) {
  const { data, error, isLoading, mutate } = useSWR<ApprovalItem[]>(
    enabled ? `${APPROVALS_URL}?status=pending&limit=100` : null,
    trustFetcher,
    { refreshInterval, revalidateOnFocus: true },
  );
  const pending = livePending(data);
  return { pending, count: pending.length, error, isLoading, mutate };
}

/** Current time, re-read every `intervalMs` while `active` (for countdowns). */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const tick = () => setNow(Date.now());
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return now;
}
