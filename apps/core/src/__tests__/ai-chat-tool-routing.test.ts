import { describe, it, expect, vi, beforeEach } from "vitest";
import type { UIMessage } from "ai";

// Configured apps for this suite: a typical media stack. Plex is NOT configured.
const { settingsRows } = vi.hoisted(() => ({
  settingsRows: ["sonarr_url", "radarr_url", "prowlarr_url", "qbittorrent_url", "jellyfin_url", "overseerr_url"].map(
    (key) => ({ key, value: "http://localhost" }),
  ),
}));

vi.mock("../db/index.js", () => {
  const from = () => ({
    where: () => ({ get: () => null, all: () => [] }),
    all: () => settingsRows,
    orderBy: () => ({ limit: () => ({ all: () => [] }) }),
  });
  return {
    db: { select: () => ({ from }) },
    schema: { settings: { key: "key" }, installedApps: { appId: "app_id" }, mcpTokens: {}, memories: {} },
  };
});
vi.mock("../db/audit.js", () => ({ writeAuditEntry: vi.fn() }));
vi.mock("../db/memories.js", () => ({ getTopMemories: vi.fn().mockResolvedValue([]) }));

import {
  getActiveDomainNames,
  getActiveRegisteredTools,
  getAllRegisteredTools,
  invalidateSettingsCache,
  getAllToolMeta,
  getAllDomains,
  getBaseDomainNames,
  getDomain,
  getOrderedDomainTools,
  matchDomainsForText,
  textMatchesKeyword,
} from "../ai/tool-registry.js";
import {
  createDiscoverToolsTool,
  createToolRoutingSession,
  deriveConversationKey,
  resetToolRoutingState,
} from "../ai/tool-discovery.js";
import "../ai/agent.js";

function userMessage(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function assistantMessage(id: string, parts: unknown[]): UIMessage {
  return { id, role: "assistant", parts } as UIMessage;
}

async function runDiscover(session: ReturnType<typeof createToolRoutingSession>, input: { query?: string; domain?: string }) {
  const discover = createDiscoverToolsTool(session);
  const execute = discover.execute as (args: typeof input, opts: unknown) => Promise<Record<string, unknown>>;
  return execute(input, { toolCallId: "t1", messages: [] });
}

/** Tools routed for a one-message conversation. */
const toolsFor = (text: string) => createToolRoutingSession({ messages: [userMessage("single", text)] }).toolNames();

const baseToolNames = () => getOrderedDomainTools(getBaseDomainNames()).map(([name]) => name);

beforeEach(() => {
  resetToolRoutingState();
});

describe("on-demand core split", () => {
  it("keeps every tool registered with its tier and category", () => {
    const all = getAllRegisteredTools();
    expect(Object.keys(all).length).toBeGreaterThan(200);
    const meta = new Map(getAllToolMeta().map((m) => [m.name, m]));
    expect(meta.get("create_automation")).toMatchObject({ category: "automations", tier: "modify" });
    expect(meta.get("list_images")).toMatchObject({ category: "docker", tier: "read" });
    expect(meta.get("apply_change")).toMatchObject({ category: "self-improvement", tier: "destructive" });
    expect(meta.get("mdns_enable")).toMatchObject({ category: "networking" });
  });

  it("keeps on-demand groups active for MCP / automations", () => {
    const active = getActiveRegisteredTools();
    for (const name of ["create_automation", "list_images", "browse_files", "design_app_blueprint", "mdns_status"]) {
      expect(active).toHaveProperty(name);
    }
  });

  it("trims the always-on base to essential ops tools", () => {
    const base = baseToolNames();
    expect(getBaseDomainNames()).toEqual(["core", "setup", "verification"]);
    expect(base.length).toBeLessThan(60);
    for (const name of ["list_containers", "restart_container", "get_container_logs", "install_app", "search_apps", "get_app_config", "remember", "recall", "set_setting", "track_issue", "run_shell"]) {
      expect(base).toContain(name);
    }
    for (const name of ["create_automation", "apply_change", "design_app_blueprint", "list_images", "browse_files", "mdns_enable"]) {
      expect(base).not.toContain(name);
    }
  });

  it("never registers a tool name in two domains", () => {
    const seen = new Map<string, string>();
    for (const domain of getAllDomains()) {
      for (const name of Object.keys(domain.tools)) {
        expect(seen.get(name), `${name} in ${domain.name} and ${seen.get(name)}`).toBeUndefined();
        seen.set(name, domain.name);
      }
    }
  });
});

describe("deterministic ordering", () => {
  it("orders base domains first, then domain name, then tool name — independent of input order", () => {
    const a = getOrderedDomainTools(["media", "arr", "core", "setup", "verification", "automations"]).map(([n]) => n);
    const b = getOrderedDomainTools(["automations", "verification", "setup", "core", "arr", "media"]).map(([n]) => n);
    expect(a).toEqual(b);

    const base = baseToolNames();
    expect(a.slice(0, base.length)).toEqual(base);

    const coreNames = Object.keys(getDomain("core")?.tools ?? {}).sort();
    expect(a.slice(0, coreNames.length)).toEqual(coreNames);

    const rest = a.slice(base.length);
    const domainOf = (name: string) => getAllDomains().find((d) => name in d.tools)?.name ?? "";
    const restDomains = rest.map(domainOf);
    expect(restDomains).toEqual([...restDomains].sort());
  });

  it("returns identical tool lists for the same conversation on repeated calls", () => {
    const messages = [userMessage("u1", "add Dune to my movies")];
    const first = createToolRoutingSession({ messages }).toolNames();
    const second = createToolRoutingSession({ messages }).toolNames();
    expect(second).toEqual(first);
  });
});

describe("no catch-all fallback", () => {
  it("returns only the base set for a message that matches no domain", () => {
    const names = toolsFor("hey, thanks!");
    expect(names).toEqual(baseToolNames());
    expect(names.length).toBeLessThan(Object.keys(getActiveRegisteredTools()).length / 2);
  });

  it("adds only the matching domains", () => {
    const names = toolsFor("my torrents are slow");
    expect(names).toContain("qbt_list_torrents");
    expect(names).not.toContain("arr_get_status");
    expect(names).not.toContain("create_automation");
  });

  it("does not load unconfigured app domains", () => {
    expect(toolsFor("what is on deck in plex")).not.toContain("plex_get_on_deck");
  });
});

describe("keyword matching", () => {
  it("matches whole words with common suffixes only", () => {
    expect(textMatchesKeyword("add two movies", "movie")).toBe(true);
    expect(textMatchesKeyword("it keeps streaming badly", "stream")).toBe(true);
    expect(textMatchesKeyword("highlight the row", "light")).toBe(false);
    expect(textMatchesKeyword("show recent activity", "tv")).toBe(false);
    expect(textMatchesKeyword("Set up Home Assistant", "home assistant")).toBe(true);
  });

  it("matches consonant + y keywords in their -ies form", () => {
    expect(textMatchesKeyword("scan my libraries", "library")).toBe(true);
    expect(textMatchesKeyword("it notifies me twice", "notify")).toBe(true);
    expect(textMatchesKeyword("add two api keys", "api key")).toBe(true);
  });

  it("routes 'libraries' to the media domains", () => {
    const domains = matchDomainsForText("scan my libraries", new Set(getAllDomains().map((d) => d.name)));
    expect(domains.has("media")).toBe(true);
  });

  it("does not load broad or risky domains for unrelated phrasing", () => {
    const unrelated: Array<[string, string]> = [
      ["what's the error code in the logs", "self-improvement"],
      ["what features do you have?", "self-improvement"],
      ["there is a bug in sonarr", "self-improvement"],
      ["set a rate limit", "app-management"],
      ["which group of containers is using the most cpu", "app-management"],
      ["what's my memory usage", "memory-admin"],
      ["show the jellyfin log file", "files"],
      ["show chat history", "monitoring"],
    ];
    for (const [text, domain] of unrelated) {
      expect(matchDomainsForText(text).has(domain), `${domain} for "${text}"`).toBe(false);
    }
    for (const [text, domain] of [
      ["read your own source code", "self-improvement"],
      ["set a memory limit on plex", "app-management"],
      ["start the media app group", "app-management"],
      ["what memories do you have about me", "memory-admin"],
      ["browse the downloads folder", "files"],
    ] as const) {
      expect(matchDomainsForText(text).has(domain), `${domain} for "${text}"`).toBe(true);
    }
  });

  it("returns the same matches with a memo key and still applies the active filter", () => {
    const long = `${"lorem ipsum ".repeat(400)} add Dune to my movies and seed the torrent`;
    const all = new Set(getAllDomains().map((d) => d.name));
    const first = matchDomainsForText(long, all, "msg-1");
    expect(first.has("media")).toBe(true);
    expect(first.has("qbittorrent")).toBe(true);
    expect(matchDomainsForText(long, all, "msg-1")).toEqual(first);
    expect(matchDomainsForText(long, new Set(["media"]), "msg-1")).toEqual(new Set(["media"]));
  });
});

describe("monotonic per-conversation domain set", () => {
  it("keeps a domain for the rest of the conversation once added", () => {
    const turn1 = [userMessage("u1", "add Dune Part Two to my movies")];
    const s1 = createToolRoutingSession({ conversationKey: "k1", messages: turn1 });
    expect(s1.domains.has("media")).toBe(true);

    const turn2 = [
      ...turn1,
      assistantMessage("a1", [{ type: "text", text: "Added." }]),
      userMessage("u2", "now restart the gateway container"),
    ];
    const s2 = createToolRoutingSession({ conversationKey: "k1", messages: turn2 });
    expect(s2.domains.has("media")).toBe(true);
    // Every tool from turn 1 is still there, in the same relative order.
    const names2 = s2.toolNames();
    expect(names2.filter((n) => s1.toolNames().includes(n))).toEqual(s1.toolNames());
  });

  it("re-derives domains from tools used earlier in the history (survives restarts)", () => {
    const messages = [
      userMessage("u1", "why is it slow?"),
      assistantMessage("a1", [
        { type: "tool-qbt_list_torrents", toolCallId: "c1", state: "output-available", input: {}, output: { torrents: [] } },
        { type: "text", text: "Two torrents are stalled." },
      ]),
      userMessage("u2", "ok thanks"),
    ];
    const session = createToolRoutingSession({ messages });
    expect(session.domains.has("qbittorrent")).toBe(true);
  });

  it("derives the conversation key from an explicit id, else the first message id", () => {
    const messages = [userMessage("first", "hi")];
    expect(deriveConversationKey("conv-1", messages)).toBe("c:conv-1");
    expect(deriveConversationKey(undefined, messages)).toBe("m:first");
    expect(deriveConversationKey(42, [])).toBeUndefined();
  });
});

describe("discover_tools", () => {
  it("activates matching domains for the current request and later turns", async () => {
    const messages = [userMessage("u1", "can you help me with something?")];
    const session = createToolRoutingSession({ conversationKey: "conv-a", messages });
    expect(session.toolNames()).not.toContain("create_automation");

    const result = await runDiscover(session, { query: "automation" });
    expect(result.activatedDomains).toContain("automations");
    expect(session.toolNames()).toContain("create_automation");
    expect((result.tools as Array<{ name: string }>).map((t) => t.name)).toContain("create_automation");

    // Next turn: plain-text history (no tool parts), same conversation key → still loaded.
    const next = createToolRoutingSession({
      conversationKey: "conv-a",
      messages: [...messages, assistantMessage("a1", [{ type: "text", text: "Sure." }]), userMessage("u2", "do it")],
    });
    expect(next.toolNames()).toContain("create_automation");

    // A different conversation does not inherit it.
    const other = createToolRoutingSession({ conversationKey: "conv-b", messages: [userMessage("x", "hello")] });
    expect(other.toolNames()).not.toContain("create_automation");
  });

  it("recovers activations from a stored discover_tools result in the history", () => {
    const messages = [
      userMessage("u1", "help"),
      assistantMessage("a1", [
        { type: "tool-discover_tools", toolCallId: "d1", state: "output-available", input: { query: "widget" }, output: { activatedDomains: ["widgets"] } },
      ]),
      userMessage("u2", "go on"),
    ];
    expect(createToolRoutingSession({ messages }).toolNames()).toContain("create_widget_manifest");
  });

  it("loads a domain by exact tool name or domain name", async () => {
    const session = createToolRoutingSession({ messages: [userMessage("u1", "hi")] });
    const byName = await runDiscover(session, { query: "design_app_blueprint" });
    expect(byName.activatedDomains).toEqual(["app-creator"]);

    const byDomain = await runDiscover(session, { domain: "docker-admin" });
    expect(byDomain.activatedDomains).toEqual(["docker-admin"]);
    expect(session.toolNames()).toContain("list_networks");
  });

  it("reports unconfigured app domains instead of loading them", async () => {
    const session = createToolRoutingSession({ messages: [userMessage("u1", "hi")] });
    const result = await runDiscover(session, { query: "plex on deck" });
    expect(result.activatedDomains).not.toContain("plex");
    expect(result.unconfigured).toEqual(expect.arrayContaining([expect.objectContaining({ domain: "plex", needsAnyOfSettings: ["plex_url"] })]));
    expect(session.toolNames()).not.toContain("plex_get_on_deck");
  });

  it("loads a domain that became configured earlier in the same request", async () => {
    // The request starts before Plex is configured…
    const session = createToolRoutingSession({ conversationKey: "conv-install", messages: [userMessage("u1", "install plex and show on deck")] });
    const other = createToolRoutingSession({ messages: [userMessage("v1", "hi")] });
    expect(session.toolNames()).not.toContain("plex_get_on_deck");
    // …then install_app auto-configures it and onStepFinish drops the settings cache.
    settingsRows.push({ key: "plex_url", value: "http://localhost:32400" });
    invalidateSettingsCache();
    try {
      expect(getActiveDomainNames().has("plex")).toBe(true);
      const byDomain = await runDiscover(session, { domain: "plex" });
      expect(byDomain.activatedDomains).toEqual(["plex"]);
      expect((byDomain.tools as Array<{ name: string }>).map((t) => t.name)).toContain("plex_get_on_deck");
      expect(byDomain.note).not.toMatch(/No matching tools/);
      expect(session.toolNames()).toContain("plex_get_on_deck");

      // The query form loads it too.
      const byQuery = await runDiscover(other, { query: "plex on deck" });
      expect(byQuery.activatedDomains).toContain("plex");
      expect(byQuery.unconfigured ?? []).toEqual([]);

      // Later turns of the conversation keep it.
      const next = createToolRoutingSession({ conversationKey: "conv-install", messages: [userMessage("u1", "hi")] });
      expect(next.toolNames()).toContain("plex_get_on_deck");
    } finally {
      settingsRows.pop();
      invalidateSettingsCache();
    }
  });

  it("never lists or activates tools the user disabled", async () => {
    const disabled = new Set(["delete_file", "rename_file"]);
    const session = createToolRoutingSession({ messages: [userMessage("u1", "hi")] });
    const discover = createDiscoverToolsTool(session, { isToolEnabled: (name) => !disabled.has(name) });
    const execute = discover.execute as (args: unknown, opts: unknown) => Promise<Record<string, unknown>>;
    const result = await execute({ query: "delete file" }, { toolCallId: "t1", messages: [] });
    const names = (result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).not.toContain("delete_file");
    expect(names).not.toContain("rename_file");

    // A domain whose tools are all disabled is never activated.
    const allCreator = new Set(["design_app_blueprint"]);
    const fresh = createToolRoutingSession({ messages: [userMessage("u2", "hi")] });
    const discover2 = createDiscoverToolsTool(fresh, { isToolEnabled: (name) => !allCreator.has(name) });
    const execute2 = discover2.execute as (args: unknown, opts: unknown) => Promise<Record<string, unknown>>;
    const byName = await execute2({ query: "design_app_blueprint" }, { toolCallId: "t2", messages: [] });
    expect(byName.activatedDomains).not.toContain("app-creator");
    expect(fresh.domains.has("app-creator")).toBe(false);
  });

  it("activates at most three domains per call and lists domains when nothing matches", async () => {
    const session = createToolRoutingSession({ messages: [userMessage("u1", "hi")] });
    const broad = await runDiscover(session, { query: "list" });
    expect((broad.activatedDomains as string[]).length).toBeLessThanOrEqual(3);

    const none = await runDiscover(session, { query: "zzzqqq" });
    expect(none.activatedDomains).toEqual([]);
    expect(Array.isArray(none.availableDomains)).toBe(true);
  });
});
