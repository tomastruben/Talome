import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/components/icons", () => ({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- strip the icon prop
  HugeiconsIcon: ({ icon: _icon, ...props }: Record<string, unknown>) => <svg data-testid="icon" {...props} />,
  LockedIcon: {},
  Edit02Icon: {},
  AlertCircleIcon: {},
  Copy01Icon: {},
  CheckmarkCircle01Icon: {},
  Cancel01Icon: {},
}));

// Radix Switch measures itself; jsdom has no ResizeObserver.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  Object.defineProperty(globalThis, "ResizeObserver", { value: ResizeObserverStub, configurable: true });
}

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { TokenDialog } from "@/components/trust/token-dialog";
import type { GrantCatalog, McpToken } from "@/components/trust/format";

const catalog: GrantCatalog = {
  domains: [
    { name: "core", tools: [{ name: "list_apps", tier: "read" }, { name: "restart_app", tier: "modify" }] },
    { name: "arr", tools: [{ name: "arr_status", tier: "read" }] },
  ],
  apps: ["sonarr", "plex"],
  defaults: { maxTier: "read", domains: "all", apps: "all" },
};

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function lastBody(): Record<string, unknown> {
  const call = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return JSON.parse(String(call[1].body)) as Record<string, unknown>;
}

describe("TokenDialog", () => {
  it("creates a scoped token and reveals it once", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          id: "tok1",
          name: "Cursor",
          token: "tlm_secret_value",
          scopes: { maxTier: "modify", domains: "all", apps: ["sonarr"] },
          expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        }),
        { status: 200 },
      ),
    );
    const onSaved = vi.fn();
    render(<TokenDialog open onOpenChange={() => {}} mode={{ kind: "create" }} catalog={catalog} onSaved={onSaved} />);

    const create = screen.getByRole("button", { name: "Create token" });
    expect(create).toBeDisabled();
    expect(screen.getByText("2 of 3 tools available to this token")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Client"), { target: { value: "Cursor" } });
    fireEvent.click(screen.getByRole("radio", { name: /Modify/ }));
    expect(screen.getByText("3 of 3 tools available to this token")).toBeInTheDocument();

    // Restrict to one app.
    fireEvent.click(screen.getByRole("switch", { name: "All apps" }));
    expect(screen.getByText("Pick at least one app.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "sonarr" }));

    fireEvent.click(screen.getByRole("button", { name: "Create token" }));

    expect(await screen.findByText("tlm_secret_value")).toBeInTheDocument();
    expect(onSaved).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/integrations/mcp/tokens");
    expect(init.method).toBe("POST");
    expect(lastBody()).toEqual({
      name: "Cursor",
      scopes: { maxTier: "modify", domains: "all", apps: ["sonarr"] },
      expiresInDays: 30,
    });
  });

  it("sends expiresAt: null for tokens that never expire", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, id: "t", name: "X", token: "tlm_x", scopes: {}, expiresAt: null }), {
        status: 200,
      }),
    );
    render(<TokenDialog open onOpenChange={() => {}} mode={{ kind: "create" }} catalog={catalog} onSaved={() => {}} />);
    fireEvent.change(screen.getByLabelText("Client"), { target: { value: "X" } });
    fireEvent.click(screen.getByRole("radio", { name: "Never" }));
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));
    await screen.findByText("tlm_x");
    expect(lastBody()).toMatchObject({ expiresAt: null });
    expect(lastBody()).not.toHaveProperty("expiresInDays");
  });

  it("restricting a legacy token starts from read-only and keeps its expiry", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, token: null }), { status: 200 }));
    const legacy: McpToken = {
      id: "old",
      name: "Old client",
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      legacy: true,
      scopes: { maxTier: "destructive", domains: "all", apps: "all" },
    };
    const onOpenChange = vi.fn();
    render(
      <TokenDialog open onOpenChange={onOpenChange} mode={{ kind: "edit", token: legacy }} catalog={catalog} onSaved={() => {}} />,
    );
    expect(screen.getByRole("radio", { name: /Read/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: "Save access" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/integrations/mcp/tokens/old");
    expect(init.method).toBe("PATCH");
    expect(lastBody()).toEqual({ scopes: { maxTier: "read", domains: "all", apps: "all" } });
  });

  it("surfaces server validation errors without closing", async () => {
    const { toast } = await import("sonner");
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: false, error: "expiresAt must be in the future" }), { status: 400 }));
    render(<TokenDialog open onOpenChange={() => {}} mode={{ kind: "create" }} catalog={catalog} onSaved={() => {}} />);
    fireEvent.change(screen.getByLabelText("Client"), { target: { value: "Y" } });
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("expiresAt must be in the future"));
    expect(screen.getByRole("button", { name: "Create token" })).toBeInTheDocument();
  });
});
