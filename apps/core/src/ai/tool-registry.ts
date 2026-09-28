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
 * Dashboard chat narrows further: only the "base" domains (no settings keys and
 * not marked `onDemand`) are always sent to the model. Every other active domain
 * joins a conversation when its keywords appear, when its tools were used earlier
 * in the conversation, or when the model asks for it via `discover_tools`
 * (see tool-discovery.ts). Tool order is deterministic (base domains first, then
 * domain name, then tool name) so the provider's prompt cache survives turns.
 *
 * This keeps the tool count low for the LLM while being scalable to many apps.
 */

import type { Tool } from "ai";
import { db, schema } from "../db/index.js";

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
  /**
   * Chat routing only: a domain without settings keys is normally part of the
   * always-on base set. `onDemand: true` keeps it active (MCP, automations) but
   * loads it into a chat conversation only when routed (keywords, prior use,
   * discover_tools).
   */
  onDemand?: boolean;
  /** Extra chat-routing keywords, merged with the built-in keyword table. */
  keywords?: string[];
  /** One-line summary shown by discover_tools. */
  summary?: string;
}

/** A slice of a domain's tools that is split out into its own on-demand domain. */
export interface OnDemandGroup {
  name: string;
  summary: string;
  keywords: string[];
  tools: string[];
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
let toolDomainIndex: Map<string, string> | null = null;

export function registerDomain(domain: ToolDomain): void {
  domains.push(domain);
  toolDomainIndex = null;
  domainPatternCache.clear();
  textMatchCache.clear();
}

function pick<T>(source: Record<string, T> | undefined, names: ReadonlySet<string>, keep: boolean): Record<string, T> {
  const out: Record<string, T> = {};
  if (!source) return out;
  for (const [key, value] of Object.entries(source)) {
    if (names.has(key) === keep) out[key] = value;
  }
  return out;
}

/**
 * Register `domain`, splitting the tools named in `groups` out into separate
 * on-demand domains. Tiers and categories travel with each tool, so audit
 * tiers, the MCP tool list and the settings tool browser are unchanged —
 * only chat routing sees the split.
 */
export function registerDomainWithOnDemandGroups(domain: ToolDomain, groups: OnDemandGroup[]): void {
  const moved = new Set<string>();
  const groupDomains: ToolDomain[] = [];
  for (const group of groups) {
    const names = new Set<string>();
    for (const name of group.tools) {
      if (!(name in domain.tools)) {
        console.warn(`[tool-registry] on-demand group "${group.name}" lists unknown tool "${name}" — skipped`);
        continue;
      }
      if (moved.has(name)) {
        console.warn(`[tool-registry] tool "${name}" is listed in more than one on-demand group — skipped`);
        continue;
      }
      names.add(name);
      moved.add(name);
    }
    groupDomains.push({
      name: group.name,
      settingsKeys: domain.settingsKeys,
      tools: pick(domain.tools, names, true),
      tiers: pick(domain.tiers, names, true),
      categories: pick(domain.categories, names, true),
      onDemand: true,
      keywords: group.keywords,
      summary: group.summary,
    });
  }

  registerDomain({
    ...domain,
    tools: pick(domain.tools, moved, false),
    tiers: pick(domain.tiers, moved, false),
    categories: domain.categories ? pick(domain.categories, moved, false) : undefined,
  });
  for (const groupDomain of groupDomains) registerDomain(groupDomain);
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

// ── Per-conversation tool routing ────────────────────────────────────────────

/** Keywords that trigger loading a domain's tools for a chat message. */
const DOMAIN_KEYWORDS: Record<string, string[]> = {
  media: ["movie", "tv show", "tv", "series", "episode", "season", "library", "watch", "media", "sonarr", "radarr", "tmdb", "tvdb", "download", "downloading", "subtitle", "film", "anime", "documentary"],
  optimization: ["optimize", "optimise", "optimization", "optimisation", "transcode", "codec", "hevc", "h265", "h.265", "x265", "av1", "bitrate", "compress", "re-encode", "reencode", "library health", "file size"],
  arr: ["sonarr", "radarr", "readarr", "prowlarr", "indexer", "quality profile", "root folder", "download client", "queue", "wanted", "missing", "cutoff", "grab", "release", "blocklist", "naming", "monitored", "unmonitor"],
  qbittorrent: ["qbittorrent", "qbt", "torrent", "seed", "seeding", "download speed", "upload speed", "ratio"],
  jellyfin: ["jellyfin", "transcode", "scan library", "media server", "stream", "streaming", "playback"],
  overseerr: ["overseerr", "jellyseerr", "request", "approve", "decline"],
  plex: ["plex", "on deck", "recently watched", "mark watched"],
  homeassistant: ["home assistant", "hass", "entity", "entities", "smart home", "light", "light switch", "sensor", "thermostat"],
  pihole: ["pihole", "pi-hole", "dns", "whitelist", "blacklist", "ad block", "adblock", "blocked queries"],
  vaultwarden: ["vaultwarden", "bitwarden", "password manager", "vault", "credential"],
  proxy: ["proxy", "reverse proxy", "caddy", "route", "tls", "certificate", "domain", "https", "ssl"],
  tailscale: ["tailscale", "vpn", "remote access", "tailnet", "remotely"],
  ollama: ["ollama", "llm", "local model", "pull model", "ai model", "local ai"],
  audiobookshelf: ["audiobookshelf", "audiobook", "narrator", "chapter", "bookmark", "listening", "podcast"],
};

const keywordPatternCache = new Map<string, RegExp>();
/** One combined pattern per domain (all of its keywords), rebuilt when domains change. */
const domainPatternCache = new Map<string, RegExp>();

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Regex source for one keyword plus its common inflections: "movie" also
 * matches "movies", and a consonant + y ending also matches -ies / -ied / -ying
 * ("library" → "libraries").
 */
function keywordSource(keyword: string): string {
  const lower = keyword.toLowerCase();
  if (/[^aeiou\s]y$/.test(lower)) {
    return `${escapeRegExp(lower.slice(0, -1))}(?:y|ies|ied|ying)`;
  }
  return `${escapeRegExp(lower)}(?:s|es|ing|ed|er|ers)?`;
}

/** Whole-word boundary wrapper shared by the single- and multi-keyword patterns. */
function wholeWord(source: string): RegExp {
  return new RegExp(`(?:^|[^a-z0-9])(?:${source})(?=$|[^a-z0-9])`);
}

/**
 * Whole-word match with common suffixes, so "movie" matches "movies" but
 * "light" no longer matches "highlight" and "tv" no longer matches "activity".
 */
function keywordPattern(keyword: string): RegExp {
  let pattern = keywordPatternCache.get(keyword);
  if (!pattern) {
    pattern = wholeWord(keywordSource(keyword));
    keywordPatternCache.set(keyword, pattern);
  }
  return pattern;
}

export function textMatchesKeyword(text: string, keyword: string): boolean {
  return keywordPattern(keyword).test(text.toLowerCase());
}

/** True when already-lowercased `lowerText` contains any of `keywords` as a whole word. */
export function lowerTextMatchesAnyKeyword(lowerText: string, keywords: readonly string[]): boolean {
  return keywords.some((kw) => keywordPattern(kw).test(lowerText));
}

function domainPattern(domain: ToolDomain): RegExp {
  let pattern = domainPatternCache.get(domain.name);
  if (!pattern) {
    // Longest first so a multi-word keyword wins over its first word.
    const sources = getDomainKeywords(domain)
      .sort((a, b) => b.length - a.length)
      .map(keywordSource);
    pattern = wholeWord(sources.join("|"));
    domainPatternCache.set(domain.name, pattern);
  }
  return pattern;
}

/** All routing keywords for a domain: its own list, the built-in table, and its name. */
export function getDomainKeywords(domain: ToolDomain): string[] {
  const words = new Set<string>([...(domain.keywords ?? []), ...(DOMAIN_KEYWORDS[domain.name] ?? [])]);
  words.add(domain.name.replace(/-/g, " "));
  return [...words];
}

/** Base domains are always sent to the model in chat. */
export function isBaseDomain(domain: ToolDomain): boolean {
  return domain.settingsKeys.length === 0 && !domain.onDemand;
}

export function getDomain(name: string): ToolDomain | undefined {
  return domains.find((d) => d.name === name);
}

/** Names of the always-on base domains, sorted. */
export function getBaseDomainNames(): string[] {
  return domains.filter(isBaseDomain).map((d) => d.name).sort();
}

/** Map a tool name to the domain that registered it. */
export function getDomainNameForTool(toolName: string): string | undefined {
  if (!toolDomainIndex) {
    toolDomainIndex = new Map();
    for (const domain of domains) {
      for (const name of Object.keys(domain.tools)) {
        if (!toolDomainIndex.has(name)) toolDomainIndex.set(name, domain.name);
      }
    }
  }
  return toolDomainIndex.get(toolName);
}

/** Per-text memo of keyword matches (all non-base domains, before the active filter). */
const textMatchCache = new Map<string, readonly string[]>();
const TEXT_MATCH_CACHE_MAX = 2000;
/** Texts shorter than this are cheap to scan and not worth a cache slot. */
const TEXT_MATCH_CACHE_MIN_LENGTH = 2000;

function scanDomainsForText(lowerText: string): string[] {
  const matched: string[] = [];
  for (const domain of domains) {
    if (isBaseDomain(domain)) continue;
    if (domainPattern(domain).test(lowerText)) matched.push(domain.name);
  }
  return matched;
}

/**
 * Active, non-base domains whose keywords appear in `text`.
 * No fallback: a message that matches nothing adds nothing.
 *
 * The text is lowercased once and each domain is tested with one combined
 * pattern. `cacheKey` (e.g. a message id) memoizes the scan for long texts,
 * so a pasted log in the history is scanned once, not on every request.
 */
export function matchDomainsForText(
  text: string,
  activeDomains: ReadonlySet<string> = getActiveDomainNames(),
  cacheKey?: string,
): Set<string> {
  if (!text.trim()) return new Set();
  let names: readonly string[] | undefined;
  const memoKey = cacheKey && text.length >= TEXT_MATCH_CACHE_MIN_LENGTH
    ? `${cacheKey}\u0000${text.length}\u0000${text.slice(0, 64)}\u0000${text.slice(-64)}`
    : undefined;
  if (memoKey) names = textMatchCache.get(memoKey);
  if (!names) {
    names = scanDomainsForText(text.toLowerCase());
    if (memoKey) {
      textMatchCache.set(memoKey, names);
      if (textMatchCache.size > TEXT_MATCH_CACHE_MAX) {
        const oldest = textMatchCache.keys().next().value;
        if (oldest !== undefined) textMatchCache.delete(oldest);
      }
    }
  }
  return new Set(names.filter((name) => activeDomains.has(name)));
}

/** Deterministic domain order: base domains first, then by name. */
export function compareDomainNames(a: string, b: string): number {
  const baseA = getDomain(a) ? isBaseDomain(getDomain(a) as ToolDomain) : false;
  const baseB = getDomain(b) ? isBaseDomain(getDomain(b) as ToolDomain) : false;
  if (baseA !== baseB) return baseA ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Tools of the given domains in deterministic order (domain order, then tool
 * name). Unknown domain names are ignored. A tool name registered by two
 * domains keeps its first registration, matching getAllRegisteredTools().
 */
export function getOrderedDomainTools(domainNames: Iterable<string>): Array<[string, Tool]> {
  const ordered = [...new Set(domainNames)].filter((n) => getDomain(n)).sort(compareDomainNames);
  const entries: Array<[string, Tool]> = [];
  for (const name of ordered) {
    const domain = getDomain(name) as ToolDomain;
    for (const toolName of Object.keys(domain.tools).sort()) {
      if (getDomainNameForTool(toolName) !== name) continue;
      entries.push([toolName, domain.tools[toolName]]);
    }
  }
  return entries;
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
