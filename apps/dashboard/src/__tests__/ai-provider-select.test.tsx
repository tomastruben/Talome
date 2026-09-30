import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/constants", () => ({ CORE_URL: "http://core" }));
vi.mock("@/components/settings/configure-with-ai", () => ({ ConfigureWithAI: () => null }));

import { AiProviderSection, describeTestFailure } from "@/components/settings/sections/ai-provider";
import { ConfirmDialogHost, confirmStore } from "@/components/ui/confirm-dialog";

const fetchMock = vi.fn();
let server = { provider: "anthropic", model: "claude-a" };
let testOk = true;
let kimiConfigured = false;
let testGate: Promise<void> | null = null;

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      {children}
      <ConfirmDialogHost />
    </SWRConfig>
  );
}

function settingsPosts() {
  return fetchMock.mock.calls.filter(([url, init]) => url === "http://core/api/settings" && (init as RequestInit | undefined)?.method === "POST");
}

describe("AI provider selection (P0-8)", () => {
  beforeEach(() => {
    server = { provider: "anthropic", model: "claude-a" };
    testOk = true;
    kimiConfigured = false;
    testGate = null;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "http://core/api/ai/models") {
        return json({
          activeProvider: server.provider,
          activeModel: server.model,
          providers: [
            { provider: "anthropic", configured: true, models: [{ id: "claude-a", name: "Claude A", description: "" }] },
            { provider: "openai", configured: true, models: [{ id: "gpt-a", name: "GPT A", description: "" }] },
            { provider: "kimi", configured: kimiConfigured, models: kimiConfigured ? [{ id: "kimi-a", name: "Kimi A", description: "" }] : [] },
            { provider: "ollama", configured: false, models: [] },
          ],
        });
      }
      if (url === "http://core/api/settings" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { ai_provider?: string; ai_model?: string };
        if (body.ai_provider) server = { provider: body.ai_provider, model: body.ai_model ?? "" };
        return json({ ok: true });
      }
      if (url === "http://core/api/settings") return json({ anthropic_key: "(configured)", openai_key: "(configured)" });
      if (url === "http://core/api/ai/test") {
        if (testGate) await testGate;
        return testOk ? json({ ok: true }) : json({ ok: false, error: "HTTP 401" });
      }
      if (url === "http://core/api/ollama/models") return json({ models: [] });
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => confirmStore.reset());

  it("selecting a card never saves; the switch waits for a passing test and a confirm", async () => {
    render(<AiProviderSection />, { wrapper });
    const openai = await screen.findByRole("button", { name: /OpenAI/ });
    fireEvent.click(openai);
    expect(openai).toHaveAttribute("aria-pressed", "true");
    expect(settingsPosts()).toHaveLength(0);

    const use = await screen.findByRole("button", { name: "Use OpenAI" });
    expect(use).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Test OpenAI" }));
    expect(await screen.findByText("Test passed · OpenAI replied")).toBeInTheDocument();
    const testCall = fetchMock.mock.calls.find(([url]) => url === "http://core/api/ai/test")!;
    expect(JSON.parse(String((testCall[1] as RequestInit).body))).toEqual({ provider: "openai" });

    fireEvent.click(screen.getByRole("button", { name: "Use OpenAI" }));
    expect(await screen.findByRole("alertdialog")).toHaveAccessibleName("Switch the Assistant to OpenAI?");
    fireEvent.click(screen.getAllByRole("button", { name: "Use OpenAI" }).at(-1)!);
    await waitFor(() => expect(server.provider).toBe("openai"));
    expect(server.model).toBe("gpt-a");
  });

  it("a failed test names the fix and keeps Use disabled", async () => {
    testOk = false;
    render(<AiProviderSection />, { wrapper });
    fireEvent.click(await screen.findByRole("button", { name: /OpenAI/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Test OpenAI" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("OpenAI rejected the API key");
    expect(screen.getByRole("button", { name: "Use OpenAI" })).toBeDisabled();
    expect(settingsPosts()).toHaveLength(0);
  });

  it("a test still running when another card is selected never passes for that card", async () => {
    kimiConfigured = true;
    let release!: () => void;
    testGate = new Promise<void>((resolve) => { release = resolve; });
    render(<AiProviderSection />, { wrapper });
    fireEvent.click(await screen.findByRole("button", { name: /OpenAI/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Test OpenAI" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === "http://core/api/ai/test")).toBe(true));

    // Switch to Kimi while OpenAI's test is in flight, then let it pass.
    fireEvent.click(screen.getByRole("button", { name: /Kimi/ }));
    expect(await screen.findByRole("button", { name: "Use Kimi" })).toBeDisabled();
    release();
    await waitFor(() => expect(screen.getByRole("button", { name: "Test Kimi" })).toBeEnabled());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.queryByText(/Test passed/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use Kimi" })).toBeDisabled();
    expect(settingsPosts()).toHaveLength(0);
  });

  it("describes test failures per provider", () => {
    expect(describeTestFailure("anthropic", "No API key configured")).toBe("Add an Anthropic API key above, then test again.");
    expect(describeTestFailure("kimi", "No Kimi API key configured")).toBe("Add a Kimi API key above, then test again.");
    expect(describeTestFailure("ollama", "No Ollama URL configured")).toContain("Ollama server URL");
    expect(describeTestFailure("kimi", "HTTP 401")).toContain("Kimi rejected the API key");
  });
});
