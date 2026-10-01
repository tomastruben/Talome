/**
 * Media's classic-mode controls on phones and tablets: the genre rail that
 * stands in for the window sidebar, and the floating selection bar.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MediaFiltersRow } from "@/components/media/media-filters-row";
import { MediaSelectionBar } from "@/components/media/media-selection-bar";
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

  it("grows every 24px and 28px control on the page for a finger (Select, Cinema, Scan, Retry download)", () => {
    const page = read("app/dashboard/media/page.tsx");
    const small = page.split("\n").filter((line) => /className=.*\bh-[67]\b/.test(line));
    expect(small.length).toBeGreaterThanOrEqual(4);
    for (const line of small) expect(line.trim()).toMatch(/pointer-coarse:(h|size)-11\b/);
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
  function renderBar(count = 3) {
    const onRemove = vi.fn();
    const onCancel = vi.fn();
    const view = render(<MediaSelectionBar count={count} onRemove={onRemove} onCancel={onCancel} />);
    return { ...view, onRemove, onCancel };
  }

  it("names Remove and Cancel when a phone shows only their icons", () => {
    const { onRemove, onCancel } = renderBar();
    const remove = screen.getByRole("button", { name: "Remove" });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    for (const button of [remove, cancel]) {
      // Visually hidden below sm, never display:none
      const label = within(button).getByText(button.textContent ?? "");
      expect(classes(label)).toEqual(["sr-only", "sm:not-sr-only"]);
    }
    fireEvent.click(remove);
    fireEvent.click(cancel);
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.getByText("3 selected")).toBeInTheDocument();
  });

  it("gives both buttons a 44px target on a coarse pointer", () => {
    renderBar();
    for (const name of ["Remove", "Cancel"]) {
      expect(classes(screen.getByRole("button", { name }))).toEqual(
        expect.arrayContaining(["h-7", "pointer-coarse:h-11", "pointer-coarse:min-w-11"]),
      );
    }
  });

  it("paints Remove with the inverse critical token and keeps hovers on the pill", () => {
    renderBar();
    const remove = classes(screen.getByRole("button", { name: "Remove" }));
    expect(remove).toContain("text-status-critical-inverse");
    expect(remove).toContain("hover:text-status-critical-inverse");
    expect(remove).not.toContain("text-status-critical");
    for (const name of ["Remove", "Cancel"]) {
      const button = classes(screen.getByRole("button", { name }));
      expect(button).toEqual(expect.arrayContaining(["hover:bg-background/10", "dark:hover:bg-background/10"]));
      // The ghost button's page-grey hovers would paint over the inverted pill
      expect(button.filter((c) => /hover:(bg|text)-accent/.test(c))).toEqual([]);
    }
  });

  it("renders nothing without a selection", () => {
    const { container } = renderBar(0);
    expect(container.querySelector("[data-media-selection-bar]")).toBeNull();
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
