/**
 * Per-token MCP permissions.
 *
 * Each MCP token carries its own scope instead of sharing one device-wide grant:
 * a ceiling on how risky its tools may be, which tool domains it can see, and
 * which apps it may act on.
 */

import { z } from "zod";

export type ToolTier = "read" | "modify" | "destructive";

const TIER_RANK: Record<ToolTier, number> = { read: 0, modify: 1, destructive: 2 };

export const mcpTokenScopeSchema = z.object({
  /** Highest tier this token may call: read-only, read + change, or everything */
  maxTier: z.enum(["read", "modify", "destructive"]),
  /** Tool domains (e.g. "core", "arr", "jellyfin") the token can see, or all */
  domains: z.union([z.literal("*"), z.array(z.string().min(1).max(64)).max(64)]),
  /** App ids the token may target, or all */
  apps: z.union([z.literal("*"), z.array(z.string().min(1).max(128)).max(200)]),
});

export type McpTokenScope = z.infer<typeof mcpTokenScopeSchema>;

/** Default for new tokens: can look at everything, change nothing. */
export const DEFAULT_TOKEN_SCOPE: McpTokenScope = { maxTier: "read", domains: "*", apps: "*" };

/** Parse a stored scope. Missing or malformed scopes fall back to read-only. */
export function parseTokenScope(raw: string | null | undefined): McpTokenScope {
  if (!raw) return DEFAULT_TOKEN_SCOPE;
  try {
    const parsed = mcpTokenScopeSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : DEFAULT_TOKEN_SCOPE;
  } catch {
    return DEFAULT_TOKEN_SCOPE;
  }
}

/** Whether a tool should be listed for a token at all. */
export function isToolInScope(scope: McpTokenScope, tier: ToolTier, domain: string | undefined): boolean {
  if (TIER_RANK[tier] > TIER_RANK[scope.maxTier]) return false;
  if (scope.domains !== "*" && (!domain || !scope.domains.includes(domain))) return false;
  return true;
}

/** Argument names tools use to name the app they act on. */
const APP_ARG_KEYS = ["appId", "app_id", "appIds", "app_ids"] as const;
/** Argument names tools use to name a container. */
const CONTAINER_ARG_KEYS = ["containerId", "container", "containerName"] as const;

/** Maps a container name or id to the app that owns it, or null when unknown. */
export type ContainerResolver = (containerRef: string) => string | null;

function stringsOf(value: unknown): string[] {
  if (typeof value === "string" && value) return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string" && v.length > 0);
  return [];
}

/**
 * App ids a tool call targets: named directly, or through a container it names.
 * A container that can't be matched to an app yields a `container:<ref>` marker,
 * which never matches a granted app — unknown containers are outside any grant.
 */
export function targetAppIds(args: Record<string, unknown>, resolveContainer?: ContainerResolver): string[] {
  const ids: string[] = [];
  for (const key of APP_ARG_KEYS) ids.push(...stringsOf(args[key]));
  if (resolveContainer) {
    for (const key of CONTAINER_ARG_KEYS) {
      for (const ref of stringsOf(args[key])) ids.push(resolveContainer(ref) ?? `container:${ref}`);
    }
  }
  return ids;
}

export type ScopeDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * Check one call against a token's scope.
 *
 * App restrictions: any call that names an app must name only granted apps.
 * A call that changes something (modify/destructive) under an app restriction
 * must name an app — tools that act server-wide are refused.
 */
export function checkTokenScope(
  scope: McpTokenScope,
  toolName: string,
  tier: ToolTier,
  domain: string | undefined,
  args: Record<string, unknown>,
  resolveContainer?: ContainerResolver,
): ScopeDecision {
  if (TIER_RANK[tier] > TIER_RANK[scope.maxTier]) {
    return {
      allowed: false,
      reason: `This token is limited to ${scope.maxTier === "read" ? "read-only" : "read and modify"} tools; ${toolName} is ${tier}. An admin can widen the token's access in Settings > MCP.`,
    };
  }
  if (scope.domains !== "*" && (!domain || !scope.domains.includes(domain))) {
    return {
      allowed: false,
      reason: `This token has no access to the ${domain ?? "unknown"} tools (${toolName}). Granted domains: ${scope.domains.join(", ") || "none"}.`,
    };
  }
  if (scope.apps !== "*") {
    const targets = targetAppIds(args, resolveContainer);
    const outside = targets.filter((id) => !(scope.apps as string[]).includes(id));
    if (outside.length > 0) {
      return {
        allowed: false,
        reason: `This token may only act on: ${scope.apps.join(", ") || "no apps"}. ${toolName} targets ${outside.join(", ")}.`,
      };
    }
    if (tier !== "read" && targets.length === 0) {
      return {
        allowed: false,
        reason: `This token is restricted to specific apps, and ${toolName} does not target a single app, so it cannot run with this token.`,
      };
    }
  }
  return { allowed: true };
}
