/**
 * Media's controls on phones and tablets: the genre rail that stands in for
 * the window sidebar, Cinema and Select, and the floating selection bar.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/media/cinema-browser-launcher", () => ({ preloadCinemaBrowser: vi.fn() }));

import { MediaFiltersRow } from "@/components/media/media-filters-row";
import { MediaLibraryActions } from "@/components/media/media-library-actions";
import { MediaSelectionBar, type MediaSelectionBarAnchor } from "@/components/media/media-selection-bar";
import { WINDOW_SIDEBAR_REPLACES } from "@/components/ui/source-list";
import { contrast, over, parseColor, readTokens } from "./helpers/contrast";

const SRC = join(__dirname, "..");
const read = (path: string) => readFileSync(join(SRC, path), "utf8");
const classes = (element: Element) => element.className.split(/\s+/);

describe("Media genre rail on touch", () => {
  const props = {
    genres: ["Action", "Comedy", "Drama"],
    selectedGenres: [] as string[],
    minRating: null,
    onToggleGenre: vi.fn(),
    onClearFilters: vi.fn(),
  };

  it("gives All and every genre pill a 44px target on a coarse pointer, and 24px with a mouse", () => {
    render(<MediaFiltersRow {...props} />);
    const pills = ["All", ...props.genres].map((name) => screen.getByRole("button", { name }));
    for (const pill of pills) {
      expect(classes(pill), pill.textContent ?? "").toEqual(expect.arrayContaining(["h-6", "pointer-coarse:h-11", "pointer-coarse:px-3"]));
    }
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Comedy" }));
    expect(props.onToggleGenre).toHaveBeenCalledWith("Comedy");
  });

  it("fades only the trailing edge, so the first genre is whole before any scroll", () => {
    const { container } = render(<MediaFiltersRow {...props} />);
    expect(container.querySelector(".filter-rail")).toBeNull();
    const rail = container.querySelector<HTMLElement>("[data-media-genre-rail]");
    expect(rail).not.toBeNull();
    expect(rail!.className).toContain("[mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)]");
    expect(rail!.className).toContain("overflow-x-auto");
    // A spacer lets the last pill scroll clear of the fade
    expect(rail!.lastElementChild).toHaveAttribute("aria-hidden", "true");
    expect(rail!.lastElementChild?.className).toContain("w-4");
    // The window sidebar lists genres; the rail is for classic and narrow windows
    expect(rail!.closest(`[class~="${WINDOW_SIDEBAR_REPLACES}"]`)).not.toBeNull();
  });

  it("gives Clear filters the same touch target", () => {
    const onClearFilters = vi.fn();
    render(<MediaFiltersRow {...props} selectedGenres={["Drama"]} minRating={7} onClearFilters={onClearFilters} />);
    const clear = screen.getByRole("button", { name: "Clear filters" });
    expect(clear).toHaveTextContent("Clear");
    expect(classes(clear)).toEqual(expect.arrayContaining(["h-6", "pointer-coarse:h-11", "pointer-coarse:px-3"]));
    expect(screen.getByText("Drama · Rated 7+")).toBeInTheDocument();
    fireEvent.click(clear);
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });

  it("is no longer written inline in the page", () => {
    const page = read("app/dashboard/media/page.tsx");
    expect(page).not.toContain("filter-rail");
    expect(page).toContain("<MediaFiltersRow");
    expect(page).toContain("<MediaSelectionBar");
  });

  it("grows every 24px and 28px control on the page for a finger (Scan, Retry download)", () => {
    const page = read("app/dashboard/media/page.tsx");
    const small = page.split("\n").filter((line) => /className=.*\bh-[67]\b/.test(line));
    expect(small.length).toBeGreaterThanOrEqual(2);
    for (const line of small) expect(line.trim()).toMatch(/pointer-coarse:(h|size)-11\b/);
  });

  it.each(["header", "toolbar"] as const)("grows Cinema and Select for a finger in the %s", (placement) => {
    render(<MediaLibraryActions placement={placement} selecting={false} onCinema={vi.fn()} onToggleSelect={vi.fn()} />);
    for (const name of ["Cinema", "Select"]) {
      const button = classes(screen.getByRole("button", { name }));
      expect(button).toContain(placement === "header" ? "h-7" : "h-8");
      expect(button).toContain("pointer-coarse:h-11");
      // Icon-only in a narrow window column: 44px wide as well
      if (placement === "toolbar") expect(button).toContain("pointer-coarse:min-w-11");
    }
  });

  it("grows the toolbar's 32px search, selects and tabs, and the source-status Retry, for a finger", () => {
    const page = read("app/dashboard/media/page.tsx");
    const fields = page.split("\n").filter((line) => /className=.*\bh-8\b/.test(line));
    // Search, the Show, Sort and Minimum rating selects
    expect(fields.length).toBeGreaterThanOrEqual(4);
    for (const line of fields) expect(line.trim()).toMatch(/pointer-coarse:h-11\b/);
    // An xs button carries no height in its className, so check it by size
    for (const line of page.split("\n").filter((l) => /size="(xs|icon-xs)"/.test(l))) {
      expect(line.trim()).toMatch(/pointer-coarse:(h|size)-11\b/);
    }
    // The classic tab strip is icon-only on a phone: 44px tall and wide
    expect(page).toMatch(/<TabsList className="[^"]*pointer-coarse:h-12/);
    const trigger = page.slice(page.indexOf("<TabsTrigger"), page.indexOf("</TabsTrigger>"));
    expect(trigger).toMatch(/pointer-coarse:h-11 pointer-coarse:min-w-11/);
  });
});

describe("Media selection bar", () => {
  function renderBar(count = 3, anchor: MediaSelectionBarAnchor = "viewport") {
    const onRemove = vi.fn();
    const onCancel = vi.fn();
    const view = render(<MediaSelectionBar count={count} anchor={anchor} onRemove={onRemove} onCancel={onCancel} />);
    return { ...view, onRemove, onCancel };
  }

  it("is the Files selection bar, not a copy of it", () => {
    const source = read("components/media/media-selection-bar.tsx");
    expect(source).toContain('from "@/components/files/selection-bar"');
    expect(source).toContain("<SelectionBar ");
    expect(source).not.toContain("<Button");
  });

  it("names Remove and Cancel when a phone shows only their icons", () => {
    const { onRemove, onCancel } = renderBar();
    // The pill is a group named by its count
    const bar = screen.getByRole("group", { name: "3 selected" });
    const remove = within(bar).getByRole("button", { name: "Remove" });
    const cancel = within(bar).getByRole("button", { name: "Cancel" });
    for (const button of [remove, cancel]) {
      // Visually hidden where the column is narrow (a container query, not the viewport), never display:none
      const label = within(button).getByText(button.textContent ?? "");
      expect(classes(label)).toEqual(["sr-only", "@md:not-sr-only"]);
    }
    fireEvent.click(remove);
    fireEvent.click(cancel);
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("gives both buttons a 44px target on a coarse pointer", () => {
    renderBar();
    for (const name of ["Remove", "Cancel"]) {
      expect(classes(screen.getByRole("button", { name }))).toEqual(
        expect.arrayContaining(["h-7", "pointer-coarse:h-11", "pointer-coarse:min-w-11"]),
      );
    }
  });

  it("paints Remove with the inverse critical token and keeps hovers and focus on the pill", () => {
    renderBar();
    const remove = classes(screen.getByRole("button", { name: "Remove" }));
    expect(remove).toContain("text-status-critical-inverse");
    expect(remove).not.toContain("text-status-critical");
    expect(classes(screen.getByRole("button", { name: "Cancel" }))).toContain("text-background/70");
    for (const name of ["Remove", "Cancel"]) {
      const button = classes(screen.getByRole("button", { name }));
      expect(button).toContain("hover:bg-background/10");
      // A page-grey hover would paint over the inverted pill, and a page-coloured ring would vanish on it
      expect(button.filter((c) => /hover:(bg|text)-accent/.test(c))).toEqual([]);
      expect(button).toContain("focus-visible:ring-background");
    }
  });

  it("floats over the screen on the classic page, and above the status bar in a window", () => {
    const { unmount } = renderBar(3, "viewport");
    const floating = (bar: HTMLElement) => classes(bar.closest("[data-selection-bar]")!.parentElement!);
    expect(floating(screen.getByRole("group"))).toEqual(
      expect.arrayContaining(["fixed", "inset-x-0", "bottom-6", "z-50", "pb-[env(safe-area-inset-bottom)]"]),
    );
    unmount();
    renderBar(3, "status-bar");
    const anchored = floating(screen.getByRole("group"));
    expect(anchored).toEqual(expect.arrayContaining(["absolute", "inset-x-0", "bottom-full", "mb-3"]));
    expect(anchored).not.toContain("fixed");
  });

  it("renders nothing without a selection", () => {
    const { container } = renderBar(0);
    expect(container.querySelector("[data-selection-bar]")).toBeNull();
  });

  describe("contrast on the inverted pill", () => {
    const css = read("app/globals.css");
    const light = readTokens(css, ":root");
    const dark = readTokens(css, ".dark", light);

    it.each([
      ["light", light],
      ["dark", dark],
    ] as const)("keeps Remove and Cancel at 4.5:1 at rest and on hover in %s", (name, tokens) => {
      const pill = parseColor(tokens["--foreground"]);
      const page = parseColor(tokens["--background"]);
      const hover = over(page, pill, 0.1);
      const critical = parseColor(tokens["--status-critical-inverse"]);
      expect(contrast(critical, pill), `${name} Remove`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(critical, hover), `${name} Remove hover`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(over(page, pill, 0.7), pill), `${name} Cancel`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(page, hover), `${name} Cancel hover`).toBeGreaterThanOrEqual(4.5);
      // Why the inverse token: the plain one fails on the pill in one theme
      const plain = parseColor(tokens["--status-critical"]);
      if (name === "dark") expect(contrast(plain, pill)).toBeLessThan(4.5);
    });
  });
});
