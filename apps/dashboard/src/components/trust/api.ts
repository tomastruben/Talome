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

function isLoopbackHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\./.test(host);
  } catch {
    return false;
  }
}

function isAbsoluteHttpUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The address agents on other machines use for Talome's MCP server. It is
 * this page's own origin, which forwards /api to core: that keeps the scheme
 * and host the person actually reached Talome on (HTTPS behind a proxy, a
 * custom domain, Tailscale, a LAN address). A configured core URL
 * (NEXT_PUBLIC_CORE_URL) wins only when another machine could use it: the
 * documented default http://localhost:4000 is skipped when the page was
 * reached on a real host. A trailing /api on it is dropped, so a proxy base
 * such as https://talome.example.com/api doesn't become /api/api/mcp.
 */
export function mcpServerUrl(
  origin: string | undefined = typeof window !== "undefined" ? window.location.origin : undefined,
  configuredCoreUrl: string | undefined = process.env.NEXT_PUBLIC_CORE_URL,
): string {
  const configured = configuredCoreUrl?.trim().replace(/\/+$/, "").replace(/\/api$/, "");
  const useConfigured =
    !!configured &&
    isAbsoluteHttpUrl(configured) &&
    (!origin || !isLoopbackHost(configured) || isLoopbackHost(origin));
  const base = (useConfigured ? configured : origin || "http://localhost:3000").replace(/\/+$/, "");
  return `${base}/api/mcp`;
}

/** Shorten a secret for display: the first and last 4 characters around dots. */
export function maskSecret(secret: string): string {
  if (secret.length <= 12) return "•".repeat(Math.max(secret.length, 8));
  return `${secret.slice(0, 4)}${"•".repeat(12)}${secret.slice(-4)}`;
}

export type McpClient = "claude-code" | "claude-desktop" | "cursor";

/**
 * Connection snippets, per client, with the token embedded (or a placeholder).
 * Claude Code (.mcp.json) and Cursor (.cursor/mcp.json) speak HTTP with
 * headers directly. Claude Desktop's claude_desktop_config.json only starts
 * local (stdio) servers, so it reaches Talome through the mcp-remote bridge;
 * the token travels in an env var so it never sits inside the command line.
 */
export function mcpClientConfig(client: McpClient, url: string, token: string): string {
  const authorization = `Bearer ${token}`;
  let server: Record<string, unknown>;
  if (client === "claude-desktop") {
    const args = ["-y", "mcp-remote", url, "--header", "Authorization:${TALOME_AUTH}"];
    // mcp-remote refuses plain HTTP to anything but localhost unless told otherwise.
    if (url.startsWith("http:") && !isLoopbackHost(url)) args.push("--allow-http");
    server = { command: "npx", args, env: { TALOME_AUTH: authorization } };
  } else if (client === "claude-code") {
    server = { type: "http", url, headers: { Authorization: authorization } };
  } else {
    server = { url, headers: { Authorization: authorization } };
  }
  return JSON.stringify({ mcpServers: { talome: server } }, null, 2);
}

/** Where each client's snippet goes, for labels. */
export const MCP_CLIENT_FILES: Record<McpClient, { name: string; file: string }> = {
  "claude-code": { name: "Claude Code", file: ".mcp.json" },
  "claude-desktop": { name: "Claude Desktop", file: "claude_desktop_config.json" },
  cursor: { name: "Cursor", file: ".cursor/mcp.json" },
};
