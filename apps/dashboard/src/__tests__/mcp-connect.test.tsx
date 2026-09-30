import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/constants", () => ({ CORE_URL: "http://core" }));

import { maskSecret, mcpClientConfig, mcpServerUrl } from "@/components/trust/api";
import { TokenDialog } from "@/components/trust/token-dialog";

const TOKEN = "tlm_abcdefghijklmnopqrstuvwxyz0123456789";

describe("MCP server URL (P0-9)", () => {
  it("uses the page origin, keeping HTTPS and custom domains, instead of :4000", () => {
    expect(mcpServerUrl("https://talome.example.com")).toBe("https://talome.example.com/api/mcp");
    expect(mcpServerUrl("http://192.168.1.20:3000")).toBe("http://192.168.1.20:3000/api/mcp");
    expect(mcpServerUrl("https://talome.example.com", "https://core.example.com/")).toBe("https://core.example.com/api/mcp");
  });

  it("masks secrets and embeds the token only in copied configs", () => {
    expect(maskSecret(TOKEN)).toBe(`tlm_${"•".repeat(12)}6789`);
    expect(maskSecret(TOKEN)).not.toContain("abcdefgh");
    const config = JSON.parse(mcpClientConfig("claude-desktop", "https://t.example/api/mcp", TOKEN)) as {
      mcpServers: { talome: { type: string; url: string; headers: { Authorization: string } } };
    };
    expect(config.mcpServers.talome).toEqual({ type: "http", url: "https://t.example/api/mcp", headers: { Authorization: `Bearer ${TOKEN}` } });
  });
});

describe("token reveal (P0-9)", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: "t1", name: "Cursor", token: TOKEN, scopes: { maxTier: "read", domains: "all", apps: "all" }, expiresAt: null }),
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => undefined) } });
  });
  afterEach(() => vi.unstubAllGlobals());

  async function createToken(onOpenChange = vi.fn()) {
    render(
      <TokenDialog
        open
        onOpenChange={onOpenChange}
        mode={{ kind: "create" }}
        catalog={undefined}
        onSaved={vi.fn()}
        serverUrl="https://t.example/api/mcp"
      />,
    );
    fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "Cursor" } });
    fireEvent.click(screen.getByRole("button", { name: "Create access" }));
    await screen.findByRole("heading", { name: "Connect Cursor" });
    return onOpenChange;
  }

  it("masks the token, and Done and Esc can't close it before it was copied", async () => {
    const onOpenChange = await createToken();
    expect(screen.queryByText(TOKEN)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Access token, hidden")).toHaveTextContent("tlm_");

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Copy the token first");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    fireEvent.click(screen.getByRole("button", { name: "Copy access token" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(TOKEN));
    // Still masked after copying.
    expect(screen.queryByText(TOKEN)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("a copied config with the token also counts as saved", async () => {
    const onOpenChange = await createToken();
    fireEvent.click(screen.getByRole("button", { name: "Copy Cursor config" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    const copied = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(copied).toContain(`Bearer ${TOKEN}`);
    expect(copied).toContain("https://t.example/api/mcp");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
