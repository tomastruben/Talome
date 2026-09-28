import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import type { ModelMessage, Tool, UIMessage } from "ai";

const { streamTextMock } = vi.hoisted(() => ({ streamTextMock: vi.fn() }));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, streamText: streamTextMock };
});

vi.mock("../db/index.js", () => {
  const from = () => ({
    where: () => ({ get: () => null, all: () => [] }),
    all: () => [{ key: "sonarr_url", value: "http://localhost:8989" }],
    orderBy: () => ({ limit: () => ({ all: () => [] }) }),
  });
  return {
    db: { select: () => ({ from }) },
    schema: { settings: { key: "key" }, installedApps: { appId: "app_id" }, mcpTokens: {}, memories: {} },
  };
});
vi.mock("../db/audit.js", () => ({ writeAuditEntry: vi.fn() }));
vi.mock("../db/memories.js", () => ({ getTopMemories: vi.fn().mockResolvedValue([]) }));
vi.mock("../stacks/feature-stacks.js", () => ({ getFeatureStackStatus: vi.fn().mockResolvedValue([]) }));
vi.mock("../agent-loop/budget.js", () => ({ logAiUsage: vi.fn() }));

import {
  applyMessageCacheBreakpoints,
  buildSystemMessages,
  withToolCacheBreakpoint,
} from "../ai/prompt-cache.js";
import { createChatStream } from "../ai/agent.js";
import { getBaseDomainNames, getOrderedDomainTools } from "../ai/tool-registry.js";
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
    resetToolRoutingState();
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    process.env.OPENAI_API_KEY = "test-openai-key";
    delete process.env.DEFAULT_MODEL;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  type StreamArgs = {
    system: Array<{ providerOptions?: unknown }>;
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
});
