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
      <span data-testid="auto">{String(ctx.autoMode)}</span>
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

  it("reads auto mode from localStorage and persists changes", () => {
    localStorage.setItem("talome-auto-mode", "true");
    render(
      <AssistantProvider>
        <Probe />
      </AssistantProvider>,
    );
    expect(screen.getByTestId("auto").textContent).toBe("true");

    act(() => api!.setAutoMode(false));
    expect(screen.getByTestId("auto").textContent).toBe("false");
    expect(localStorage.getItem("talome-auto-mode")).toBe("false");
  });
});
