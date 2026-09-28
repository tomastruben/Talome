/**
 * Per-token grants for MCP (and any other non-owner actor).
 *
 * Unlike a single global grant set, every token carries its own scopes:
 *   - maxTier:     highest tool tier it may call (read < modify < destructive)
 *   - domains:     "all" or a list of tool domains (core, arr, jellyfin, ...)
 *   - tools:       optional allow-list of tool names (narrows further)
 *   - deniedTools: optional deny-list (always wins)
 *   - apps:        "all" or a list of app ids the token may act on
 *
 * Checks run twice: when the tool list is built (only authorized tools are
 * listed to the client) and again on every call (defense in depth), where the
 * app/resource restriction is evaluated against the actual arguments.
 */

import { z } from "zod";

export type ToolTier = "read" | "modify" | "destructive";

export const TIER_RANK: Record<ToolTier, number> = { read: 0, modify: 1, destructive: 2 };

export const toolTierSchema = z.enum(["read", "modify", "destructive"]);

const nameList = z.array(z.string().trim().min(1).max(128)).max(500);

export const tokenScopesSchema = z.object({
  maxTier: toolTierSchema,
  domains: z.union([z.literal("all"), z.array(z.string().trim().min(1).max(64)).max(100)]),
  tools: nameList.optional(),
  deniedTools: nameList.optional(),
  apps: z.union([z.literal("all"), z.array(z.string().trim().min(1).max(128)).max(200)]),
});

export type TokenScopes = z.infer<typeof tokenScopesSchema>;

/** Default for newly created tokens: read-only across everything. */
export const READ_ONLY_SCOPES: TokenScopes = { maxTier: "read", domains: "all", apps: "all" };

/** Owner-equivalent access (legacy tokens, local stdio). */
export const FULL_ACCESS_SCOPES: TokenScopes = { maxTier: "destructive", domains: "all", apps: "all" };

/**
 * Parse scopes stored as JSON. Anything missing or malformed falls back to
 * read-only — a broken row must never widen access.
 */
export function parseTokenScopes(raw: string | null | undefined): TokenScopes {
  if (!raw) return READ_ONLY_SCOPES;
  try {
    const parsed = tokenScopesSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : READ_ONLY_SCOPES;
  } catch {
    return READ_ONLY_SCOPES;
  }
}

export interface ToolGrantMeta {
  name: string;
  tier: ToolTier;
  domain: string;
}

export type GrantDecision =
  | { ok: true }
  | { ok: false; code: "forbidden"; message: string; hint: string };

const GRANT_HINT = "Grant it in Settings -> AI agents (MCP tokens).";

function deny(message: string): GrantDecision {
  return { ok: false, code: "forbidden", message, hint: GRANT_HINT };
}

/**
 * Tool-level check (no arguments): tier, domain, allow/deny lists.
 * Used to decide which tools are listed to a client, and as the first half of
 * the per-call check.
 */
export function checkToolGrant(scopes: TokenScopes, meta: ToolGrantMeta): GrantDecision {
  if (scopes.deniedTools?.includes(meta.name)) {
    return deny(`This token is not allowed to call '${meta.name}'.`);
  }
  if (scopes.tools && scopes.tools.length > 0 && !scopes.tools.includes(meta.name)) {
    return deny(`'${meta.name}' is not in this token's tool allow-list.`);
  }
  if (scopes.domains !== "all" && !scopes.domains.includes(meta.domain)) {
    return deny(`This token has no access to the '${meta.domain}' tool domain.`);
  }
  if (TIER_RANK[meta.tier] > TIER_RANK[scopes.maxTier]) {
    return deny(`This token lacks the '${meta.tier}' tier (it is limited to '${scopes.maxTier}').`);
  }
  return { ok: true };
}

// ── App / resource targets ───────────────────────────────────────────────────

/**
 * Argument names that reference an app or container, per tool. Tools not
 * listed here fall back to GENERIC_TARGET_KEYS. `name` is deliberately NOT a
 * generic key: it means different things in different tools (network name,
 * automation name, store name, ...).
 */
const TOOL_TARGET_KEYS: Record<string, readonly string[]> = {
  connect_container_to_network: ["container"],
  disconnect_container: ["container"],
  wire_apps: ["sourceAppId", "targetAppId"],
  test_app_connectivity: ["sourceAppId", "targetAppId"],
  create_group: ["appIds"],
  bulk_app_action: ["appIds"],
  bulk_update_apps: ["appIds"],
  analyze_service_health: ["containerIds"],
};

const GENERIC_TARGET_KEYS = [
  "appId",
  "app_id",
  "appIds",
  "containerId",
  "container_id",
  "containerIds",
  "container",
  "containerName",
  "stackId",
  "stack_id",
] as const;

/**
 * Tool domains that are bound to one app: every tool in the domain acts on
 * that app, so its id is the target even when no argument names it.
 */
const DOMAIN_APP_TARGETS: Record<string, readonly string[]> = {
  qbittorrent: ["qbittorrent"],
  jellyfin: ["jellyfin"],
  audiobookshelf: ["audiobookshelf"],
  overseerr: ["overseerr"],
  plex: ["plex"],
  homeassistant: ["homeassistant", "home-assistant"],
  pihole: ["pihole", "pi-hole"],
  vaultwarden: ["vaultwarden"],
  ollama: ["ollama"],
};

/** Arr-domain tools take `app: "sonarr" | "radarr" | ...`, which is the target app. */
const APP_ARG_DOMAINS = new Set(["arr"]);

function collectStrings(value: unknown, out: string[]): boolean {
  if (typeof value === "string") {
    if (value.trim()) out.push(value.trim());
    return true;
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      if (typeof v !== "string" || !v.trim()) return false;
      out.push(v.trim());
    }
    return value.length > 0;
  }
  return false;
}

/**
 * Determine which apps/containers a call targets.
 * Returns null when the target cannot be determined from the arguments.
 */
export function extractTargets(
  toolName: string,
  domain: string,
  args: Record<string, unknown>,
): string[] | null {
  const targets: string[] = [];

  const domainApps = DOMAIN_APP_TARGETS[domain];
  if (domainApps) return [domainApps[0]];

  if (APP_ARG_DOMAINS.has(domain)) {
    if (typeof args.app === "string" && args.app.trim()) targets.push(args.app.trim());
    else if (toolName.startsWith("prowlarr_")) targets.push("prowlarr");
  }

  const keys = TOOL_TARGET_KEYS[toolName] ?? GENERIC_TARGET_KEYS;
  for (const key of keys) {
    if (!(key in args) || args[key] === undefined || args[key] === null) continue;
    if (!collectStrings(args[key], targets)) return null;
  }

  return targets.length > 0 ? targets : null;
}

function normalizeTarget(value: string): string {
  return value.trim().replace(/^\/+/, "").toLowerCase();
}

/**
 * A target matches an allowed app when it is the app id itself or a container
 * of that app's stack (Talome names containers `<appId>` / `<appId>-<svc>` /
 * `<appId>_<svc>`). Raw container hashes never match — restricted tokens must
 * address containers by name.
 */
export function targetMatchesApp(target: string, appId: string): boolean {
  const t = normalizeTarget(target);
  const a = normalizeTarget(appId);
  if (!t || !a) return false;
  if (t === a) return true;
  for (const aliases of Object.values(DOMAIN_APP_TARGETS)) {
    if (aliases.includes(a) && aliases.includes(t)) return true;
  }
  return t.startsWith(`${a}-`) || t.startsWith(`${a}_`);
}

/**
 * Full per-call check: tool-level grant plus app/resource restriction.
 * Conservative default: when the token is app-restricted and the call is a
 * modify/destructive tool whose target cannot be determined, deny.
 */
export function checkCallGrant(
  scopes: TokenScopes,
  meta: ToolGrantMeta,
  args: Record<string, unknown>,
): GrantDecision {
  const toolDecision = checkToolGrant(scopes, meta);
  if (!toolDecision.ok) return toolDecision;
  if (scopes.apps === "all") return { ok: true };

  const allowed = scopes.apps;
  const targets = extractTargets(meta.name, meta.domain, args);

  if (!targets) {
    if (meta.tier === "read") return { ok: true };
    return deny(
      `This token is limited to specific apps (${allowed.join(", ") || "none"}), and the target of '${meta.name}' could not be determined.`,
    );
  }

  const outside = targets.filter((t) => !allowed.some((a) => targetMatchesApp(t, a)));
  if (outside.length > 0) {
    return deny(
      `This token is not allowed to act on ${outside.map((t) => `'${t}'`).join(", ")} (allowed apps: ${allowed.join(", ") || "none"}).`,
    );
  }
  return { ok: true };
}
