"use client";

import { useCallback, useEffect, useState } from "react";
import useSWR from "swr";
import { CORE_URL } from "@/lib/constants";
import { useVisibleInterval } from "@/lib/polling";
import { livePending, msUntil, type ApprovalItem, type TokenScopes } from "@/components/trust/format";

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

/**
 * Current time, re-read every `intervalMs` while `active` (for countdowns).
 * The tick pauses while the tab is hidden and catches up when it is shown.
 */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  const tick = useCallback(() => setNow(Date.now()), []);
  useVisibleInterval(tick, active ? intervalMs : null);
  return now;
}

/** Longest delay setTimeout accepts (~24.8 days). */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Current time, re-read once when `deadline` (ISO) passes while `active`.
 *
 * A single timeout instead of a per-second tick: a view can flip to
 * "expired" on time without re-rendering every second. Render a visible
 * countdown in a small child with `useNow` instead.
 */
export function useNowAtDeadline(deadline: string, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // Done once `now` is past the deadline; re-armed if a timer fired early
    // (or was clamped to the setTimeout maximum).
    if (!active || msUntil(deadline, now) <= 0) return;
    const id = setTimeout(() => setNow(Date.now()), Math.min(msUntil(deadline), MAX_TIMEOUT_MS));
    return () => clearTimeout(id);
  }, [deadline, active, now]);
  return now;
}

// ── MCP server address ───────────────────────────────────────────────────────

/**
 * The address agents use for Talome's MCP server. A configured core URL
 * (NEXT_PUBLIC_CORE_URL, set for reverse proxies and remapped ports) wins;
 * otherwise it is this page's own origin, which forwards /api to core. That
 * keeps the scheme and host the person actually reached Talome on (HTTPS
 * behind a proxy, a custom domain, Tailscale) instead of assuming :4000.
 */
export function mcpServerUrl(
  origin: string | undefined = typeof window !== "undefined" ? window.location.origin : undefined,
  configuredCoreUrl: string | undefined = process.env.NEXT_PUBLIC_CORE_URL,
): string {
  const base = (configuredCoreUrl || origin || "http://localhost:3000").replace(/\/+$/, "");
  return `${base}/api/mcp`;
}

/** Shorten a secret for display: the first and last 4 characters around dots. */
export function maskSecret(secret: string): string {
  if (secret.length <= 12) return "•".repeat(Math.max(secret.length, 8));
  return `${secret.slice(0, 4)}${"•".repeat(12)}${secret.slice(-4)}`;
}

/** Connection snippets with the token embedded, per client. */
export function mcpClientConfig(client: "cursor" | "claude-desktop", url: string, token: string): string {
  const server = client === "claude-desktop"
    ? { type: "http", url, headers: { Authorization: `Bearer ${token}` } }
    : { url, headers: { Authorization: `Bearer ${token}` } };
  return JSON.stringify({ mcpServers: { talome: server } }, null, 2);
}
