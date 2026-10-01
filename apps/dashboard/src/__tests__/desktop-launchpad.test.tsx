import { useRef, useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DesktopLaunchpad,
  LAUNCHPAD_MIN_HEIGHT,
  launchpadLockedHeight,
  nearestInRow,
  type LaunchpadTarget,
  type LaunchpadTileRect,
  type LaunchpadWindowState,
} from "@/components/desktop/desktop-launchpad";
import { TooltipProvider } from "@/components/ui/tooltip";

const mocks = vi.hoisted(() => ({
  loading: false,
  error: undefined as string | undefined,
  stacks: [] as unknown[],
  refresh: vi.fn(),
  launch: vi.fn(),
  launchService: vi.fn(),
  permission: vi.fn(() => true),
}));
vi.mock("@/hooks/use-user", () => ({ useUser: () => ({ user: { role: "admin" }, hasPermission: mocks.permission }) }));
// The Customize tooltip positions itself with ResizeObserver, which jsdom lacks
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
vi.mock("@/hooks/use-service-stacks", () => ({ useServiceStacks: () => ({ stacks: mocks.stacks, isLoading: mocks.loading, error: mocks.error, refresh: mocks.refresh }) }));

type WindowState = (target: LaunchpadTarget) => LaunchpadWindowState | undefined;

function Harness({ windowState, focusWindowOnLaunch = false }: { windowState?: WindowState; focusWindowOnLaunch?: boolean }) {
  const [open, setOpen] = useState(false);
  const windowRef = useRef<HTMLDivElement>(null);
  const launched = () => {
    setOpen(false);
    // As openApp does: focus moves into the new window while the panel exits,
    // before the dialog's unmount auto-focus runs (also on a timer).
    if (focusWindowOnLaunch) setTimeout(() => windowRef.current?.focus(), 0);
  };
  return <TooltipProvider>
    <button onClick={() => setOpen(true)}>Open apps</button>
    <button>Outside action</button>
    <div ref={windowRef} role="region" aria-label="App window" tabIndex={-1} />
    <DesktopLaunchpad
      open={open}
      zIndex={1400}
      onOpenChange={setOpen}
      onLaunch={(app) => { mocks.launch(app); launched(); }}
      onLaunchService={(app) => { mocks.launchService(app); launched(); }}
      windowState={windowState}
    />
  </TooltipProvider>;
}
async function open(windowState?: WindowState, focusWindowOnLaunch = false) {
  const user = userEvent.setup();
  render(<Harness windowState={windowState} focusWindowOnLaunch={focusWindowOnLaunch} />);
  await user.click(screen.getByRole("button", { name: "Open apps" }));
  return user;
}
/** Lets the dialog's unmount auto-focus (a timer after the exit) run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const search = () => screen.getByRole("combobox", { name: "Search apps" });
const option = (name: string) => screen.getByRole("option", { name, exact: true });

beforeEach(() => {
  localStorage.clear();
  mocks.loading = false;
  mocks.error = undefined;
  mocks.stacks = [];
  mocks.refresh.mockReset().mockResolvedValue(undefined);
  mocks.launch.mockReset();
  mocks.launchService.mockReset();
  mocks.permission.mockReset().mockReturnValue(true);
});

describe("DesktopLaunchpad", () => {
  it("focuses search, contains keyboard focus, dismisses on Escape and returns focus", async () => {
    const user = await open();
    expect(search()).toHaveFocus();
    const dialog = screen.getByRole("dialog", { name: "Launchpad" });
    for (let index = 0; index < 18; index++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Open apps" })).toHaveFocus();
  });

  it("is a combobox over a listbox of app options, with nothing selected on open", async () => {
    await open();
    const input = search();
    const listbox = screen.getByRole("listbox", { name: "Apps" });
    expect(input).toHaveAttribute("aria-controls", listbox.id);
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(input).not.toHaveAttribute("aria-activedescendant");
    expect(within(listbox).getByRole("group", { name: "Talome apps" })).toContainElement(option("Files"));
    expect(screen.queryByRole("option", { selected: true })).not.toBeInTheDocument();
    // The placeholder counts the apps that are really listed
    expect(input).toHaveAttribute("placeholder", `Search ${screen.getAllByRole("option").length} apps`);
  });

  it("does not launch anything on Enter while the search is empty", async () => {
    const user = await open();
    await user.keyboard("{Enter}");
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(mocks.launchService).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Launchpad" })).toBeInTheDocument();
  });

  it("selects the first option with ArrowDown and launches it on Enter", async () => {
    const user = await open();
    await user.keyboard("{ArrowDown}");
    const first = screen.getAllByRole("option")[0];
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(search()).toHaveAttribute("aria-activedescendant", first.id);
    expect(search()).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(mocks.launch).toHaveBeenCalledWith(expect.objectContaining({ url: "/dashboard/assistant" }));
  });

  it("moves the selection with Left, Right, Home and End only after the arrow keys take over", async () => {
    const user = await open();
    const options = () => screen.getAllByRole("option");
    await user.keyboard("{ArrowUp}");
    expect(options().at(-1)).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Home}");
    expect(options()[0]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(options()[2]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowLeft}");
    expect(options()[1]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{End}");
    expect(options().at(-1)).toHaveAttribute("aria-selected", "true");
    // Typing hands Left and Right back to the text, and selects the best match
    await user.keyboard("fi");
    expect(search()).toHaveValue("fi");
    expect(option("Files")).toHaveAttribute("aria-selected", "true");
  });

  it("selects the top-ranked option while typing, and launches it on Enter", async () => {
    const user = await open();
    await user.type(search(), "  fIlEs ");
    expect(option("Files")).toHaveAttribute("aria-selected", "true");
    expect(search()).toHaveAttribute("aria-activedescendant", option("Files").id);
    expect(screen.queryByRole("option", { name: "Media", exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent("1 app found");
    await user.keyboard("{Enter}");
    expect(mocks.launch).toHaveBeenCalledWith(expect.objectContaining({ url: "/dashboard/files" }));
  });

  it("leaves focus in the window a launch opened, so typing reaches the app", async () => {
    const user = await open(undefined, true);
    await user.type(search(), "files");
    await user.keyboard("{Enter}");
    expect(mocks.launch).toHaveBeenCalledWith(expect.objectContaining({ url: "/dashboard/files" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await settle();
    expect(screen.getByRole("region", { name: "App window" })).toHaveFocus();
  });

  it("leaves focus in the window when a tile is clicked, too", async () => {
    const user = await open(undefined, true);
    await user.click(option("Media"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await settle();
    expect(screen.getByRole("region", { name: "App window" })).toHaveFocus();
  });

  it("returns focus to the trigger when a launch moved it nowhere", async () => {
    const user = await open();
    await user.type(search(), "files");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await settle();
    expect(screen.getByRole("button", { name: "Open apps" })).toHaveFocus();
  });

  it("clears the search on the first Escape and closes on the second, returning focus", async () => {
    const user = await open();
    await user.type(search(), "files");
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Launchpad" })).toBeInTheDocument();
    expect(search()).toHaveValue("");
    expect(screen.queryByRole("option", { selected: true })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Open apps" })).toHaveFocus();
  });

  it("offers an actionable empty search and resets the query when reopened", async () => {
    const user = await open();
    await user.type(search(), "nothing-matches");
    expect(screen.getByText("No apps found")).toBeVisible();
    expect(screen.getByText(/Background services are in Services\./)).toBeVisible();
    expect(search()).toHaveAttribute("aria-expanded", "false");
    // The empty state's own Clear search (the header has the icon one too)
    await user.click(screen.getAllByRole("button", { name: "Clear search" }).at(-1)!);
    expect(search()).toHaveValue("");
    expect(search()).toHaveFocus();
    await user.type(search(), "files");
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(search()).toHaveFocus();
    await user.type(search(), "files");
    await user.keyboard("{Escape}{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Open apps" }));
    expect(search()).toHaveValue("");
  });

  it("keeps built-in apps available while installed apps load", async () => {
    mocks.loading = true;
    const user = await open();
    expect(screen.getByRole("status", { name: "Loading installed apps" })).toBeVisible();
    expect(option("Files")).toBeVisible();
    expect(search()).toHaveAttribute("placeholder", "Search apps");
    expect(screen.queryByText("Apps with a browser interface appear here.")).not.toBeInTheDocument();
    await user.type(search(), "files");
    expect(option("Files")).toBeVisible();
    expect(screen.getByText("Loading installed apps…")).toBeVisible();
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent("1 app found; installed apps are loading");
  });

  it("distinguishes an installed-app failure and retries without unhandled rejection", async () => {
    mocks.error = "Failed to fetch service stacks";
    mocks.refresh.mockRejectedValueOnce(new Error("Still unavailable"));
    const user = await open();
    expect(screen.getByRole("alert")).toHaveTextContent("Installed apps couldn’t be loaded");
    expect(option("Files")).toBeVisible();
    expect(screen.queryByText("Apps with a browser interface appear here.")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(mocks.refresh).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled());
  });

  it("says where installed web apps will appear, and opens the App Store from there", async () => {
    const user = await open();
    expect(screen.getByText("Apps with a browser interface appear here.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Open App Store" }));
    expect(mocks.launch).toHaveBeenCalledWith(expect.objectContaining({ url: "/dashboard/apps" }));
  });

  it("searches installed apps by name and preserves the service launch identity", async () => {
    const primary = { id: "weather-container", name: "weather-ui", status: "running", ports: [] };
    mocks.stacks = [{ id: "weather", name: "Mountain Weather Station", storeId: "user-apps", appId: "weather", nativeSurface: { schemaVersion: 1 }, primaryContainer: primary, containers: [primary] }];
    const user = await open();
    const installed = screen.getByRole("group", { name: "Installed apps" });
    expect(within(installed).getByRole("option", { name: "Mountain Weather Station" })).toBeVisible();
    await user.type(search(), "weather");
    await user.keyboard("{Enter}");
    expect(mocks.launchService).toHaveBeenCalledWith(expect.objectContaining({ id: "weather-ui", name: "Mountain Weather Station" }));
  });

  it("does not launch a result while confirming composed text", async () => {
    await open();
    fireEvent.change(search(), { target: { value: "Files" } });
    fireEvent.keyDown(search(), { key: "Enter", isComposing: true });
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("launches on click, and hovering never moves the selection", async () => {
    const user = await open();
    await user.hover(option("Media"));
    expect(option("Media")).toHaveAttribute("aria-selected", "false");
    expect(search()).not.toHaveAttribute("aria-activedescendant");
    await user.click(option("Media"));
    expect(mocks.launch).toHaveBeenCalledWith(expect.objectContaining({ url: "/dashboard/media" }));
  });

  it("marks apps that already have a window, as the Dock does", async () => {
    let state: LaunchpadWindowState = "open";
    const windowState: WindowState = (target) => ("item" in target && target.item.url === "/dashboard/files" ? state : undefined);
    const user = await open(windowState);
    expect(option("Files — Open")).toBeVisible();
    expect(option("Media")).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    state = "minimized";
    await user.click(screen.getByRole("button", { name: "Open apps" }));
    expect(option("Files — Minimized")).toBeVisible();
  });

  it("hides and restores apps without launching or stopping them, and remembers visibility", async () => {
    const user = await open();
    await user.click(screen.getByRole("button", { name: "Customize" }));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Hide Media", exact: true }));
    expect(mocks.launch).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Done", exact: true }));
    expect(screen.queryByRole("option", { name: "Media", exact: true })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Open apps" }));
    expect(screen.queryByRole("option", { name: "Media", exact: true })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Customize" }));
    expect(screen.getByRole("button", { name: "Show Media", exact: true })).toHaveAttribute("aria-pressed", "false");
    await user.click(screen.getByRole("button", { name: "Reset", exact: true }));
    await user.click(screen.getByRole("button", { name: "Done", exact: true }));
    expect(option("Media")).toBeVisible();
  });

  it("leaves a hidden app out of browse but finds it in search, marked Hidden", async () => {
    const user = await open();
    await user.click(screen.getByRole("button", { name: "Customize" }));
    await user.click(screen.getByRole("button", { name: "Hide Media", exact: true }));
    await user.click(screen.getByRole("button", { name: "Done", exact: true }));
    expect(screen.queryByRole("option", { name: /^Media/ })).not.toBeInTheDocument();
    await user.type(search(), "media");
    expect(option("Media — Hidden")).toHaveAttribute("aria-selected", "true");
    expect(within(option("Media — Hidden")).getByText("Hidden")).toBeVisible();
  });

  it("dims only the icon of a hidden app in Customize, never its name", async () => {
    const stopped = { id: "jf", name: "jellyfin", image: "jellyfin:10", status: "stopped", labels: {}, ports: [], webUi: { port: 8096, protocol: "http", path: "/", title: "Jellyfin", source: "configured" } };
    mocks.stacks = [{ id: "jellyfin", name: "Jellyfin", kind: "talome", primaryContainer: stopped, containers: [stopped] }];
    const user = await open();
    await user.click(screen.getByRole("button", { name: "Customize" }));
    await user.click(screen.getByRole("button", { name: "Hide Media", exact: true }));
    await user.click(screen.getByRole("button", { name: "Hide Jellyfin — Stopped", exact: true }));
    for (const [name, texts] of [["Show Media", ["Media"]], ["Show Jellyfin — Stopped", ["Jellyfin", "Stopped"]]] as const) {
      const tile = screen.getByRole("button", { name, exact: true });
      expect(tile).toHaveAttribute("aria-pressed", "false");
      // No opacity between the text and the tile: the name and the second line
      // stay at full strength on the glass (WCAG 1.4.3)
      for (const text of texts) {
        for (const match of within(tile).getAllByText(text)) {
          for (let node: HTMLElement | null = match; node && node !== tile.parentElement; node = node.parentElement) {
            expect(node.className, `${name}: ${text} in ${node.tagName}`).not.toMatch(/\bopacity-/);
          }
        }
      }
      // The icon dims instead
      expect(tile.querySelector(".opacity-45.grayscale")).not.toBeNull();
    }
  });

  it("says when every app is hidden, and opens Customize from there", async () => {
    const primary = { id: "weather-container", name: "weather-ui", status: "running", ports: [] };
    mocks.stacks = [{ id: "weather", name: "Mountain Weather Station", storeId: "user-apps", appId: "weather", nativeSurface: { schemaVersion: 1 }, primaryContainer: primary, containers: [primary] }];
    const user = await open();
    await user.click(screen.getByRole("button", { name: "Customize" }));
    for (const tile of screen.getAllByRole("button", { name: /^Hide / })) await user.click(tile);
    await user.click(screen.getByRole("button", { name: "Done", exact: true }));
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("Every app is hidden. Search still finds them.")).toBeVisible();
    await user.type(search(), "weather");
    expect(option("Mountain Weather Station — Hidden")).toBeVisible();
    await user.clear(search());
    const customize = screen.getAllByRole("button", { name: "Customize" }).at(-1)!;
    await user.click(customize);
    expect(screen.getByRole("button", { name: "Done", exact: true })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Reset", exact: true })).toBeEnabled();
  });

  it("disables Reset while nothing is hidden", async () => {
    const user = await open();
    await user.click(screen.getByRole("button", { name: "Customize" }));
    expect(screen.getByRole("button", { name: "Reset", exact: true })).toBeDisabled();
    expect(screen.getByText("Hidden apps keep running. Saved for you in this browser.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Hide Files", exact: true }));
    expect(screen.getByRole("button", { name: "Reset", exact: true })).toBeEnabled();
    // Enter never launches while customizing
    search().focus();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("omits APIs and disambiguates searchable instances of the same browser app", async () => {
    const make = (id: string, ui: boolean) => ({ id, name: id, image: "mailpit:latest", status: "running", labels: { "com.docker.compose.project": id }, ports: [{host: 8025,container:8025,protocol:"tcp"}], webUi: ui ? {port:8025,protocol:"http",path:"/",title:"Mailpit",source:"detected"} : null });
    const a = make("finance-os", true), b = make("learning", true), api = make("api", false);
    mocks.stacks = [a,b,api].map(c => ({id:c.id,name:c.name,primaryContainer:c,containers:[c]}));
    const user = await open();
    expect(option("Mailpit — Finance OS")).toBeVisible();
    expect(option("Mailpit — Learning")).toBeVisible();
    expect(screen.queryByRole("option", {name:"api",exact:true})).not.toBeInTheDocument();
    await user.type(search(), "finance");
    await user.keyboard("{Enter}");
    expect(mocks.launchService).toHaveBeenCalledWith(expect.objectContaining({id:"finance-os"}));
  });

  it("keeps a stopped app listed as Stopped instead of dropping it (D-P0-3)", async () => {
    const stopped = { id: "jf", name: "jellyfin", image: "jellyfin:10", status: "stopped", labels: {}, ports: [], webUi: { port: 8096, protocol: "http", path: "/", title: "Jellyfin", source: "configured" } };
    mocks.stacks = [{ id: "jellyfin", name: "Jellyfin", kind: "talome", primaryContainer: stopped, containers: [stopped] }];
    await open();
    const tile = option("Jellyfin — Stopped");
    expect(tile).toHaveAttribute("data-launchpad-stopped", "true");
    // The word is visible, so grey is never the only signal
    expect(tile).toHaveTextContent("Stopped");
  });

  it("launches the best match on Enter, not whichever section comes first", async () => {
    const make = (name: string) => ({ id: name, name, image: `${name}:1`, status: "running", labels: {}, ports: [], webUi: { port: 1, protocol: "http", path: "/", title: name, source: "configured" } });
    const a = make("My Files Browser");
    mocks.stacks = [{ id: "fb", name: "fb", primaryContainer: a, containers: [a] }];
    const user = await open();
    await user.type(search(), "files");
    await user.keyboard("{Enter}");
    // "Files" (Talome) is an exact match; the service only contains it.
    expect(mocks.launch).toHaveBeenCalledWith(expect.objectContaining({ url: "/dashboard/files" }));
    expect(mocks.launchService).not.toHaveBeenCalled();
  });
});

describe("launchpadLockedHeight", () => {
  it("never locks below the floor, so Customize and the empty search always fit", () => {
    // Every app hidden: the browse body is only its padding
    expect(launchpadLockedHeight(74)).toBe(`max(74px, ${LAUNCHPAD_MIN_HEIGHT})`);
    expect(launchpadLockedHeight(412)).toBe(`max(412px, ${LAUNCHPAD_MIN_HEIGHT})`);
    expect(launchpadLockedHeight(null)).toBeUndefined();
    // Header (3rem), body padding (1.5rem) and the empty search state (about 11.75rem), plus a wrapped line
    expect(Number.parseFloat(LAUNCHPAD_MIN_HEIGHT)).toBeGreaterThanOrEqual(17.25);
  });
});

describe("nearestInRow", () => {
  /** Six 96px columns of 92px tiles from `top`, `count` tiles long. */
  const rows = (count: number, top: number): LaunchpadTileRect[] =>
    Array.from({ length: count }, (_, index) => ({
      left: (index % 6) * 100,
      top: top + Math.floor(index / 6) * 96,
      width: 96,
      height: 92,
    }));
  // Talome: 11 apps (a full row and a ragged row of 5); a 1px hairline and
  // gaps; installed: 8 apps (a full row and a ragged row of 2).
  const talome = rows(11, 0);
  const installed = rows(8, 2 * 96 + 17);
  const rects = [...talome, ...installed];

  it("moves to the same column in the next row", () => {
    expect(nearestInRow(rects, 2, 1)).toBe(8);
    expect(nearestInRow(rects, 8, -1)).toBe(2);
  });

  it("lands on the nearest tile of a ragged row", () => {
    // Column 6 of the first row has nothing below it in a row of five
    expect(nearestInRow(rects, 5, 1)).toBe(10);
    // Down from column 5 into installed's ragged second row (two tiles)
    expect(nearestInRow(rects, 15, 1)).toBe(18);
  });

  it("crosses the gap between groups in both directions", () => {
    expect(nearestInRow(rects, 7, 1)).toBe(12);
    expect(nearestInRow(rects, 12, -1)).toBe(7);
    // Up from column 6 of installed lands on the last Talome tile (column 5)
    expect(nearestInRow(rects, 16, -1)).toBe(10);
  });

  it("stays put at the edges, and on an unknown index", () => {
    expect(nearestInRow(rects, 3, -1)).toBe(3);
    expect(nearestInRow(rects, 18, 1)).toBe(18);
    expect(nearestInRow(rects, 99, 1)).toBe(99);
  });
});
