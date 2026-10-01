/**
 * Share: a failed load is an error with Retry (not "No apps to share yet"),
 * the app tiles are toggles with aria-pressed and an empty mark when off (no
 * opacity on their names), and the count, Select all and the primary action
 * sit in the toolbar (a window's toolbar row, the row above the apps in
 * classic mode), where Prepare becomes "Prepare again" once a package exists.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const installed = vi.hoisted(() => ({
  value: {
    apps: [] as Array<{ id: string; name: string; icon?: string }>,
    isLoading: false,
    error: null as string | null,
  },
}));
vi.mock("@/hooks/use-installed-apps", () => ({ useInstalledApps: () => installed.value }));

const swr = vi.hoisted(() => ({ mutate: vi.fn(async () => undefined) }));
vi.mock("swr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("swr")>()),
  useSWRConfig: () => ({ mutate: swr.mutate }),
}));

const mode = vi.hoisted(() => ({ embedded: false }));
vi.mock("@/hooks/use-desktop-mode", () => ({ useIsEmbeddedFrame: () => mode.embedded }));

vi.mock("@/components/icons", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/icons")>()),
  HugeiconsIcon: () => <svg />,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import SharePage from "@/app/dashboard/share/page";
import { WindowToolbarSlot } from "@/components/desktop/window-content";
import { Provider, createStore } from "jotai";

const SRC = join(__dirname, "..");
const fetchMock = vi.fn();

const capsule = (code: string) => ({
  ok: true,
  json: async () => ({
    capsuleCode: code,
    fingerprint: "abcdefghijkl",
    qrEligible: false,
    maxQrPayloadLength: 0,
    publicLinkEligible: false,
    recipeFileCode: code,
    recipeFileName: "home.talome-stack",
    recoveryFileCode: "t1.recovery",
    recoveryFileName: "home.talome-recovery",
    hasCustomApps: false,
    recommendedTransport: "code-or-file",
    fileCode: "t1.recovery",
    fileName: "home.talome-stack",
    linkCompatible: true,
    capsuleLength: code.length,
    maxLinkLength: 7500,
    missingCatalogApps: [],
  }),
});
const exported = {
  ok: true,
  json: async () => ({ stack: { id: "home", name: "Home", apps: [{ appId: "jellyfin" }, { appId: "sonarr" }] } }),
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("NEXT_PUBLIC_TALOME_SHARE_URL", "");
  swr.mutate.mockClear();
  mode.embedded = false;
  installed.value = {
    apps: [
      { id: "jellyfin", name: "Jellyfin", icon: "🎬" },
      { id: "sonarr", name: "Sonarr", icon: "📺" },
    ],
    isLoading: false,
    error: null,
  };
});

describe("Share", () => {
  it("shows a failed load as an error with Retry, not as no apps (regression)", () => {
    installed.value = { apps: [], isLoading: false, error: "Failed to fetch installed apps" };
    render(<SharePage />);
    expect(screen.getByText("Couldn't load your apps")).toBeInTheDocument();
    expect(screen.queryByText("No apps to share yet")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(swr.mutate).toHaveBeenCalledWith(expect.stringMatching(/\/api\/apps\/installed$/));
  });

  it("keeps the apps on screen when a refresh fails, with a Retry row", () => {
    installed.value = { ...installed.value, error: "Failed to fetch installed apps" };
    render(<SharePage />);
    expect(screen.getByRole("button", { name: "Jellyfin" })).toBeInTheDocument();
    expect(screen.getByText(/Couldn't refresh/)).toBeInTheDocument();
  });

  it("makes each app tile a toggle with aria-pressed, and dims an unselected name by colour, not opacity", () => {
    render(<SharePage />);
    const group = screen.getByRole("group", { name: "Apps to include" });
    const tile = within(group).getByRole("button", { name: "Jellyfin" });
    expect(tile).toHaveAttribute("type", "button");
    expect(tile).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("2 of 2 apps")).toBeInTheDocument();

    fireEvent.click(tile);
    expect(tile).toHaveAttribute("aria-pressed", "false");
    expect(tile.className).toMatch(/text-muted-foreground/);
    expect(tile.className).not.toMatch(/opacity-/);
    expect(tile.querySelector(".tm-select-mark")).not.toBeNull();
    expect(tile.querySelector(".tm-select-mark")!.hasAttribute("data-selected")).toBe(false);
    expect(screen.getByText("1 of 2 apps")).toBeInTheDocument();

    const selectAll = screen.getByRole("button", { name: "Select all" });
    expect(selectAll).toHaveAttribute("type", "button");
    expect(selectAll.className).toMatch(/pointer-coarse:h-11/);
    fireEvent.click(selectAll);
    expect(tile).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Deselect all" })).toBeInTheDocument();
  });

  it("prepares a package from the toolbar, then offers Prepare again, and moves focus to the receipt", async () => {
    fetchMock
      .mockResolvedValueOnce(exported)
      .mockResolvedValueOnce(capsule("t2.first"))
      .mockResolvedValueOnce(exported)
      .mockResolvedValueOnce(capsule("t2.second"));
    render(<SharePage />);

    fireEvent.click(screen.getByRole("button", { name: "Prepare share package" }));
    expect(await screen.findByText("t2.first")).toBeInTheDocument();
    const receipt = screen.getByRole("heading", { name: "Recipe ready to share" });
    await waitFor(() => expect(receipt).toHaveFocus());

    // Every action on the receipt is a 44px target on touch
    for (const name of ["Copy code", "Share recipe", "Download"]) {
      expect(screen.getByRole("button", { name }).className).toMatch(/pointer-coarse:h-11/);
    }

    const again = screen.getByRole("button", { name: "Prepare again" });
    expect(again).toHaveAttribute("data-variant", "outline");
    fireEvent.click(again);
    expect(await screen.findByText("t2.second")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("puts the count, Select all and Prepare in a window's toolbar row", () => {
    mode.embedded = true;
    render(
      <Provider store={createStore()}>
        <div data-testid="toolbar-slot">
          <WindowToolbarSlot />
        </div>
        <SharePage />
      </Provider>,
    );
    const toolbar = within(screen.getByTestId("toolbar-slot"));
    expect(toolbar.getByText("2 of 2 apps")).toBeInTheDocument();
    expect(toolbar.getByRole("button", { name: "Deselect all" })).toBeInTheDocument();
    expect(toolbar.getByRole("button", { name: "Prepare share package" })).toBeInTheDocument();
  });

  it("uses motion tokens, not literal curves", () => {
    const page = readFileSync(join(SRC, "app/dashboard/share/page.tsx"), "utf-8");
    expect(page).not.toMatch(/ease:\s*\[/);
    expect(page).not.toMatch(/duration:\s*0\.\d/);
    expect(page).not.toMatch(/opacity-40/);
  });
});
