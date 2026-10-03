import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const embedded = vi.hoisted(() => ({ value: false }));
vi.mock("@/hooks/use-desktop-mode", () => ({
  useIsEmbeddedFrame: () => embedded.value,
}));

import {
  SourceList,
  SourceListItem,
  SourceListSection,
  SourceListSkeleton,
  WINDOW_SIDEBAR_REPLACES,
  WINDOW_SIDEBAR_SHOWS,
  WindowSidebarLayout,
  WindowSidebarSlot,
  useWindowSidebarShown,
} from "@/components/ui/source-list";
import { folderIcon } from "@/components/files/files-sidebar";
import { Delete02Icon, Download01Icon, Folder01Icon } from "@/components/icons";

function Sidebar({ onSelect = vi.fn() }: { onSelect?: () => void }) {
  return (
    <SourceList label="Test sidebar">
      <SourceListSection title="Library">
        <SourceListItem icon={Folder01Icon} label="Movies" active trailing={1200} onSelect={onSelect} />
        <SourceListItem label="TV shows" onSelect={onSelect} />
      </SourceListSection>
    </SourceList>
  );
}

describe("window sidebar", () => {
  beforeEach(() => {
    embedded.value = false;
  });

  it("stays out of the way outside a desktop window", () => {
    render(
      <WindowSidebarLayout sidebar={<Sidebar />}>
        <p>App content</p>
      </WindowSidebarLayout>,
    );

    expect(screen.getByText("App content")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Test sidebar" })).toBeNull();
  });

  it("shows a labelled source list in the window's sidebar slot", () => {
    embedded.value = true;
    const onSelect = vi.fn();
    render(
      <div>
        <WindowSidebarSlot />
        <WindowSidebarLayout sidebar={<Sidebar onSelect={onSelect} />}>
          <p>App content</p>
        </WindowSidebarLayout>
      </div>,
    );

    const nav = screen.getByRole("navigation", { name: "Test sidebar" });
    // Rendered into the window's slot beside the app, not inside the app's own
    // tree; the slot queries the window's named container, so it never shows
    // in classic mode (regression: an unnamed @2xl hid classic tab strips)
    const panel = nav.parentElement!;
    expect(panel).toHaveAttribute("data-window-sidebar");
    expect(panel).toHaveClass("hidden", "@3xl/window:flex");
    expect(panel.className).not.toMatch(/(^|\s)@2xl:/);
    // The slot is a panel inset on the window's glass: 8px from the top, left
    // and bottom edges, rounded, a card lift (the remapped, relative card)
    // and a hairline, with its top left to the window controls
    // Concentric with the window: 8px in from a rounded-2xl (18px) window, so 10px
    expect(panel).toHaveClass("m-2", "mr-0", "rounded-lg", "border", "border-window-separator", "bg-card", "pt-11");
    expect(panel.className).not.toMatch(/backdrop-blur|bg-background/);
    // The list itself paints nothing: no fill and no edge of its own
    expect(nav.className).not.toMatch(/\bbg-|\bborder-/);
    expect(nav).toHaveTextContent("Library");
    const movies = screen.getByRole("button", { name: /Movies/ });
    expect(movies).toHaveAttribute("aria-current", "page");
    expect(movies).toHaveTextContent(new Intl.NumberFormat().format(1200));
    screen.getByRole("button", { name: "TV shows" }).click();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("hides an empty panel, and its top drags the window while what it holds doesn't", () => {
    embedded.value = true;
    render(<WindowSidebarSlot />);
    const panel = document.querySelector<HTMLElement>("[data-window-sidebar]")!;
    // An app without a sidebar leaves the slot empty: no panel (globals.css)
    expect(panel).toBeEmptyDOMElement();
    expect(panel).toHaveClass("tm-window-sidebar");
    const css = readFileSync(join(__dirname, "../app/globals.css"), "utf8");
    expect(css).toMatch(/\.tm-window-sidebar:empty \{\s*display: none;\s*\}/);
    // A "surface" drag region: only the panel's own area (its top band) drags
    expect(panel).toHaveAttribute("data-window-drag-region", "surface");
  });

  it("names the classes that swap app controls for the sidebar", () => {
    expect(WINDOW_SIDEBAR_REPLACES).toBe("@3xl/window:hidden");
    expect(WINDOW_SIDEBAR_SHOWS).toBe("hidden @3xl/window:flex");
  });

  it("gives well-known folders their own icons", () => {
    expect(folderIcon("/data/Downloads")).toBe(Download01Icon);
    expect(folderIcon("/data/Holiday")).toBe(Folder01Icon);
  });
});

describe("SourceListItem", () => {
  it("is a compact row that grows to a 44px target on touch, with an inset focus ring", () => {
    render(<SourceListItem label="Movies" onSelect={vi.fn()} />);
    const row = screen.getByRole("button", { name: "Movies" });
    expect(row).toHaveClass("h-8", "phone-touch:h-11", "focus-visible:ring-2", "focus-visible:ring-inset", "text-foreground/80");
  });

  it("navigates with a link that marks the current place", () => {
    render(<SourceListItem label="Downloads" href="/dashboard/media?view=downloads" active />);
    const link = screen.getByRole("link", { name: "Downloads" });
    expect(link).toHaveAttribute("href", "/dashboard/media?view=downloads");
    expect(link).toHaveAttribute("aria-current", "page");
    expect(link).toHaveClass("bg-foreground/10");
  });

  it("says pressed, not current, for a filter row", () => {
    render(<SourceListItem label="4K" pressed active onSelect={vi.fn()} />);
    const row = screen.getByRole("button", { name: "4K" });
    expect(row).toHaveAttribute("aria-pressed", "true");
    expect(row).not.toHaveAttribute("aria-current");
  });

  it("can be disabled", () => {
    const onSelect = vi.fn();
    render(<SourceListItem label="Unavailable" disabled onSelect={onSelect} />);
    const row = screen.getByRole("button", { name: "Unavailable" });
    expect(row).toBeDisabled();
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(row).toHaveClass("opacity-50", "pointer-events-none");
    fireEvent.click(row);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("offers a secondary action that never selects the row", () => {
    const onSelect = vi.fn();
    const onRemove = vi.fn();
    render(
      <SourceListItem
        label="Backup drive"
        onSelect={onSelect}
        action={{ icon: Delete02Icon, label: "Remove Backup drive", onSelect: onRemove }}
      />,
    );

    const action = screen.getByRole("button", { name: "Remove Backup drive" });
    // Revealed on hover and focus; always shown with a 44px target on touch
    expect(action).toHaveClass("size-6", "group-hover/source-row:opacity-100", "group-focus-within/source-row:opacity-100", "pointer-coarse:opacity-100");
    fireEvent.click(action);
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Backup drive" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("never shows a count of zero", () => {
    render(<SourceListItem label="Trash" trailing={0} onSelect={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Trash" })).toHaveTextContent(/^Trash$/);
  });

  it("lifts the trailing count off muted on a hovered or selected row (regression: 3.7:1 on light glass)", () => {
    const trailingOf = (name: RegExp) =>
      screen.getByRole("button", { name }).querySelector<HTMLElement>("[data-slot='source-list-trailing']");
    render(
      <>
        <SourceListItem label="Movies" active trailing={1200} onSelect={vi.fn()} />
        <SourceListItem label="Shows" trailing={8} onSelect={vi.fn()} />
        <SourceListItem label="Drive" trailing={3} onSelect={vi.fn()} action={{ icon: Delete02Icon, label: "Eject Drive", onSelect: vi.fn() }} />
        <SourceListItem label="Offline" trailing={2} disabled onSelect={vi.fn()} />
        <SourceListItem label="Queue" trailing={<span>Paused</span>} onSelect={vi.fn()} />
      </>,
    );

    const selected = trailingOf(/Movies/);
    expect(selected).toHaveClass("text-foreground/70");
    expect(selected).not.toHaveClass("text-muted-foreground");
    expect(selected).toHaveTextContent(new Intl.NumberFormat().format(1200));

    // At rest muted; the row is the hover group, or the wrapper when there's an action
    expect(screen.getByRole("button", { name: /Shows/ })).toHaveClass("group/source-item");
    expect(trailingOf(/Shows/)).toHaveClass("text-muted-foreground", "group-hover/source-item:text-foreground/70");
    expect(trailingOf(/^Drive/)).toHaveClass("text-muted-foreground", "group-hover/source-row:text-foreground/70");
    expect(trailingOf(/Offline/)?.className).not.toMatch(/group-hover/);

    // A short status takes the same slot and tone unless it sets its own colour
    expect(trailingOf(/Queue/)).toHaveTextContent("Paused");
    expect(trailingOf(/Queue/)).toHaveClass("text-muted-foreground");
  });

  it("renders no trailing slot for nothing", () => {
    render(
      <>
        <SourceListItem label="Empty" trailing={null} onSelect={vi.fn()} />
        <SourceListItem label="Flag" trailing={false} onSelect={vi.fn()} />
      </>,
    );
    for (const name of ["Empty", "Flag"]) {
      expect(screen.getByRole("button", { name }).querySelector("[data-slot='source-list-trailing']")).toBeNull();
    }
  });

  it("passes button props through, including ref", () => {
    const ref = { current: null as HTMLButtonElement | null };
    render(<SourceListItem ref={ref} label="Movies" title="All movies" aria-describedby="hint" onSelect={vi.fn()} />);
    const row = screen.getByRole("button", { name: "Movies" });
    expect(ref.current).toBe(row);
    expect(row).toHaveAttribute("title", "All movies");
    expect(row).toHaveAttribute("aria-describedby", "hint");
  });
});

describe("SourceListSkeleton", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("appears only after 200ms, hidden from assistive tech", () => {
    vi.useFakeTimers();
    const { container } = render(<SourceListSkeleton rows={3} />);
    expect(container.querySelector("[data-slot='source-list-skeleton']")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    const skeleton = container.querySelector("[data-slot='source-list-skeleton']");
    expect(skeleton).toHaveAttribute("aria-hidden", "true");
    const rows = skeleton!.querySelectorAll("[data-slot='skeleton']");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveClass("h-8", "rounded-lg", "w-7/10");
  });
});

describe("useWindowSidebarShown", () => {
  beforeEach(() => {
    embedded.value = false;
  });

  it("is false outside a desktop window", () => {
    render(<WindowSidebarSlot />);
    const { result } = renderHook(() => useWindowSidebarShown());
    expect(result.current).toBe(false);
  });

  it("follows the slot's display inside a window", () => {
    embedded.value = true;
    const display = vi.spyOn(window, "getComputedStyle");
    display.mockReturnValue({ display: "none" } as CSSStyleDeclaration);
    function Probe() {
      return <p>{useWindowSidebarShown() ? "shown" : "hidden"}</p>;
    }
    const { rerender } = render(
      <div>
        <WindowSidebarSlot />
        <Probe />
      </div>,
    );
    expect(screen.getByText("hidden")).toBeInTheDocument();

    display.mockReturnValue({ display: "flex" } as CSSStyleDeclaration);
    rerender(
      <div>
        <WindowSidebarSlot />
        <Probe />
      </div>,
    );
    expect(screen.getByText("shown")).toBeInTheDocument();
    display.mockRestore();
  });
});
