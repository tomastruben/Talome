/**
 * Before/after measurement of the per-request tool payload in chat.
 *
 * "before" re-implements the previous getToolsForMessage(): every no-settings
 * domain always, substring keyword routing for app domains, app domains
 * without keywords always, and the full active set when no app domain matched.
 * "after" is the per-conversation routing session + discover_tools.
 * Token counts are approximate: chars/4 of {name, description, JSON schema}.
 */
import { describe, it, expect, vi } from "vitest";
import { asSchema, type Tool, type UIMessage } from "ai";

const { settingsState } = vi.hoisted(() => ({ settingsState: { keys: [] as string[] } }));

vi.mock("../db/index.js", () => {
  const from = () => ({
    where: () => ({ get: () => null, all: () => [] }),
    all: () => settingsState.keys.map((key) => ({ key, value: "http://localhost" })),
    orderBy: () => ({ limit: () => ({ all: () => [] }) }),
  });
  return {
    db: { select: () => ({ from }) },
    schema: { settings: { key: "key" }, installedApps: { appId: "app_id" }, mcpTokens: {}, memories: {} },
  };
});
vi.mock("../db/audit.js", () => ({ writeAuditEntry: vi.fn() }));
vi.mock("../db/memories.js", () => ({ getTopMemories: vi.fn().mockResolvedValue([]) }));

import { getActiveDomainNames, getAllDomains, invalidateSettingsCache } from "../ai/tool-registry.js";
import { createDiscoverToolsTool, createToolRoutingSession, resetToolRoutingState } from "../ai/tool-discovery.js";
import { DEFAULT_SYSTEM_PROMPT } from "../ai/agent.js";

const LEGACY_KEYWORDS: Record<string, string[]> = {
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

function legacyToolsForMessage(message: string): Record<string, Tool> {
  const active = getActiveDomainNames();
  const lower = message.toLowerCase();
  const domains = getAllDomains();
  const matched = new Set<string>();
  for (const d of domains) {
    if (d.settingsKeys.length === 0) {
      matched.add(d.name);
      continue;
    }
    if (!active.has(d.name)) continue;
    const kws = LEGACY_KEYWORDS[d.name];
    if (!kws || kws.some((kw) => lower.includes(kw))) matched.add(d.name);
  }
  const optional = [...matched].some((n) => (domains.find((d) => d.name === n)?.settingsKeys.length ?? 0) > 0);
  const picked = optional ? domains.filter((d) => matched.has(d.name)) : domains.filter((d) => active.has(d.name));
  return Object.assign({}, ...picked.map((d) => d.tools)) as Record<string, Tool>;
}

function newToolsForConversation(messages: UIMessage[]): Record<string, Tool> {
  const session = createToolRoutingSession({ messages });
  const all = Object.fromEntries(getAllDomains().flatMap((d) => Object.entries(d.tools)));
  const tools: Record<string, Tool> = Object.fromEntries(session.toolNames().map((n) => [n, all[n]]));
  tools.discover_tools = createDiscoverToolsTool(session);
  return tools;
}

const schemaChars = new Map<string, number>();
async function approxTokens(tools: Record<string, Tool>): Promise<number> {
  let chars = 0;
  for (const [name, t] of Object.entries(tools)) {
    if (!schemaChars.has(name) || name === "discover_tools") {
      const schema = await asSchema(t.inputSchema).jsonSchema;
      schemaChars.set(name, JSON.stringify({ name, description: t.description, input_schema: schema }).length);
    }
    chars += schemaChars.get(name) ?? 0;
  }
  return Math.round(chars / 4);
}

const MESSAGES = [
  "Add Dune Part Two to my movies",
  "restart the jellyfin container",
  "install nextcloud for me",
  "how do my backups work?",
  "hey, thanks!",
  "change the settings for the AI model",
  "what's using all my disk space?",
  "my torrents are stuck downloading",
  "create an automation to restart sonarr every night",
  "why is my server slow today",
];

const SCENARIOS: Array<{ name: string; keys: string[] }> = [
  { name: "media stack (sonarr, radarr, prowlarr, qbittorrent, jellyfin, overseerr)", keys: ["sonarr_url", "radarr_url", "prowlarr_url", "qbittorrent_url", "jellyfin_url", "overseerr_url"] },
  { name: "fresh install (no apps configured)", keys: [] },
];

const user = (id: string, text: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }] });

describe("chat tool payload measurement", () => {
  it("prints before/after tool counts and approximate schema tokens", async () => {
    const lines: string[] = [
      `static system prompt: ${DEFAULT_SYSTEM_PROMPT.length} chars (~${Math.round(DEFAULT_SYSTEM_PROMPT.length / 4)} tokens) — now sent as a cached block`,
    ];

    for (const scenario of SCENARIOS) {
      settingsState.keys = scenario.keys;
      invalidateSettingsCache();
      resetToolRoutingState();
      lines.push("", `## ${scenario.name}`, `${"message".padEnd(52)} before(tools/tokens)  after(tools/tokens)`);
      let beforeTotal = 0;
      let afterTotal = 0;
      for (const message of MESSAGES) {
        const before = legacyToolsForMessage(message);
        const after = newToolsForConversation([user("u1", message)]);
        const bt = await approxTokens(before);
        const at = await approxTokens(after);
        beforeTotal += bt;
        afterTotal += at;
        lines.push(`${message.padEnd(52)} ${String(Object.keys(before).length).padStart(4)} / ${String(bt).padStart(6)}      ${String(Object.keys(after).length).padStart(4)} / ${String(at).padStart(6)}`);
        expect(Object.keys(after).length).toBeLessThanOrEqual(Object.keys(before).length);
      }
      lines.push(`${"average".padEnd(52)}        ${String(Math.round(beforeTotal / MESSAGES.length)).padStart(6)}             ${String(Math.round(afterTotal / MESSAGES.length)).padStart(6)}`);
      expect(afterTotal).toBeLessThan(beforeTotal * 0.6);

      // One conversation covering all messages: the domain set only grows.
      const convo: UIMessage[] = [];
      let prev = 0;
      for (const [i, message] of MESSAGES.entries()) {
        convo.push(user(`c${i}`, message));
        const count = Object.keys(newToolsForConversation(convo)).length;
        expect(count).toBeGreaterThanOrEqual(prev);
        prev = count;
      }
      lines.push(`${"10-turn conversation, final turn (monotonic)".padEnd(52)}  n/a                ${String(prev).padStart(4)} / ${String(await approxTokens(newToolsForConversation(convo))).padStart(6)}`);
    }

    console.log(lines.join("\n"));
  });
});
