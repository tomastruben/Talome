/**
 * Rebuild dashboard left the Terminal toolbar (it had nothing to do with the
 * shell session) and lives on a Settings row beside Server mode: admins only,
 * like the endpoint; the button shows the build in flight with its busy state;
 * the outcome arrives as a toast, never as coloured button text. The row is
 * the same in a window and in the classic (phone) layout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/settings",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
const embedded = vi.hoisted(() => ({ value: true }));
vi.mock("@/hooks/use-desktop-mode", () => ({ useIsEmbeddedFrame: () => embedded.value }));
const user = vi.hoisted(() => ({ isAdmin: true }));
vi.mock("@/hooks/use-user", () => ({ useUser: () => ({ isAdmin: user.isAdmin, user: { role: user.isAdmin ? "admin" : "member" } }) }));
vi.mock("@/components/trust/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/trust/api")>()),
  usePendingApprovals: () => ({ pending: [], count: 0, error: undefined, isLoading: false, mutate: vi.fn() }),
}));
vi.mock("@/components/system/services-section", () => ({ ServicesSection: () => null }));
const { toast } = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast }));

import SettingsPage from "@/app/dashboard/settings/page";
import { SettingsLayoutContext } from "@/components/settings/settings-layout-context";

const SRC = join(__dirname, "..");
const read = (path: string) => readFileSync(join(SRC, path), "utf8");

type Route = { status: number; body?: unknown };
let finishRebuild: ((route: Route) => void) | null = null;
const rebuildCalls: string[] = [];

function renderSettings(twoPane = true) {
  return render(
    <Provider store={createStore()}>
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
        <SettingsLayoutContext.Provider value={{ twoPane }}>
          <SettingsPage />
        </SettingsLayoutContext.Provider>
      </SWRConfig>
    </Provider>,
  );
}

const row = () => screen.getByText("Rebuild dashboard").closest("div[class*='px-4']") as HTMLElement;

beforeEach(() => {
  embedded.value = true;
  user.isAdmin = true;
  finishRebuild = null;
  rebuildCalls.length = 0;
  vi.clearAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/evolution/rebuild-dashboard")) {
        rebuildCalls.push(init?.method ?? "GET");
        return new Promise<Response>((resolve) => {
          finishRebuild = (route) =>
            resolve({ ok: route.status < 300, status: route.status, json: async () => route.body } as Response);
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as Response);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Rebuild dashboard row in Settings", () => {
  it("sits with Server mode in General, for admins", () => {
    renderSettings();
    const serverMode = screen.getByText("Server mode");
    const rebuild = screen.getByText("Rebuild dashboard");
    // Same settings group, right after Server mode
    expect(serverMode.compareDocumentPosition(rebuild) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(row()).getByText(/If the build fails, the current one keeps running/)).toBeInTheDocument();
  });

  it("is not shown to members (the endpoint is admin-only)", () => {
    user.isAdmin = false;
    renderSettings();
    expect(screen.queryByText("Rebuild dashboard")).toBeNull();
    expect(screen.queryByRole("button", { name: "Rebuild" })).toBeNull();
  });

  it("is the same row in the classic, stacked layout", () => {
    embedded.value = false;
    renderSettings(false);
    expect(within(row()).getByRole("button", { name: "Rebuild" })).toBeInTheDocument();
  });

  it("ties the short button to the row's label and grows to 44px on touch", () => {
    renderSettings();
    const button = within(row()).getByRole("button", { name: "Rebuild" });
    expect(button).toHaveAccessibleDescription(/Rebuild dashboard/);
    expect(button.className).toContain("phone-touch:h-11");
  });

  it("shows the build in flight with the busy state, then a receipt toast", async () => {
    renderSettings();
    const button = within(row()).getByRole("button", { name: "Rebuild" });
    fireEvent.click(button);
    expect(rebuildCalls).toEqual(["POST"]);
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAccessibleName("Rebuilding…");
    // A second press while building does not start another build
    fireEvent.click(button);
    expect(rebuildCalls).toHaveLength(1);
    // Never status-coloured text on the button
    expect(button.className).not.toMatch(/text-status-/);

    await act(async () => finishRebuild?.({ status: 200, body: { ok: true, duration: 4200 } }));
    expect(toast.success).toHaveBeenCalledWith(
      expect.stringMatching(/^Rebuilt Talome in 4[.,]2 s$/),
      expect.objectContaining({ description: "Refresh the page to see the changes." }),
    );
    expect(button).not.toHaveAttribute("aria-busy");
    expect(button).toHaveAccessibleName("Rebuild");
    expect(button.className).not.toMatch(/text-status-/);
  });

  it("stays busy when you leave General and come back while the build runs", async () => {
    const first = renderSettings();
    fireEvent.click(within(row()).getByRole("button", { name: "Rebuild" }));
    first.unmount();

    renderSettings();
    const button = within(row()).getByRole("button", { name: "Rebuilding…" });
    expect(button).toHaveAttribute("aria-busy", "true");
    fireEvent.click(button);
    expect(rebuildCalls).toHaveLength(1);

    await act(async () => finishRebuild?.({ status: 200, body: { ok: true, duration: 12000 } }));
    expect(toast.success).toHaveBeenCalledOnce();
    expect(within(row()).getByRole("button", { name: "Rebuild" })).not.toHaveAttribute("aria-busy");
  });

  it("reports a failed build in a toast that offers the fix", async () => {
    renderSettings();
    fireEvent.click(within(row()).getByRole("button", { name: "Rebuild" }));
    await act(async () =>
      finishRebuild?.({ status: 500, body: { ok: false, buildError: "Type error in page.tsx", duration: 900 } }),
    );
    expect(toast.error).toHaveBeenCalledWith(
      "The build failed",
      expect.objectContaining({ action: expect.objectContaining({ label: "Fix" }) }),
    );
    expect(within(row()).getByRole("button", { name: "Rebuild" })).not.toHaveAttribute("aria-busy");
  });

  it("says what failed when the server refuses (a build already running)", async () => {
    renderSettings();
    fireEvent.click(within(row()).getByRole("button", { name: "Rebuild" }));
    await act(async () => finishRebuild?.({ status: 409, body: { ok: false, error: "Build already in progress" } }));
    expect(toast.error).toHaveBeenCalledWith("Couldn't rebuild Talome", { description: "Build already in progress" });
  });

  it("reports progress only through the busy state and toasts (no status colours, no spinning icon)", () => {
    const source = read("components/terminal/rebuild-dashboard-button.tsx");
    expect(source).toContain('busyLabel="Rebuilding…"');
    expect(source).not.toMatch(/text-status-|animate-spin/);
  });
});
