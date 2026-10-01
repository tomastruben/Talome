import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MEDIA_VIEW_INLINE, MEDIA_VIEW_MENU, MediaViewMenu, type MediaViewMenuProps } from "@/components/media/media-view-menu";
import {
  MEDIA_COLLECTIONS,
  RATING_OPTIONS,
  SORT_LABELS,
  TAB_LABELS,
  collectionLabel,
} from "@/components/media/media-library-view";

const SRC = join(__dirname, "..");
const read = (path: string) => readFileSync(join(SRC, path), "utf8");
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");
const css = stripComments(read("app/globals.css"));

const REM = 16;

/** Every innermost rule as [selector, body]; a rule inside @media/@container keeps its own selector. */
function rules(source: string): [string, string][] {
  return Array.from(source.matchAll(/([^{}]+)\{([^{}]*)\}/g), (m) => [m[1].trim(), m[2]]);
}

/** The @-rule preludes (@layer, @media, @container…) enclosing an offset. */
function enclosingPreludes(source: string, offset: number): string[] {
  const stack: string[] = [];
  let start = 0;
  for (let i = 0; i < offset; i++) {
    const ch = source[i];
    if (ch === "{") {
      stack.push(source.slice(start, i).trim());
      start = i + 1;
    } else if (ch === "}") {
      stack.pop();
      start = i + 1;
    } else if (ch === ";") {
      start = i + 1;
    }
  }
  return stack.filter((prelude) => prelude.startsWith("@"));
}

function spaceToken(name: string): number {
  const match = css.match(new RegExp(`--space-${name}:\\s*([\\d.]+)rem`));
  if (!match) throw new Error(`--space-${name} not found`);
  return Number(match[1]) * REM;
}

interface GridModel {
  /** clamp(lo, base + perCqi * cqi, hi), in px and px per cqi */
  lo: number;
  base: number;
  perCqi: number;
  hi: number;
  columnGap: number;
  /** Column gap from the wide step on */
  wideColumnGap: number;
  wideFrom: number;
}

/** Reads a poster grid's track sizing and gaps from globals.css. */
function gridModel(selector: ".media-grid" | ".audiobook-grid"): GridModel {
  const escaped = selector.replace(".", "\\.");
  const base = css.match(new RegExp(`${escaped} \\{([^}]*)\\}`));
  if (!base) throw new Error(`${selector} not found`);
  const clamp = base[1].match(/clamp\(([\d.]+)rem,\s*([\d.]+)rem \+ ([\d.]+)cqi,\s*([\d.]+)rem\)/);
  if (!clamp) throw new Error(`${selector} has no container-relative clamp()`);
  const gap = base[1].match(/gap:\s*var\(--space-(\w+)\)\s+var\(--space-(\w+)\)/);
  if (!gap) throw new Error(`${selector} has no row and column gap`);
  const wide = css.match(new RegExp(`@container \\(min-width: ([\\d.]+)rem\\) \\{\\s*${escaped} \\{\\s*gap:\\s*var\\(--space-(\\w+)\\)\\s+var\\(--space-(\\w+)\\)`));
  if (!wide) throw new Error(`${selector} has no wide gap step`);
  return {
    lo: Number(clamp[1]) * REM,
    base: Number(clamp[2]) * REM,
    perCqi: Number(clamp[3]),
    hi: Number(clamp[4]) * REM,
    columnGap: spaceToken(gap[2]),
    wideColumnGap: spaceToken(wide[3]),
    wideFrom: Number(wide[1]) * REM,
  };
}

/** The window shell's gutter (.tm-window-content): 1rem, 1.5rem from a 30rem column. */
const windowPad = (column: number) => (column >= 30 * REM ? 1.5 * REM : 1 * REM);

/** auto-fill with minmax(min(clamp(…), 100%), 1fr): how many tracks fit, and how wide each one is. */
function layout(model: GridModel, column: number, pad = windowPad(column)) {
  const width = column - 2 * pad;
  const cqi = column / 100;
  const gap = column >= model.wideFrom ? model.wideColumnGap : model.columnGap;
  const min = Math.min(Math.min(model.hi, Math.max(model.lo, model.base + model.perCqi * cqi)), width);
  const columns = Math.max(1, Math.floor((width + gap) / (min + gap)));
  return { columns, poster: (width - gap * (columns - 1)) / columns, min };
}

/** The window sidebar (SourceList w-56) and its hairline. */
const SIDEBAR = 224 + 1;

/**
 * What the classic page loses beside the app sidebar: the inset sidebar's gap
 * (SIDEBAR_WIDTH in components/ui/sidebar.tsx) and <SidebarInset>'s m-2 on the
 * right.
 */
const CLASSIC_SIDEBAR = (() => {
  const match = read("components/ui/sidebar.tsx").match(/const SIDEBAR_WIDTH = "([\d.]+)rem"/);
  if (!match) throw new Error("SIDEBAR_WIDTH not found");
  return Number(match[1]) * REM + 8;
})();

describe("Media poster grid in a window", () => {
  const media = gridModel(".media-grid");

  it("shows about four posters across a 760px window and five at a 760px column", () => {
    expect(layout(media, 760 - SIDEBAR).columns).toBeGreaterThanOrEqual(4);
    expect(layout(media, 760 - SIDEBAR).columns).toBeLessThanOrEqual(6);
    // Overlay scrollbars take no width; a classic scrollbar (15px) must not drop a column
    expect(layout(media, 760 - SIDEBAR - 15).columns).toBeGreaterThanOrEqual(4);

    const wide = layout(media, 760);
    expect(wide.columns).toBeGreaterThanOrEqual(4);
    expect(wide.columns).toBeLessThanOrEqual(6);
    expect(wide.min).toBeGreaterThanOrEqual(120);
    expect(wide.min).toBeLessThanOrEqual(140);
  });

  it("adds columns as the column widens and never drops one", () => {
    let previous = 0;
    for (let column = 420; column <= 1200; column += 4) {
      const { columns, poster } = layout(media, column);
      expect(columns, `${column}px column`).toBeGreaterThanOrEqual(previous);
      expect(poster, `${column}px column`).toBeGreaterThanOrEqual(96);
      expect(poster, `${column}px column`).toBeLessThanOrEqual(200);
      previous = columns;
    }
    expect(layout(media, 1200).columns).toBeGreaterThanOrEqual(6);
  });

  it("keeps a sensible density in classic mode", () => {
    // Phone: the page is the container, padded p-4
    expect(layout(media, 390, 16).columns).toBe(3);
    // A 1440px desktop browser: the page beside the 208px sidebar, padded p-6
    expect(CLASSIC_SIDEBAR).toBe(208 + 8);
    const desktop = layout(media, 1440 - CLASSIC_SIDEBAR, 24);
    expect(desktop.columns).toBeGreaterThanOrEqual(6);
    expect(desktop.columns).toBeLessThanOrEqual(8);
    expect(desktop.poster).toBeGreaterThanOrEqual(140);
  });

  it("gives audiobook covers the same container-relative growth", () => {
    const audiobooks = gridModel(".audiobook-grid");
    let previous = 0;
    for (let column = 420; column <= 1200; column += 4) {
      const { columns } = layout(audiobooks, column);
      expect(columns, `${column}px column`).toBeGreaterThanOrEqual(previous);
      previous = columns;
    }
    expect(layout(audiobooks, 760 - SIDEBAR).columns).toBeGreaterThanOrEqual(3);
  });

  it("sizes poster grids by the container, never the viewport", () => {
    for (const [selector, body] of rules(css)) {
      if (!/\.(media|audiobook)-grid\b/.test(selector)) continue;
      expect(body, selector).not.toMatch(/\bvw\b/);
    }
    expect(css).not.toMatch(/@media[^{]*\{\s*\.(media|audiobook)-grid/);
  });
});

describe("Media hover never zooms", () => {
  const posterRules = rules(css).filter(([selector]) => /\.media-card|\.audiobook-card-cover/.test(selector));

  it("doesn't scale, lift or clip poster cards in CSS", () => {
    expect(posterRules.length).toBeGreaterThan(0);
    for (const [selector, body] of posterRules) {
      if (selector.includes(".tm-tilt")) continue; // the reduced-motion override, below
      expect(body, selector).not.toMatch(/\btransform\s*:/);
      expect(body, selector).not.toMatch(/will-change/);
    }
    const card = posterRules.find(([selector]) => selector === ".media-card");
    expect(card?.[1]).toBeDefined();
    // Nothing outside the poster is clipped: the poster clips its own artwork
    expect(card?.[1]).not.toMatch(/overflow\s*:\s*hidden/);
    const hover = posterRules.filter(([selector]) => selector.includes(":hover"));
    expect(hover.length).toBeGreaterThan(0);
    for (const [selector, body] of hover) {
      expect(body, selector).toMatch(/filter\s*:/);
    }
  });

  it("keeps posters and covers flat under reduced motion, unlayered so it beats .tm-tilt", () => {
    const at = css.indexOf(".media-card-poster.tm-tilt");
    expect(at).toBeGreaterThan(-1);
    const preludes = enclosingPreludes(css, at);
    expect(preludes.some((prelude) => prelude.startsWith("@layer"))).toBe(false);
    expect(preludes.some((prelude) => /prefers-reduced-motion:\s*reduce/.test(prelude))).toBe(true);
    const rule = rules(css).find(([selector]) => selector.includes(".media-card-poster.tm-tilt"));
    expect(rule?.[0]).toContain(".audiobook-card-cover.tm-tilt");
    expect(rule?.[1]).toMatch(/transform\s*:\s*none/);
  });

  it.each([
    "app/dashboard/media/page.tsx",
    "app/dashboard/media/[type]/[id]/page.tsx",
    "components/media/cinema-browser.tsx",
    "components/media/episode-browser.tsx",
    "components/media/watching-tab.tsx",
    "components/media/requests-tab.tsx",
  ])("scales nothing on hover or focus in %s", (path) => {
    const source = read(path);
    expect(source).not.toMatch(/(?:hover|focus|focus-visible|group-hover|group-focus-visible):scale-/);
    // Static scale on a focused card (a TV-style zoom) is clipped by its rail
    // too. A blurred backdrop is enlarged to hide its soft edges; that stays.
    const scaled = source.split("\n").filter((line) => /\bscale-1(?:0\d|10)\b/.test(line) && !/\bblur-/.test(line));
    expect(scaled).toEqual([]);
  });
});

describe("Sort and filter menu", () => {
  const props = (overrides: Partial<MediaViewMenuProps> = {}): MediaViewMenuProps => ({
    libraryTab: "movies",
    collections: ["all", "recent", "unwatched"],
    collection: "all",
    sort: "added-desc",
    minRating: null,
    onCollectionChange: vi.fn(),
    onSortChange: vi.fn(),
    onMinRatingChange: vi.fn(),
    ...overrides,
  });
  const open = (name = "Sort and filter") => fireEvent.keyDown(screen.getByRole("button", { name }), { key: "Enter" });

  it("folds sort, rating and the collection into one menu", async () => {
    const p = props();
    render(<MediaViewMenu {...p} />);
    open();

    expect(await screen.findByRole("menuitemradio", { name: "Date added, newest" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: "All movies" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: "Any rating" })).toHaveAttribute("aria-checked", "true");
    // Group labels are sentence case
    expect(screen.getByText("Sort by")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitemradio", { name: "Title, A to Z" }));
    expect(p.onSortChange).toHaveBeenCalledWith("title-asc");
  });

  it("sets and clears the minimum rating", async () => {
    const p = props({ minRating: 7 });
    render(<MediaViewMenu {...p} />);
    // A hidden filter is never a surprise: the button says so
    open("Sort and filter, filtered");
    expect(await screen.findByRole("menuitemradio", { name: "Rated 7 or higher" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Any rating" }));
    expect(p.onMinRatingChange).toHaveBeenCalledWith(null);
  });

  it("picks a collection, and leaves collections to the window sidebar when it shows them", async () => {
    const p = props();
    const { unmount } = render(<MediaViewMenu {...p} />);
    open();
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Recently added" }));
    expect(p.onCollectionChange).toHaveBeenCalledWith("recent");
    unmount();

    render(<MediaViewMenu {...props({ collections: null, collection: "recent" })} />);
    // The collection isn't a filter here: the sidebar and the heading show it
    open("Sort and filter");
    expect(await screen.findByRole("menuitemradio", { name: "Title, A to Z" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitemradio", { name: "All movies" })).toBeNull();
    expect(screen.queryByText("Show")).toBeNull();
  });

  it("is the narrow half of one toolbar: inline selects where the column is wide", () => {
    // Exactly one of the two shows at any column width, by container query
    expect(MEDIA_VIEW_INLINE.split(" ")).toEqual(["hidden", "@3xl/content:flex", "@7xl:flex"]);
    expect(MEDIA_VIEW_MENU.split(" ")).toEqual(["@3xl/content:hidden", "@7xl:hidden"]);
    expect(MEDIA_VIEW_INLINE + MEDIA_VIEW_MENU).not.toMatch(/(?:^|\s)(?:sm|md|lg|xl|2xl):/);
  });
});

describe("Media library toolbar fits one row", () => {
  const page = read("app/dashboard/media/page.tsx");

  /** Tailwind's container sizes, in rem. */
  const CONTAINER_REM: Record<string, number> = {
    md: 28, lg: 32, xl: 36, "2xl": 42, "3xl": 48, "4xl": 56, "5xl": 64, "6xl": 72, "7xl": 80,
  };
  function containerPx(size: string): number {
    const rem = CONTAINER_REM[size];
    if (rem === undefined) throw new Error(`Unknown container size @${size}`);
    return rem * REM;
  }

  // ── Text ───────────────────────────────────────────────────────────────────
  // Geist advance widths at text-xs (11px), in px: measured from the font's
  // hmtx table (Geist 1.7; Medium for tab labels and counts, Regular for select
  // values) and rounded up to the half pixel. Kerning is left out: it takes a
  // pixel or two off, never adds. Counts are tabular-nums, so every digit
  // takes the widest digit's advance (0, 7.4px).
  const MEDIUM: Record<string, number> = {
    Movies: 37.5, "TV shows": 50.5, Downloads: 58.5, Calendar: 47.5, Activity: 41,
  };
  const REGULAR: Record<string, number> = {
    "Date added, newest": 102, "Date added, oldest": 96, "Title, A to Z": 57, "Title, Z to A": 57,
    "Year, newest": 65.5, "Year, oldest": 60,
    "All movies": 52.5, "All shows": 49.5, "Recently added": 80, Unwatched: 58.5, "Missing file": 58.5,
    "Ready to play": 70, "Needs conversion": 92,
    "Any rating": 53, "Rated 6+": 46, "Rated 7+": 45.5, "Rated 8+": 46.5, "Rated 9+": 46,
  };
  const DIGIT = 7.5;
  const COMMA = 2.5;
  function measured(table: Record<string, number>, text: string): number {
    const width = table[text];
    if (width === undefined) throw new Error(`No measured width for "${text}"`);
    return width;
  }
  const numeral = (count: string) => Array.from(count).reduce((sum, ch) => sum + (ch === "," ? COMMA : DIGIT), 0);

  const SORT_VALUES = Object.values(SORT_LABELS);
  const SHOW_VALUES = (["movies", "tv"] as const).flatMap((tab) => MEDIA_COLLECTIONS.map((c) => collectionLabel(tab, c)));
  const RATING_VALUES = ["Any rating", ...RATING_OPTIONS.map((rating) => `Rated ${rating}+`)];
  const widest = (values: string[]) => values.reduce((a, b) => (measured(REGULAR, b) > measured(REGULAR, a) ? b : a));

  // ── Geometry (components/ui/tabs.tsx, badge.tsx, select.tsx, button.tsx) ──
  /** <TabsBadge>: px-1, min-w-5 */
  const tabsBadge = (count: string) => Math.max(20, 8 + numeral(count));
  /** <Badge variant="count">: px-1 inside a 1px border, min-w-4 */
  const countBadge = (count: string) => Math.max(16, 2 + 8 + numeral(count));
  /** <TabsTrigger>: 1px border, px-2.5, a 14px icon pulled in by -mx-0.5, gap-1.5 before the label and the count */
  const tab = (label: string | null, badge: number | null) =>
    2 + 20 + 14 - 4 + (label === null ? 0 : 6 + measured(MEDIUM, label)) + (badge === null ? 0 : 6 + badge);
  /** <TabsList>: p-0.5, gap-x-0.5 */
  const tabList = (tabs: number[]) => 4 + 2 * (tabs.length - 1) + tabs.reduce((a, b) => a + b, 0);
  /** <SelectTrigger>: 1px border, px-3, gap-2, a 16px chevron, and the trigger's min-w */
  const select = (value: string, minWidth: number) => Math.max(minWidth, 2 + 24 + 8 + 16 + measured(REGULAR, value));
  /** gap-2 between the toolbar's items, inside the controls and between the selects */
  const GAP = 8;
  /** The Sort and filter button (icon-sm) */
  const MENU_BUTTON = 32;

  // ── Thresholds, read from the code ───────────────────────────────────────
  const inlineTokens = MEDIA_VIEW_INLINE.split(" ");
  const classicInlineSize = inlineTokens.find((t) => /^@[\w-]+:flex$/.test(t))?.match(/^@([\w-]+):/)?.[1];
  const windowInlineSize = inlineTokens.find((t) => /^@[\w-]+\/content:flex$/.test(t))?.match(/^@([\w-]+)\//)?.[1];
  const labelSize = page.match(/<span className="hidden @([\w-]+):inline">\{t\.label\}<\/span>/)?.[1];
  const searchClasses = page.match(/<SearchField\s+containerClassName="([^"]+)"/)?.[1].split(/\s+/) ?? [];

  /** The search field's width at a container width: classic resolves only unnamed queries, a window also /content ones. */
  function searchWidth(context: "classic" | "window", container: number): number {
    let width = 0;
    let from = -1;
    for (const token of searchClasses) {
      const match = token.match(/^(?:@([\w-]+?)(\/content)?:)?w-(\d+)$/);
      if (!match) continue;
      const [, size, named] = match;
      if (named && context === "classic") continue;
      const threshold = size ? containerPx(size) : 0;
      if (container >= threshold && threshold > from) {
        width = Number(match[3]) * 4;
        from = threshold;
      }
    }
    if (width === 0) throw new Error("No search width");
    return width;
  }

  // ── Libraries ─────────────────────────────────────────────────────────────
  interface Library {
    movies: string;
    tv: string;
    /** Pending downloads, or null where the tab shows no count */
    downloads: string | null;
    /** Requests awaiting approval, or null */
    requests: string | null;
    show: string;
    sort: string;
    rating: string;
  }
  const QUIET: Library = {
    movies: "440", tv: "120", downloads: null, requests: null,
    show: collectionLabel("movies", "all"), sort: SORT_LABELS["added-desc"], rating: "Any rating",
  };
  /** Every count showing at four digits and every select on its longest value */
  const BUSY: Library = {
    movies: "1,234", tv: "1,234", downloads: "99", requests: "12",
    show: widest(SHOW_VALUES), sort: widest(SORT_VALUES), rating: widest(RATING_VALUES),
  };

  // ── Classic page: main is the container ──────────────────────────────────
  /** The page pads p-6; a classic (non-overlay) scrollbar takes 15px from the scroller. */
  const classicContent = (main: number, scrollbar = 15) => main - 48 - scrollbar;

  function classicRow(lib: Library, main: number): number {
    const labels = main >= containerPx(labelSize!);
    const inline = main >= containerPx(classicInlineSize!);
    const label = (text: string) => (labels ? text : null);
    const tabs = tabList([
      tab(label(TAB_LABELS.movies), tabsBadge(lib.movies)),
      tab(label(TAB_LABELS.tv), tabsBadge(lib.tv)),
      tab(label(TAB_LABELS.downloads), lib.downloads === null ? null : tabsBadge(lib.downloads)),
      tab(label(TAB_LABELS.calendar), null),
      tab(label(TAB_LABELS.activity), lib.requests === null ? null : countBadge(lib.requests)),
    ]);
    // Classic has no window sidebar, so the Show select is there too
    const views = inline
      ? select(lib.show, 112) + GAP + select(lib.sort, 112) + GAP + select(lib.rating, 96)
      : MENU_BUTTON;
    return tabs + GAP + searchWidth("classic", main) + GAP + views;
  }

  // ── Window: the column beside the sidebar is the container ───────────────
  /** .tm-window-toolbar pads by --window-pad: 1rem, 1.5rem from a 30rem column. */
  const windowToolbarWidth = (column: number) => column - 2 * windowPad(column);

  /** With the sidebar showing, the heading (flex-1, truncating) shares the row; the sidebar lists the collections. */
  function windowControls(lib: Library, column: number): number {
    const inline = column >= containerPx(windowInlineSize!);
    const views = inline ? select(lib.sort, 112) + GAP + select(lib.rating, 96) : MENU_BUTTON;
    return searchWidth("window", column) + GAP + views;
  }

  it("reads its thresholds from the page and the menu", () => {
    expect(classicInlineSize).toBeDefined();
    expect(windowInlineSize).toBeDefined();
    expect(labelSize).toBeDefined();
    expect(searchClasses).toContain("w-48");
    // The menu hides exactly where the selects show
    expect(MEDIA_VIEW_MENU.split(" ").sort()).toEqual(
      inlineTokens.filter((t) => t !== "hidden").map((t) => t.replace(/:flex$/, ":hidden")).sort(),
    );
  });

  it("has a measured width for every label it can show", () => {
    for (const label of Object.values(TAB_LABELS)) expect(MEDIUM[label], label).toBeDefined();
    for (const value of [...SORT_VALUES, ...SHOW_VALUES, ...RATING_VALUES]) expect(REGULAR[value], value).toBeDefined();
    // The busy library really is the worst case
    expect(BUSY.show).toBe("Needs conversion");
    expect(BUSY.sort).toBe("Date added, newest");
  });

  it("keeps the classic toolbar to one row at every page width from 48rem, with every count showing", () => {
    for (let main = containerPx("3xl"); main <= 1920; main += 4) {
      for (const [name, lib] of [["quiet", QUIET], ["busy", BUSY]] as const) {
        expect(classicRow(lib, main), `${name} library, ${main}px page`).toBeLessThanOrEqual(classicContent(main));
      }
    }
  });

  it("puts the classic labels and selects inline only where they fit, with room to spare in a typical library", () => {
    const labelsFrom = containerPx(labelSize!);
    const inlineFrom = containerPx(classicInlineSize!);
    expect(inlineFrom).toBeGreaterThan(labelsFrom);
    // A 1440px browser beside the sidebar gets the menu; the selects need a wider page
    expect(1440 - CLASSIC_SIDEBAR).toBeLessThan(inlineFrom);
    // A typical library keeps at least 64px spare at each step, even with a classic scrollbar
    for (const at of [labelsFrom, inlineFrom]) {
      expect(classicContent(at) - classicRow(QUIET, at), `${at}px page`).toBeGreaterThanOrEqual(64);
    }
    // One step lower (72rem) even a typical library's row with the selects would wrap
    expect(classicRow(QUIET, inlineFrom)).toBeGreaterThan(classicContent(containerPx("6xl")));
  });

  it("keeps the window toolbar to one row beside the sidebar, with room for the heading", () => {
    // The sidebar shows from a 42rem window; the column is what's left of it
    const narrowest = containerPx("2xl") - SIDEBAR;
    for (let column = narrowest; column <= 1600; column += 4) {
      const spare = windowToolbarWidth(column) - GAP - windowControls(BUSY, column);
      expect(spare, `${column}px column`).toBeGreaterThanOrEqual(120);
    }
  });
});
