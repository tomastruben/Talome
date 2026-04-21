/**
 * Tool Registry — dynamic tool loading based on installed/configured apps.
 *
 * Each domain declares:
 * - `settingsKeys`: settings that indicate the app is configured (checked via OR — any key present = active)
 * - `tools`: the tool map for that domain
 * - `tier`: audit tier overrides for each tool
 *
 * Core tools (docker, system, apps, filesystem, etc.) are always loaded.
 * Domain tools (arr, qbt, jellyfin, etc.) are loaded only when the app is configured.
 *
 * This keeps the tool count low for the LLM while being scalable to many apps.
 */

import type { Tool } from "ai";
import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";

// ── Types ────────────────────────────────────────────────────────────────────

type ToolTier = "read" | "modify" | "destructive";

export interface ToolDomain {
  /** Human-readable domain name */
  name: string;
  /** If ANY of these settings keys have a value, the domain's tools are included */
  settingsKeys: string[];
  /** Map of tool_name → tool definition */
  tools: Record<string, Tool>;
  /** Audit tier for each tool */
  tiers: Record<string, ToolTier>;
  /** Optional sub-categories for tools within this domain (tool_name → category label) */
  categories?: Record<string, string>;
}

// ── Settings helper (cached to avoid N DB queries per message) ───────────────

let settingsCache: Map<string, boolean> | null = null;
let settingsCacheAt = 0;
const SETTINGS_CACHE_TTL_MS = 10_000;

function hasSetting(key: string): boolean {
  const now = Date.now();
  if (!settingsCache || now - settingsCacheAt > SETTINGS_CACHE_TTL_MS) {
    try {
      const rows = db.select().from(schema.settings).all();
      settingsCache = new Map(rows.map((r) => [r.key, !!r.value]));
      settingsCacheAt = now;
    } catch {
      return false;
    }
  }
  return settingsCache.get(key) ?? false;
}

/** Invalidate the settings cache (call after settings change). */
export function invalidateSettingsCache(): void {
  settingsCache = null;
}

// ── Domain registry ──────────────────────────────────────────────────────────

const domains: ToolDomain[] = [];

export function registerDomain(domain: ToolDomain): void {
  domains.push(domain);
}

/**
 * Returns all registered domains.
 */
export function getAllDomains(): readonly ToolDomain[] {
  return domains;
}

/**
 * Check which domains are currently active (have at least one settings key configured).
 * Returns the set of active domain names.
 */
export function getActiveDomainNames(): Set<string> {
  const active = new Set<string>();
  for (const domain of domains) {
    if (domain.settingsKeys.length === 0) {
      // No settings required = always active (core tools)
      active.add(domain.name);
      continue;
    }
    for (const key of domain.settingsKeys) {
      if (hasSetting(key)) {
        active.add(domain.name);
        break;
      }
    }
  }
  return active;
}

/**
 * Returns all tools from all registered domains (for MCP server, builtin name registration).
 */
export function getAllRegisteredTools(): Record<string, Tool> {
  const all: Record<string, Tool> = {};
  for (const domain of domains) {
    Object.assign(all, domain.tools);
  }
  return all;
}

/**
 * Returns only tools from active domains (for dashboard chat).
 */
export function getActiveRegisteredTools(): Record<string, Tool> {
  const activeDomains = getActiveDomainNames();
  const active: Record<string, Tool> = {};
  for (const domain of domains) {
    if (activeDomains.has(domain.name)) {
      Object.assign(active, domain.tools);
    }
  }
  return active;
}

// ── Per-message intelligent tool routing ──────────────────────────────────

/** Keywords that trigger loading a domain's tools for a chat message. */
const DOMAIN_KEYWORDS: Record<string, string[]> = {
  media: ["movie", "show", "series", "episode", "season", "library", "watch", "media", "sonarr", "radarr", "tmdb", "tvdb", "download", "subtitle"],
  arr: ["sonarr", "radarr", "prowlarr", "indexer", "quality profile", "root folder", "download client", "queue", "wanted", "missing", "cutoff", "grab", "release", "blocklist", "naming", "monitor"],
  qbittorrent: ["qbittorrent", "qbt", "torrent", "seed", "download speed", "upload speed", "ratio"],
  jellyfin: ["jellyfin", "transcode", "scan library", "media server", "stream", "playback"],
  overseerr: ["overseerr", "request", "approve", "decline"],
  plex: ["plex", "on deck", "recently watched", "mark watched"],
  homeassistant: ["home assistant", "hass", "entity", "smart home", "light", "switch", "sensor", "thermostat", "automation"],
  pihole: ["pihole", "pi-hole", "dns", "whitelist", "blacklist", "ad block", "blocked queries"],
  vaultwarden: ["vaultwarden", "bitwarden", "password", "vault", "credential"],
  proxy: ["proxy", "reverse proxy", "caddy", "route", "tls", "certificate", "domain", "https", "ssl"],
  tailscale: ["tailscale", "vpn", "remote access", "tailnet"],
  ollama: ["ollama", "llm", "local model", "pull model", "ai model"],
  audiobookshelf: ["audiobookshelf", "audiobook", "audiobooks", "narrator", "chapter", "bookmark", "listening"],
};

/**
 * Returns tools filtered by message relevance.
 * Always includes core + mdns domains. Other active domains are included
 * only if the message matches their keywords. If NO optional domain matches,
 * falls back to the full active tool set (catch-all for ambiguous messages).
 */
export function getToolsForMessage(message: string): Record<string, Tool> {
  const activeDomains = getActiveDomainNames();
  const lowerMessage = message.toLowerCase();

  const matchedDomains = new Set<string>();
  for (const domain of domains) {
    // Always include domains with no settings keys (core, mdns)
    if (domain.settingsKeys.length === 0) {
      matchedDomains.add(domain.name);
      continue;
    }
    if (!activeDomains.has(domain.name)) continue;

    const keywords = DOMAIN_KEYWORDS[domain.name];
    if (!keywords) {
      // Unknown domain with no keywords — include it (future-proofing)
      matchedDomains.add(domain.name);
      continue;
    }
    if (keywords.some((kw) => lowerMessage.includes(kw))) {
      matchedDomains.add(domain.name);
    }
  }

  // If only core/mdns matched, fall back to full active set (ambiguous message)
  const optionalMatched = [...matchedDomains].some(
    (name) => domains.find((d) => d.name === name)?.settingsKeys.length ?? 0 > 0,
  );
  if (!optionalMatched) {
    return getActiveRegisteredTools();
  }

  const tools: Record<string, Tool> = {};
  for (const domain of domains) {
    if (matchedDomains.has(domain.name)) {
      Object.assign(tools, domain.tools);
    }
  }
  return tools;
}

/**
 * Returns merged tier map from all domains.
 */
export function getAllTiers(): Record<string, ToolTier> {
  const tiers: Record<string, ToolTier> = {};
  for (const domain of domains) {
    Object.assign(tiers, domain.tiers);
  }
  return tiers;
}

export interface ToolMeta {
  name: string;
  tier: ToolTier;
  category: string;
  description?: string;
}

/**
 * Returns all tools with tier and category info.
 * For non-core domains, category defaults to the domain name.
 * For the core domain, uses the per-tool categories map.
 */
export function getAllToolMeta(): ToolMeta[] {
  const tools: ToolMeta[] = [];
  for (const domain of domains) {
    for (const [name, tool] of Object.entries(domain.tools)) {
      const tier = domain.tiers[name] ?? "read";
      const category = domain.categories?.[name] ?? domain.name;
      const description = (tool as { description?: string }).description;
      tools.push({ name, tier, category, description });
    }
  }
  return tools;
}
