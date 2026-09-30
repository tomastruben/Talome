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
  if (scopes.apps !== "all" && Object.hasOwn(APP_LIMITED_DENIED_TOOLS, meta.name)) {
    return deny(`This token is limited to specific apps, and '${meta.name}' ${APP_LIMITED_DENIED_TOOLS[meta.name]}.`);
  }
  return { ok: true };
}

/**
 * A terminal (host PTY) is an unrestricted shell, so only owner-equivalent
 * tokens may open one: destructive tier, all domains, all apps, no tool
 * allow-list, and run_shell not denied. Any narrowing of a token's grants
 * therefore also removes terminal access.
 */
export function allowsTerminalAccess(scopes: TokenScopes): boolean {
  if (scopes.maxTier !== "destructive") return false;
  if (scopes.domains !== "all" || scopes.apps !== "all") return false;
  if (scopes.tools && scopes.tools.length > 0) return false;
  if (scopes.deniedTools?.includes("run_shell")) return false;
  return true;
}

// ── App / resource targets ───────────────────────────────────────────────────

/**
 * Argument names that reference an app or container, per tool. Tools not
 * listed here fall back to GENERIC_TARGET_KEYS. `name` is deliberately NOT a
 * generic key: it means different things in different tools (network name,
 * automation name, store name, ...).
 */
const TOOL_TARGET_KEYS: Record<string, readonly string[]> = {
  // Joining another app's network reaches that app's containers.
  connect_container_to_network: ["container", "network"],
  disconnect_container: ["container", "network"],
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

/**
 * Argument names that hold a container name (vs. an app id). Only these may
 * match an allowed app by stack prefix (`<appId>-<svc>`); app-id arguments
 * must match exactly.
 */
const CONTAINER_KEYS = new Set(["containerId", "container_id", "containerIds", "container", "containerName", "network"]);

export type TargetKind = "app" | "container";

export interface CallTarget {
  value: string;
  kind: TargetKind;
}

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
 * Determine which apps/containers a call targets, and whether each one is an
 * app id or a container name. Returns null when the target cannot be
 * determined from the arguments.
 */
export function extractCallTargets(
  toolName: string,
  domain: string,
  args: Record<string, unknown>,
): CallTarget[] | null {
  const targets: CallTarget[] = [];

  const domainApps = DOMAIN_APP_TARGETS[domain];
  if (domainApps) return [{ value: domainApps[0], kind: "app" }];

  if (APP_ARG_DOMAINS.has(domain)) {
    if (typeof args.app === "string" && args.app.trim()) targets.push({ value: args.app.trim(), kind: "app" });
    else if (toolName.startsWith("prowlarr_")) targets.push({ value: "prowlarr", kind: "app" });
  }

  const keys = TOOL_TARGET_KEYS[toolName] ?? GENERIC_TARGET_KEYS;
  for (const key of keys) {
    if (!(key in args) || args[key] === undefined || args[key] === null) continue;
    const values: string[] = [];
    if (!collectStrings(args[key], values)) return null;
    const kind: TargetKind = CONTAINER_KEYS.has(key) ? "container" : "app";
    for (const value of values) targets.push({ value, kind });
  }

  // A proxy route publishes whatever its upstream points at.
  if (toolName === "proxy_add_route" && args.upstream !== undefined) {
    if (typeof args.upstream !== "string") return null;
    targets.push({ value: upstreamHost(args.upstream), kind: "container" });
  }
  // Umbrel dependencies wire the new app to other installed apps.
  if (toolName === "install_app" && args.umbrel && typeof args.umbrel === "object") {
    const deps = (args.umbrel as Record<string, unknown>).dependencies;
    if (deps !== undefined && deps !== null) {
      if (typeof deps !== "object" || Array.isArray(deps)) return null;
      for (const provider of Object.values(deps as Record<string, unknown>)) {
        if (typeof provider !== "string" || !provider.trim()) return null;
        targets.push({ value: provider.trim(), kind: "app" });
      }
    }
  }

  return targets.length > 0 ? targets : null;
}

/**
 * The host part of a proxy upstream ("jellyfin:8096", "http://jellyfin:8096/x").
 * Anything that is not a plain container name — localhost, an IP address, a
 * domain, userinfo — comes back as given, so it never matches an app.
 */
function upstreamHost(upstream: string): string {
  const trimmed = upstream.trim();
  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const authority = withoutScheme.split(/[/?#]/, 1)[0] ?? "";
  if (authority.includes("@") || authority.startsWith("[")) return trimmed;
  const host = authority.split(":", 1)[0] ?? "";
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(host) || host.toLowerCase() === "localhost") return trimmed;
  return host;
}

// ── Host reach for app-limited tokens ────────────────────────────────────────
// An app grant limits which app a call names — but some calls reach past the
// app through their other arguments. A token limited to apps never gets them.

/** Tools an app-limited token may not call at all, and why. */
const APP_LIMITED_DENIED_TOOLS: Record<string, string> = {
  exec_container:
    "runs arbitrary commands inside a container, which can reach the host through the container's mounts (e.g. docker.sock)",
  add_volume_mount: "bind-mounts a host path into the app",
};

/**
 * Why a call's other arguments reach beyond an app grant (host paths, backups
 * from elsewhere), or null. Only consulted for app-limited tokens.
 */
function hostReachReason(toolName: string, args: Record<string, unknown>): string | null {
  const present = (v: unknown) =>
    v !== undefined && v !== null && v !== "" && !(typeof v === "object" && Object.keys(v as object).length === 0);
  if (toolName === "install_app") {
    if (present(args.volumeMounts)) return "binds host paths (volumeMounts)";
    const umbrel = args.umbrel && typeof args.umbrel === "object" ? (args.umbrel as Record<string, unknown>) : {};
    if (present(umbrel.folders)) return "binds host folders (umbrel.folders)";
    if (present(umbrel.dataRoot)) return "chooses a host data folder (umbrel.dataRoot)";
    // Env overrides feed compose interpolation (e.g. APP_DATA_DIR in volumes):
    // a path there re-points the app's bind mounts at the host.
    if (args.env && typeof args.env === "object") {
      for (const [key, value] of Object.entries(args.env as Record<string, unknown>)) {
        if (typeof value !== "string" || /^\s*[/~]/.test(value) || value.includes("..") || value.includes("$")) {
          return `sets a path-like environment override (${key})`;
        }
      }
    }
  }
  if (toolName === "restore_app" && present(args.backupFile)) return "restores from a file path (backupFile)";
  return null;
}

/** Target values only (see extractCallTargets). */
export function extractTargets(
  toolName: string,
  domain: string,
  args: Record<string, unknown>,
): string[] | null {
  return extractCallTargets(toolName, domain, args)?.map((t) => t.value) ?? null;
}

function normalizeTarget(value: string): string {
  return value.trim().replace(/^\/+/, "").toLowerCase();
}

function isStackMember(container: string, appId: string): boolean {
  return container === appId || container.startsWith(`${appId}-`) || container.startsWith(`${appId}_`);
}

export interface TargetMatchOptions {
  /** "app" ids must match exactly; "container" names may match by stack prefix. */
  kind?: TargetKind;
  /**
   * Installed app ids. A container that belongs to a more specific installed
   * app (`nextcloud-aio-x` when `nextcloud-aio` is installed) never matches the
   * shorter app (`nextcloud`).
   */
  installedAppIds?: readonly string[];
}

/**
 * A target matches an allowed app when it is the app id itself (or a known
 * alias), or — for container names only — a container of that app's stack
 * (Talome names containers `<appId>` / `<appId>-<svc>` / `<appId>_<svc>`)
 * that no longer installed app id claims. Raw container hashes never match —
 * restricted tokens must address containers by name.
 */
export function targetMatchesApp(target: string, appId: string, options: TargetMatchOptions = {}): boolean {
  const t = normalizeTarget(target);
  const a = normalizeTarget(appId);
  if (!t || !a) return false;
  if (t === a) return true;
  for (const aliases of Object.values(DOMAIN_APP_TARGETS)) {
    if (aliases.includes(a) && aliases.includes(t)) return true;
  }
  if ((options.kind ?? "container") !== "container") return false;
  if (!isStackMember(t, a)) return false;
  const claimedByOther = (options.installedAppIds ?? []).some((raw) => {
    const other = normalizeTarget(raw);
    return other.length > a.length && other !== a && isStackMember(t, other);
  });
  return !claimedByOther;
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
  installedAppIds?: readonly string[],
): GrantDecision {
  const toolDecision = checkToolGrant(scopes, meta);
  if (!toolDecision.ok) return toolDecision;
  if (scopes.apps === "all") return { ok: true };

  const allowed = scopes.apps;
  const reach = hostReachReason(meta.name, args);
  if (reach) {
    return deny(`This token is limited to specific apps (${allowed.join(", ") || "none"}), and this '${meta.name}' call ${reach}.`);
  }
  const targets = extractCallTargets(meta.name, meta.domain, args);

  if (!targets) {
    if (meta.tier === "read") return { ok: true };
    return deny(
      `This token is limited to specific apps (${allowed.join(", ") || "none"}), and the target of '${meta.name}' could not be determined.`,
    );
  }

  const outside = targets.filter(
    (t) => !allowed.some((a) => targetMatchesApp(t.value, a, { kind: t.kind, installedAppIds })),
  );
  if (outside.length > 0) {
    return deny(
      `This token is not allowed to act on ${outside.map((t) => `'${t.value}'`).join(", ")} (allowed apps: ${allowed.join(", ") || "none"}).`,
    );
  }
  return { ok: true };
}

/**
 * Whether an app-limited token could ever pass checkCallGrant for this tool,
 * judged from the argument names its input schema accepts. Tools every call
 * would refuse — a bound app domain the token does not cover, or a
 * modify/destructive tool with no argument that can name a target — are
 * hidden from the token's tool list (routes/mcp.ts getMcpToolView). Errs on
 * the side of listing: checkCallGrant still decides every call.
 */
export function toolReachableForAppGrant(
  scopes: TokenScopes,
  meta: ToolGrantMeta,
  argKeys: readonly string[],
): boolean {
  if (scopes.apps === "all") return true;
  const allowed = scopes.apps;
  const domainApps = DOMAIN_APP_TARGETS[meta.domain];
  if (domainApps) {
    return allowed.some((a) => targetMatchesApp(domainApps[0], a, { kind: "app" }));
  }
  if (meta.tier === "read") return true;
  if (APP_ARG_DOMAINS.has(meta.domain)) return true;
  const keys: readonly string[] = TOOL_TARGET_KEYS[meta.name] ?? GENERIC_TARGET_KEYS;
  if (keys.some((k) => argKeys.includes(k))) return true;
  return meta.name === "proxy_add_route" && argKeys.includes("upstream");
}
