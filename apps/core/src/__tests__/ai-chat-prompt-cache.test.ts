import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import type { ModelMessage, Tool, UIMessage } from "ai";

const { streamTextMock, getTopMemoriesMock, getFeatureStackStatusMock, saveScreenshotsMock, memoriesTable } = vi.hoisted(() => ({
  streamTextMock: vi.fn(),
  getTopMemoriesMock: vi.fn(),
  getFeatureStackStatusMock: vi.fn(),
  saveScreenshotsMock: vi.fn(),
  /** The memories table as the per-conversation snapshot check reads it. */
  memoriesTable: { rows: [] as Array<{ id: number; content: string; enabled: boolean }> },
}));
const { settingsRows } = vi.hoisted(() => ({
  settingsRows: [{ key: "sonarr_url", value: "http://localhost:8989" }] as Array<{ key: string; value: string }>,
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, streamText: streamTextMock };
});

vi.mock("../db/index.js", () => {
  const memories = {};
  const from = (table: unknown) => ({
    where: () => ({ get: () => null, all: () => (table === memories ? memoriesTable.rows : []) }),
    all: () => settingsRows,
    orderBy: () => ({ limit: () => ({ all: () => [] }) }),
  });
  return {
    db: { select: () => ({ from }) },
    schema: { settings: { key: "key" }, installedApps: { appId: "app_id" }, mcpTokens: {}, memories },
  };
});
vi.mock("../db/audit.js", () => ({ writeAuditEntry: vi.fn() }));
vi.mock("../db/memories.js", () => ({ getTopMemories: getTopMemoriesMock }));
vi.mock("../stacks/feature-stacks.js", () => ({ getFeatureStackStatus: getFeatureStackStatusMock }));
vi.mock("../ai/claude-runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai/claude-runner.js")>();
  return { ...actual, saveScreenshots: saveScreenshotsMock };
});
vi.mock("../agent-loop/budget.js", () => ({ logAiUsage: vi.fn() }));

import {
  applyMessageCacheBreakpoints,
  buildSystemMessages,
  withToolCacheBreakpoint,
} from "../ai/prompt-cache.js";
import { createChatStream, DEFAULT_SYSTEM_PROMPT } from "../ai/agent.js";
import { invalidateChatContextCaches } from "../ai/chat-context-cache.js";
import { getBaseDomainNames, getOrderedDomainTools, invalidateSettingsCache } from "../ai/tool-registry.js";
import { resetToolRoutingState } from "../ai/tool-discovery.js";

const EPHEMERAL = { anthropic: { cacheControl: { type: "ephemeral" } } };

function cacheMarks(messages: ModelMessage[]): number[] {
  return messages.flatMap((m, i) => ((m.providerOptions?.anthropic as { cacheControl?: unknown } | undefined)?.cacheControl ? [i] : []));
}

const history: ModelMessage[] = [
  { role: "user", content: [{ type: "text", text: "add Dune to my movies" }] },
  { role: "assistant", content: [{ type: "text", text: "Added Dune." }] },
  { role: "user", content: [{ type: "text", text: "and Arrival" }] },
  { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "search_media", input: { q: "Arrival" } }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "search_media", output: { type: "json", value: {} } }] },
];

describe("applyMessageCacheBreakpoints", () => {
  it("marks the message before the latest user turn and the last message", () => {
    expect(cacheMarks(applyMessageCacheBreakpoints(history))).toEqual([1, 4]);
  });

  it("strips breakpoints from earlier steps so the total stays within Anthropic's limit", () => {
    const step1 = applyMessageCacheBreakpoints(history.slice(0, 3));
    expect(cacheMarks(step1)).toEqual([1, 2]);
    const step2 = applyMessageCacheBreakpoints([...step1, ...history.slice(3)]);
    expect(cacheMarks(step2)).toEqual([1, 4]);
  });

  it("does not mutate its input and skips empty text / reasoning messages", () => {
    const input: ModelMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      { role: "user", content: [{ type: "text", text: "next" }] },
      { role: "assistant", content: [{ type: "reasoning", text: "thinking" }] },
    ];
    const snapshot = JSON.stringify(input);
    const out = applyMessageCacheBreakpoints(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(cacheMarks(out)).toEqual([1, 2]);
  });

  it("keeps unrelated provider options", () => {
    const input: ModelMessage[] = [
      { role: "user", content: "a", providerOptions: { openai: { foo: 1 }, anthropic: { cacheControl: { type: "ephemeral" }, other: true } } },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ];
    const out = applyMessageCacheBreakpoints(input);
    expect(out[0].providerOptions).toEqual({ openai: { foo: 1 }, anthropic: { other: true } });
    expect(out[2].providerOptions).toEqual(EPHEMERAL);
  });
});

describe("buildSystemMessages / withToolCacheBreakpoint", () => {
  it("puts the static prompt first with a breakpoint only when caching", () => {
    const cached = buildSystemMessages({ staticPrompt: "static", dynamicParts: ["memories", ""], cache: true });
    expect(cached).toEqual([
      { role: "system", content: "static", providerOptions: EPHEMERAL },
      { role: "system", content: "memories" },
    ]);
    const plain = buildSystemMessages({ staticPrompt: "static", dynamicParts: [], cache: false });
    expect(plain).toEqual([{ role: "system", content: "static" }]);
  });

  it("marks one tool on a copy and preserves order", () => {
    const a = { description: "a" } as Tool;
    const b = { description: "b" } as Tool;
    const out = withToolCacheBreakpoint({ a, b }, "a");
    expect(Object.keys(out)).toEqual(["a", "b"]);
    expect((out.a as { providerOptions?: unknown }).providerOptions).toEqual(EPHEMERAL);
    expect((a as { providerOptions?: unknown }).providerOptions).toBeUndefined();
    expect(out.b).toBe(b);
  });
});

describe("createChatStream cache options", () => {
  const originalEnv = { ...process.env };
  const uiMessages: UIMessage[] = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "add Dune to my movies" }] },
    { id: "a1", role: "assistant", parts: [{ type: "text", text: "Added." }] },
    { id: "u2", role: "user", parts: [{ type: "text", text: "thanks" }] },
  ];

  beforeEach(() => {
    streamTextMock.mockReset();
    streamTextMock.mockReturnValue({});
    getTopMemoriesMock.mockReset();
    getTopMemoriesMock.mockResolvedValue([]);
    memoriesTable.rows = [];
    getFeatureStackStatusMock.mockReset();
    getFeatureStackStatusMock.mockResolvedValue([]);
    saveScreenshotsMock.mockReset();
    saveScreenshotsMock.mockResolvedValue([]);
    resetToolRoutingState();
    invalidateChatContextCaches();
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    process.env.OPENAI_API_KEY = "test-openai-key";
    delete process.env.DEFAULT_MODEL;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  type StreamArgs = {
    system: Array<{ content: string; providerOptions?: unknown }>;
    messages: ModelMessage[];
    onStepFinish: (step: { toolCalls: Array<{ toolName: string; args?: unknown }>; toolResults: unknown[] }) => void;
    tools: Record<string, Tool & { providerOptions?: unknown }>;
    activeTools: string[];
    prepareStep: (o: { messages: ModelMessage[]; stepNumber: number }) => { activeTools?: string[]; messages?: ModelMessage[] };
  };

  const lastArgs = () => streamTextMock.mock.calls.at(-1)?.[0] as StreamArgs;

  it("applies cache breakpoints for anthropic", async () => {
    await createChatStream(uiMessages, undefined, undefined, undefined, "anthropic");
    const args = lastArgs();

    expect(args.system[0].providerOptions).toEqual(EPHEMERAL);
    expect(args.system.slice(1).every((m) => m.providerOptions === undefined)).toBe(true);

    const marked = Object.entries(args.tools).filter(([, t]) => t.providerOptions);
    const baseNames = getOrderedDomainTools(getBaseDomainNames()).map(([n]) => n);
    expect(marked.map(([n]) => n)).toEqual([baseNames.at(-1)]);
    expect(Object.keys(args.tools).slice(0, baseNames.length)).toEqual(baseNames);

    expect(args.activeTools).toContain("discover_tools");
    expect(args.activeTools).toContain("web_search");
    expect(args.activeTools).toContain("search_media"); // routed via "movies"

    const step = args.prepareStep({ messages: history, stepNumber: 1 });
    expect(step.activeTools).toEqual(args.activeTools);
    expect(cacheMarks(step.messages ?? [])).toEqual([1, 4]);
  });

  it("sends no cache options for openai", async () => {
    await createChatStream(uiMessages, undefined, "gpt-4o-mini", undefined, "openai");
    const args = lastArgs();

    expect(args.system.every((m) => m.providerOptions === undefined)).toBe(true);
    expect(Object.values(args.tools).some((t) => t.providerOptions)).toBe(false);
    expect(args.tools).not.toHaveProperty("web_search");
    expect(args.activeTools).toContain("discover_tools");

    const step = args.prepareStep({ messages: history, stepNumber: 1 });
    expect(step.messages).toBeUndefined();
    expect(step.activeTools).toEqual(args.activeTools);
  });

  it("makes discover_tools activations visible on the next step", async () => {
    await createChatStream([{ id: "x1", role: "user", parts: [{ type: "text", text: "hello" }] }], undefined, undefined, undefined, "anthropic");
    const args = lastArgs();
    expect(args.activeTools).not.toContain("create_automation");
    expect(args.tools).toHaveProperty("create_automation");

    const execute = args.tools.discover_tools.execute as (i: unknown, o: unknown) => Promise<unknown>;
    await execute({ query: "automation" }, { toolCallId: "d1", messages: [] });
    expect(args.prepareStep({ messages: history, stepNumber: 1 }).activeTools).toContain("create_automation");
  });

  it("lets discover_tools load an app configured earlier in the same request", async () => {
    await createChatStream([{ id: "p1", role: "user", parts: [{ type: "text", text: "install plex" }] }], undefined, undefined, undefined, "anthropic");
    const args = lastArgs();
    expect(args.activeTools).not.toContain("plex_get_on_deck");

    // Step 1: install_app auto-configures Plex; onStepFinish drops the settings cache.
    settingsRows.push({ key: "plex_url", value: "http://localhost:32400" });
    try {
      args.onStepFinish({ toolCalls: [{ toolName: "install_app", args: { appId: "plex" } }], toolResults: [] });
      // Step 2: the model loads the plex domain.
      const execute = args.tools.discover_tools.execute as (i: unknown, o: unknown) => Promise<{ activatedDomains: string[] }>;
      const result = await execute({ domain: "plex" }, { toolCallId: "d1", messages: [] });
      expect(result.activatedDomains).toEqual(["plex"]);
      // Step 3: its tools are sent to the model and callable.
      expect(args.prepareStep({ messages: history, stepNumber: 2 }).activeTools).toContain("plex_get_on_deck");
      expect(args.tools).toHaveProperty("plex_get_on_deck");
    } finally {
      settingsRows.pop();
      invalidateSettingsCache();
    }
  });

  const text = (m: ModelMessage) =>
    typeof m.content === "string" ? m.content : m.content.map((p) => ("text" in p ? String(p.text) : `[${p.type}]`)).join("|");

  it("keeps the system block identical across turns when a memory is added mid-conversation", async () => {
    memoriesTable.rows = [{ id: 1, content: "media lives on /mnt/media", enabled: true }, { id: 2, content: "prefers 4K", enabled: true }];
    getTopMemoriesMock
      .mockResolvedValueOnce([{ id: 1, content: "media lives on /mnt/media" }])
      .mockResolvedValue([{ id: 1, content: "media lives on /mnt/media" }, { id: 2, content: "prefers 4K" }]);
    const turn1: UIMessage[] = [{ id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] }];
    await createChatStream(turn1, undefined, undefined, undefined, "anthropic");
    const system1 = lastArgs().system;

    const turn2: UIMessage[] = [
      ...turn1,
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "Hi! How can I help with your server today?" }] },
      { id: "u2", role: "user", parts: [{ type: "text", text: "thanks" }] },
    ];
    await createChatStream(turn2, undefined, undefined, undefined, "anthropic");
    expect(lastArgs().system).toEqual(system1);
    expect(system1[1].content).toContain("media lives on /mnt/media");
    expect(system1[1].content).not.toContain("prefers 4K");

    // A new conversation picks up the new memory.
    await createChatStream([{ id: "n1", role: "user", parts: [{ type: "text", text: "hi" }] }], undefined, undefined, undefined, "anthropic");
    expect(lastArgs().system[1].content).toContain("prefers 4K");
  });

  it("stops sending a memory deleted in Settings to a running conversation", async () => {
    memoriesTable.rows = [{ id: 1, content: "wife's name is Ana", enabled: true }, { id: 2, content: "prefers 4K", enabled: true }];
    getTopMemoriesMock.mockResolvedValue([{ id: 1, content: "wife's name is Ana" }, { id: 2, content: "prefers 4K" }]);
    const turn1: UIMessage[] = [{ id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] }];
    await createChatStream(turn1, undefined, undefined, undefined, "anthropic");
    expect(lastArgs().system[1].content).toContain("wife's name is Ana");

    // DELETE /api/memories/1 — nothing in the chat path is told.
    memoriesTable.rows = [{ id: 2, content: "prefers 4K", enabled: true }];
    getTopMemoriesMock.mockResolvedValue([{ id: 2, content: "prefers 4K" }]);
    await createChatStream([
      ...turn1,
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "Hi!" }] },
      { id: "u2", role: "user", parts: [{ type: "text", text: "thanks" }] },
    ], undefined, undefined, undefined, "anthropic");
    const system = lastArgs().system.map((m) => m.content).join("\n");
    expect(system).not.toContain("wife's name is Ana");
    expect(system).toContain("prefers 4K");
  });

  it("attaches page context and screenshot paths to their user message and replays them verbatim", async () => {
    saveScreenshotsMock.mockResolvedValue(["/tmp/shots/1-0.png"]);
    const turn1: UIMessage[] = [{
      id: "u1",
      role: "user",
      parts: [
        { type: "text", text: "make this button bigger" },
        { type: "file", mediaType: "image/png", url: "data:image/png;base64,iVBORw0KGgo=" },
      ],
    }];
    await createChatStream(turn1, "Page: /apps", undefined, undefined, "anthropic");
    const args1 = lastArgs();
    expect(args1.system.map((m) => m.content).join("\n")).not.toContain("Page: /apps");
    expect(args1.system.map((m) => m.content).join("\n")).not.toContain("Visual context");
    const u1Text = text(args1.messages[0]);
    expect(u1Text).toContain("Page: /apps");
    expect(u1Text).toContain("/tmp/shots/1-0.png");

    const turn2: UIMessage[] = [
      ...turn1,
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "Done." }] },
      { id: "u2", role: "user", parts: [{ type: "text", text: "and the header" }] },
    ];
    await createChatStream(turn2, "Page: /media", undefined, undefined, "anthropic");
    const args2 = lastArgs();
    expect(args2.system).toEqual(args1.system);
    expect(args2.messages[0]).toEqual(args1.messages[0]);
    expect(text(args2.messages[2])).toContain("Page: /media");
    expect(text(args2.messages[2])).not.toContain("Visual context");
    expect(saveScreenshotsMock).toHaveBeenCalledTimes(1);
  });

  it("attaches the setup guide to the first setup message (whole words only) and keeps it there", async () => {
    const report: UIMessage[] = [{ id: "r1", role: "user", parts: [{ type: "text", text: "give me a report, it's important" }] }];
    await createChatStream(report, undefined, undefined, undefined, "anthropic");
    expect(lastArgs().messages.map(text).join("\n")).not.toContain("## App settings reference");

    const turn1: UIMessage[] = [{ id: "s1", role: "user", parts: [{ type: "text", text: "how do I configure sonarr?" }] }];
    await createChatStream(turn1, undefined, undefined, undefined, "anthropic");
    const args1 = lastArgs();
    expect(text(args1.messages[0])).toContain("## App settings reference");
    expect(args1.system.map((m) => m.content).join("\n")).not.toContain("## App settings reference");

    await createChatStream([
      ...turn1,
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "Sure." }] },
      { id: "s2", role: "user", parts: [{ type: "text", text: "thanks" }] },
    ], undefined, undefined, undefined, "anthropic");
    const args2 = lastArgs();
    expect(args2.messages[0]).toEqual(args1.messages[0]);
    expect(text(args2.messages[2])).not.toContain("## App settings reference");
  });

  it("adds the Tool Loading section only to the chat prompt", async () => {
    expect(DEFAULT_SYSTEM_PROMPT).not.toContain("discover_tools");
    await createChatStream(uiMessages, undefined, undefined, undefined, "anthropic");
    expect(lastArgs().system[0].content).toContain("## Tool Loading");
    expect(lastArgs().system[0].content.startsWith(DEFAULT_SYSTEM_PROMPT)).toBe(true);
  });

  it("refreshes setup status after the agent runs a state-changing tool", async () => {
    await createChatStream(uiMessages, undefined, undefined, undefined, "anthropic");
    await createChatStream(uiMessages, undefined, undefined, undefined, "anthropic");
    expect(getFeatureStackStatusMock).toHaveBeenCalledTimes(1);

    lastArgs().onStepFinish({ toolCalls: [{ toolName: "list_containers", args: {} }], toolResults: [] });
    await createChatStream(uiMessages, undefined, undefined, undefined, "anthropic");
    expect(getFeatureStackStatusMock).toHaveBeenCalledTimes(1);

    lastArgs().onStepFinish({ toolCalls: [{ toolName: "install_app", args: { appId: "sonarr" } }], toolResults: [] });
    await createChatStream(uiMessages, undefined, undefined, undefined, "anthropic");
    expect(getFeatureStackStatusMock).toHaveBeenCalledTimes(2);
  });
});
