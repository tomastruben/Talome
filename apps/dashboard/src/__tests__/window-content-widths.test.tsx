/**
 * Content areas that fit a desktop window at any width (420, 560, 760 and
 * 1100px columns), in classic mode too.
 *
 * Inside a window the iframe's viewport is the whole window, sidebar
 * included, so viewport breakpoints (sm:, md:) overestimate the content
 * column by the sidebar's 14rem. Toolbars and rows therefore size by their
 * container (the window's content column, the classic page, or a section),
 * the App Store, Services and Audiobooks toolbars keep one row that wraps only
 * when the search can't keep 10rem, and choices CSS can't make (a menu in a
 * portal) measure the list itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/dashboard/apps",
}));
vi.mock("next/image", () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} />,
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/hooks/use-desktop-mode", () => ({ useIsEmbeddedFrame: () => false }));
vi.mock("@/hooks/use-system-stats", () => ({ useSystemStats: () => ({ stats: null }) }));

import AppsPage from "@/app/dashboard/apps/page";
import { appStoreViewTitle, categoryLabel, sourceLabel } from "@/app/dashboard/apps/_lib/app-store-view";
import { INLINE_BACKUP_ACTIONS_MIN_WIDTH, fitsInlineBackupActions } from "@/app/dashboard/backups/_lib/use-min-width";
import { FilesSidebar } from "@/components/files/files-sidebar";
import { WINDOW_SIDEBAR_SHOWS } from "@/components/ui/source-list";

const SRC = join(__dirname, "..");
const read = (path: string) => readFileSync(join(SRC, path), "utf-8");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

/** A viewport breakpoint utility (sm:, md:, lg:, xl:), not a container query (@md:) */
const VIEWPORT_BREAKPOINT = /(?:^|[\s"'`])(?:max-)?(?:sm|md|lg|xl|2xl):[\w[\-]/;

/** The JSX of every <DesktopAppToolbar> in a file */
function toolbars(text: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf("<DesktopAppToolbar", from);
    if (start < 0) return out;
    const end = text.indexOf("</DesktopAppToolbar>", start);
    out.push(text.slice(start, end));
    from = end;
  }
}

describe("App Store view names", () => {
  it("names sources, the library and categories in sentence case", () => {
    expect(appStoreViewTitle("all")).toBe("All apps");
    expect(appStoreViewTitle("installed")).toBe("Installed");
    expect(appStoreViewTitle("user-created")).toBe("My Apps");
    expect(appStoreViewTitle("casaos")).toBe("CasaOS");
    expect(sourceLabel("talome")).toBe("Talome");
    expect(categoryLabel("media")).toBe("Media");
    expect(categoryLabel("ai")).toBe("AI");
  });
});

describe("Backups row actions", () => {
  it("fit inline from 56rem of list, else they go in the row's menu", () => {
    expect(INLINE_BACKUP_ACTIONS_MIN_WIDTH).toBe(896);
    expect(fitsInlineBackupActions(895)).toBe(false);
    expect(fitsInlineBackupActions(896)).toBe(true);
  });
});

describe("App Store toolbar", () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("/api/apps/categories")
      ? ["media", "ai"]
      : url.includes("/api/stores")
        ? [{ id: "talome", type: "talome", name: "Talome" }]
        : url.includes("/api/stacks")
          ? { stacks: [] }
          : [];
    return { ok: true, status: 200, json: async () => body } as Response;
  });

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderPage() {
    return render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
        <AppsPage />
      </SWRConfig>,
    );
  }

  it("names the view in a wide window (where the sidebar replaces the tabs), with the category chosen", async () => {
    renderPage();
    const pill = await screen.findByRole("button", { name: "Media" });
    const heading = screen.getByRole("heading", { level: 2, name: /All apps/ });
    // Shown exactly when the window's sidebar is
    for (const name of WINDOW_SIDEBAR_SHOWS.split(" ")) expect(heading).toHaveClass(name);
    expect(heading).not.toHaveTextContent("Media");

    fireEvent.click(pill);
    expect(heading).toHaveTextContent("All apps· Media");
  });

  it("shows category pills in sentence case, as toggles", async () => {
    renderPage();
    const all = await screen.findByRole("button", { name: "All" });
    const media = screen.getByRole("button", { name: "Media" });
    expect(screen.getByRole("button", { name: "AI" })).toBeInTheDocument();
    expect(all).toHaveAttribute("aria-pressed", "true");
    expect(media).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(media);
    expect(media).toHaveAttribute("aria-pressed", "true");
    expect(all).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps the search beside the tabs until it can't keep 10rem, then gives it a row", async () => {
    renderPage();
    const search = await screen.findByRole("textbox", { name: "Search apps" });
    const field = search.closest(".search-field");
    expect(field).toHaveClass("min-w-40", "flex-1", "ml-auto", "@xl:max-w-64");
    expect(field?.parentElement).toHaveClass("flex", "flex-wrap");
  });
});

describe("Files window sidebar", () => {
  it("offers Remove from sidebar on each favorite's row, not only in its context menu", () => {
    const onUnpin = vi.fn();
    render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <FilesSidebar
          roots={["/root"]}
          currentPath="/root/Movies"
          rootLabel={() => "Talome Files"}
          favorites={["/root/Movies", "/root/backups"]}
          onNavigate={vi.fn()}
          onUnpin={onUnpin}
        />
      </SWRConfig>,
    );
    const nav = screen.getByRole("navigation", { name: "Files sidebar" });
    fireEvent.click(within(nav).getByRole("button", { name: "Remove Backups from sidebar" }));
    expect(onUnpin).toHaveBeenCalledWith("/root/backups");
    // The row itself still navigates, and the action never selects it
    expect(within(nav).getByRole("button", { name: "Movies" })).toHaveAttribute("aria-current", "page");
  });
});

describe("Window content source rules", () => {
  it("lays the App Store, Services and Audiobooks toolbars out by their column, not the screen", () => {
    const offenders: string[] = [];
    for (const path of [
      "app/dashboard/apps/page.tsx",
      "app/dashboard/containers/page.tsx",
      "app/dashboard/audiobooks/page.tsx",
      "components/files/files-toolbar.tsx",
    ]) {
      for (const toolbar of toolbars(read(path))) {
        const hit = toolbar.match(VIEWPORT_BREAKPOINT);
        if (hit) offenders.push(`${path}: ${hit[0].trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("wraps Settings rows by the section's width (a size container), not the screen", () => {
    expect(read("app/dashboard/settings/[section]/page.tsx")).toMatch(/className="@container mx-auto w-full max-w-2xl/);
    expect(read("app/dashboard/settings/page.tsx")).toMatch(/className="@container mx-auto grid w-full max-w-2xl/);
    const offenders: string[] = [];
    for (const file of sourceFiles(join(SRC, "components/settings"))) {
      const text = readFileSync(file, "utf-8");
      // Rows that put a control beside their label, and grids that split a section
      const hit = text.match(/(?:^|[\s"'`])sm:(?:flex-nowrap|flex-row|w-\d+|w-auto|grid-cols-\d)/);
      if (hit) offenders.push(`${relative(SRC, file)}: ${hit[0].trim()}`);
    }
    expect(offenders).toEqual([]);
  });

  it("sizes the Files list's Modified and Size columns by the column it's in", () => {
    const header = read("components/files/files-list-header.tsx");
    expect(header).toMatch(/hidden w-\[25%\] @md:table-column/);
    expect(header).not.toMatch(/sm:table-(?:column|cell)/);
    expect(read("app/dashboard/files/page.tsx")).not.toMatch(/hidden sm:table-cell/);
  });

  it("shows the Services loading rows' Status and CPU cells by the column they're in", () => {
    // In a 760px window the column is ~536px while the iframe's viewport
    // passes sm:, so viewport breakpoints would squeeze Name to a few letters
    const page = read("app/dashboard/containers/page.tsx");
    expect(page.match(/hidden @xl:table-cell/g)).toHaveLength(2);
    expect(page).not.toMatch(VIEWPORT_BREAKPOINT);
  });

  it("shows the Services list's Status and CPU columns by the column they're in", () => {
    const list = read("components/dashboard/service-stack-list.tsx");
    // Columns and sub-row cells (the sm: hover reveal is a device heuristic, not layout)
    expect(list).not.toMatch(/(?:^|[\s"'`])sm:(?:table-cell|flex|block|w-\d+)/);
    expect(list.match(/hidden @xl:table-cell/g)).toHaveLength(4);
  });

  it("adds no page padding of its own where the shell pads the page (Share, Configure)", () => {
    const share = read("app/dashboard/share/page.tsx");
    expect(share).not.toMatch(/px-4 py-8/);
    expect(share).not.toMatch(/text-\[\d+px\]/);
    expect(share).not.toMatch(/rounded-2xl/);
    expect(read("app/dashboard/apps/[storeId]/[appId]/configure/page.tsx")).not.toMatch(/p-4 sm:p-6/);
  });

  it("fills the free height with the empty and error states (Backups, Automations)", () => {
    const backups = read("app/dashboard/backups/page.tsx");
    expect(backups).toMatch(/className="flex min-w-0 flex-1 flex-col gap-6"/);
    expect(backups).toMatch(/<ErrorState fill /);
    expect(backups).toMatch(/<EmptyState\s+fill/);
    // Viewport breakpoints would show the inline actions beside the sidebar
    expect(backups).not.toMatch(/hidden sm:inline-flex|sm:hidden|md:table-cell/);

    const automations = read("app/dashboard/automations/page.tsx");
    expect(automations).toMatch(/className="mx-auto flex w-full min-w-0 max-w-2xl flex-1 flex-col gap-6"/);
    expect(automations).toMatch(/<EmptyState\s+fill/);
    expect(automations).toMatch(/<ErrorState\s+fill/);
  });
});
