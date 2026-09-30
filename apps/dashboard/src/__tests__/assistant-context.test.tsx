import { useEffect } from "react";
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const transports = vi.hoisted(() => [] as Array<{ body: () => Record<string, unknown> }>);
const modelsConfig = vi.hoisted(() => ({
  current: undefined as unknown,
}));

vi.mock("ai", () => ({
  DefaultChatTransport: class {
    constructor(options: { body: () => Record<string, unknown> }) {
      transports.push(options);
    }
  },
}));

vi.mock("@ai-sdk/react", () => ({
  useChat: () => ({
    messages: [],
    sendMessage: vi.fn(),
    status: "ready",
    setMessages: vi.fn(),
    stop: vi.fn(),
    regenerate: vi.fn(),
    addToolApprovalResponse: vi.fn(),
    error: undefined,
    clearError: vi.fn(),
  }),
}));

vi.mock("swr", () => ({
  default: (key: string | null) => ({
    data: key === "http://core/api/ai/models" ? modelsConfig.current : undefined,
  }),
  mutate: vi.fn(),
}));

vi.mock("@/lib/constants", () => ({
  CORE_URL: "http://core",
  getDirectCoreUrl: () => "http://core",
}));

import { AssistantProvider, useAssistant } from "@/components/assistant/assistant-context";

let api: ReturnType<typeof useAssistant> | null = null;
const captureApi = (value: ReturnType<typeof useAssistant>) => {
  api = value;
};

function Probe() {
  const ctx = useAssistant();
  useEffect(() => captureApi(ctx));
  return (
    <div>
      <span data-testid="model">{ctx.model}</span>
      <span data-testid="provider">{ctx.activeProvider}</span>
      <span data-testid="options">{ctx.modelOptions.map((o) => o.name).join("|")}</span>
      <span data-testid="auto">{String(ctx.chatAutoApprove)}</span>
    </div>
  );
}

const TWO_PROVIDERS = {
  activeProvider: "openai",
  activeModel: "gpt-a",
  providers: [
    {
      provider: "anthropic",
      configured: true,
      models: [{ id: "claude-a", name: "Claude A", description: "" }],
    },
    {
      provider: "openai",
      configured: true,
      models: [{ id: "gpt-a", name: "GPT A", description: "" }],
    },
    { provider: "ollama", configured: false, models: [] },
  ],
};

describe("AssistantProvider", () => {
  beforeEach(() => {
    transports.length = 0;
    modelsConfig.current = undefined;
    api = null;
    localStorage.clear();
  });

  it("derives model options (active provider first) and the default model", () => {
    modelsConfig.current = TWO_PROVIDERS;
    render(
      <AssistantProvider>
        <Probe />
      </AssistantProvider>,
    );
    expect(screen.getByTestId("options").textContent).toBe("OpenAI GPT A|Anthropic Claude A");
    expect(screen.getByTestId("model").textContent).toBe("gpt-a");
    expect(screen.getByTestId("provider").textContent).toBe("openai");
  });

  it("creates one transport whose request body tracks the selected model and provider", () => {
    modelsConfig.current = TWO_PROVIDERS;
    const { rerender } = render(
      <AssistantProvider>
        <Probe />
      </AssistantProvider>,
    );
    expect(transports).toHaveLength(1);
    expect(transports[0].body()).toEqual({ model: "gpt-a", provider: "openai" });

    act(() => api!.setModel("claude-a"));
    expect(screen.getByTestId("model").textContent).toBe("claude-a");
    expect(transports[0].body()).toEqual({ model: "claude-a", provider: "anthropic" });

    rerender(
      <AssistantProvider>
        <Probe />
      </AssistantProvider>,
    );
    expect(transports).toHaveLength(1);
  });

  it("sends the active conversation id in the request body", () => {
    modelsConfig.current = TWO_PROVIDERS;
    render(
      <AssistantProvider>
        <Probe />
      </AssistantProvider>,
    );
    expect(transports[0].body()).not.toHaveProperty("conversationId");

    act(() => api!.setActiveId("conv-1"));
    expect(transports[0].body()).toEqual({ model: "gpt-a", provider: "openai", conversationId: "conv-1" });

    act(() => api!.startNew());
    expect(transports[0].body()).toEqual({ model: "gpt-a", provider: "openai" });
  });

  it("falls back to the server's active model when the pick is no longer offered", () => {
    modelsConfig.current = TWO_PROVIDERS;
    const { rerender } = render(
      <AssistantProvider>
        <Probe />
      </AssistantProvider>,
    );
    act(() => api!.setModel("claude-a"));

    modelsConfig.current = {
      ...TWO_PROVIDERS,
      providers: TWO_PROVIDERS.providers.filter((p) => p.provider !== "anthropic"),
    };
    rerender(
      <AssistantProvider>
        <Probe />
      </AssistantProvider>,
    );
    expect(screen.getByTestId("model").textContent).toBe("gpt-a");
  });

  it("keeps chat auto-approve to this tab's session, separate from the old shared Auto key (P0-5)", () => {
    // The legacy key also drove the terminal, builds and evolution: it no longer turns chat auto-approve on.
    localStorage.setItem("talome-auto-mode", "true");
    sessionStorage.removeItem("talome-chat-auto-approve");
    render(
      <AssistantProvider>
        <Probe />
      </AssistantProvider>,
    );
    expect(screen.getByTestId("auto").textContent).toBe("false");

    act(() => api!.setChatAutoApprove(true));
    expect(screen.getByTestId("auto").textContent).toBe("true");
    expect(sessionStorage.getItem("talome-chat-auto-approve")).toBe("true");
    // Nothing else changes: the terminal's key is untouched.
    expect(localStorage.getItem("talome-auto-mode")).toBe("true");

    act(() => api!.setChatAutoApprove(false));
    expect(screen.getByTestId("auto").textContent).toBe("false");
    expect(sessionStorage.getItem("talome-chat-auto-approve")).toBeNull();
    localStorage.removeItem("talome-auto-mode");
  });

  it("asks the browser to keep a delete alive when it is sent as the page goes away", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <AssistantProvider>
        <Probe />
      </AssistantProvider>,
    );
    await act(async () => { await api!.deleteConversation("c1", { keepalive: true }); });
    await act(async () => { await api!.deleteConversation("c2"); });
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const byUrl = (id: string) => calls.find(([url]) => url === `http://core/api/conversations/${id}`)?.[1];
    expect(byUrl("c1")).toMatchObject({ method: "DELETE", keepalive: true });
    expect(byUrl("c2")?.keepalive).toBeUndefined();
    vi.unstubAllGlobals();
  });
});
