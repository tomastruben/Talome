/**
 * Windowed apps adopt the window shell's layout: no background-colour fades
 * (they paint an opaque band over the window glass; edges fade with
 * mask-image), no hand-written container-query breakpoints (the shell names
 * them), the shell's scroller found by `[data-content-scroll]`, and toolbars
 * that move into the window's toolbar slot.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/dashboard/containers",
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
const services = vi.hoisted(() => ({
  state: { stacks: [] as unknown[], isLoading: false, error: undefined as unknown, refresh: vi.fn() },
}));
vi.mock("@/hooks/use-service-stacks", () => ({ useServiceStacks: () => services.state }));
const assistant = vi.hoisted(() => ({ handleSubmit: vi.fn(), openPaletteInChatMode: vi.fn() }));
vi.mock("@/components/assistant/assistant-context", () => ({ useAssistant: () => assistant }));
vi.mock("@/components/dashboard/service-stack-list", () => ({ ServiceStackList: () => <p>Service list</p> }));

import ContainersPage from "@/app/dashboard/containers/page";
import { WindowToolbarSlot } from "@/components/desktop/window-content";

const SRC = join(__dirname, "..");
const read = (path: string) => readFileSync(join(SRC, path), "utf8");

const ADOPTED = [
  "app/dashboard/assistant/page.tsx",
  "app/dashboard/apps/page.tsx",
  "app/dashboard/containers/page.tsx",
  "app/dashboard/audiobooks/page.tsx",
  "app/dashboard/settings/layout.tsx",
  "components/settings/settings-sidebar.tsx",
  "components/terminal/terminal-page.tsx",
  "components/terminal/terminal-sidebar.tsx",
  "components/terminal/terminal-session-toolbar.tsx",
];

describe("windowed apps adopt the window shell", () => {
  it.each(ADOPTED)("%s paints no background-colour fades and writes no container breakpoints", (path) => {
    const source = read(path);
    expect(source).not.toMatch(/\bfrom-background\b/);
    expect(source).not.toMatch(/\bto-background\b/);
    expect(source).not.toContain("@2xl:");
    expect(source).not.toContain("@2xl/window:");
    expect(source).not.toMatch(/\bbg-(white|black)\/\d+/);
    expect(source).not.toMatch(/backdrop-blur/);
  });

  it("finds the scroller by [data-content-scroll], never by a class name", () => {
    const audiobooks = read("app/dashboard/audiobooks/page.tsx");
    expect(audiobooks).not.toContain('querySelector(".overflow-y-auto")');
    expect(audiobooks).toContain('closest<HTMLElement>("[data-content-scroll]")');
  });

  it("keeps the terminal on tokens: no hex colours or inline backgrounds", () => {
    for (const path of ["components/terminal/terminal-page.tsx", "components/terminal/terminal-session-toolbar.tsx", "components/terminal/terminal-sidebar.tsx"]) {
      const source = read(path);
      expect(source, path).not.toMatch(/#[0-9a-fA-F]{6}\b/);
      expect(source, path).not.toMatch(/style=\{\{\s*background/);
      expect(source, path).not.toMatch(/uppercase|tracking-wide/);
    }
  });

  it("fades the Assistant's conversation and the App Store rails with mask-image", () => {
    expect(read("app/dashboard/assistant/page.tsx")).toMatch(/\[mask-image:linear-gradient\(to_bottom/);
    const apps = read("app/dashboard/apps/page.tsx");
    expect(apps).toMatch(/\[mask-image:linear-gradient\(to_right/);
    expect(apps).not.toContain("filter-rail");
  });
});

describe("Services in a desktop window", () => {
  let store: ReturnType<typeof createStore>;
  function renderServices() {
    store = createStore();
    return render(
      <Provider store={store}>
        {embedded.value && <WindowToolbarSlot />}
        <ContainersPage />
      </Provider>,
    );
  }

  beforeEach(() => {
    embedded.value = true;
    services.state = { stacks: [], isLoading: false, error: undefined, refresh: vi.fn() };
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("puts its controls in the window toolbar, with a heading and the search that never hide", () => {
    const { container } = renderServices();
    const toolbar = container.querySelector<HTMLElement>('[data-desktop-app-toolbar="true"]');
    expect(toolbar).not.toBeNull();
    // The heading shows only when the sidebar replaces the tabs; the search always
    const heading = within(toolbar!).getByRole("heading", { name: "All services" });
    expect(heading.className).toContain("hidden");
    expect(heading.className).toContain("@2xl/window:flex");
    expect(within(toolbar!).getByRole("textbox", { name: "Search services" })).toBeInTheDocument();
    expect(within(toolbar!).getByRole("tablist").closest('[class*="@2xl/window:hidden"]')).not.toBeNull();
  });

  it("renders the toolbar in place in classic mode", () => {
    embedded.value = false;
    const { container } = renderServices();
    expect(container.querySelector("[data-desktop-app-toolbar]")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Search services" })).toBeInTheDocument();
  });

  it("fills the view with its empty state instead of a dashed card", () => {
    const { container } = renderServices();
    const empty = container.querySelector<HTMLElement>('[data-slot="empty-state"]');
    expect(empty).not.toBeNull();
    expect(empty).toHaveTextContent("No services found");
    expect(empty!.className).not.toContain("border-dashed");
    expect(empty!.className).toContain("flex-1");
  });

  it("offers Retry and Ask Talome when services can't be loaded", () => {
    services.state = { stacks: [], isLoading: false, error: new Error("docker"), refresh: vi.fn() };
    renderServices();
    expect(screen.getByText("Couldn't load services")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(services.state.refresh).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Ask Talome" })).toBeInTheDocument();
  });
});
