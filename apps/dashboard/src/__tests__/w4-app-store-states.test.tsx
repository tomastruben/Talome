/**
 * App Store states: an empty catalog is an answer (empty state), not an
 * endless skeleton; a failed catalog load is an error with Retry.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
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
vi.mock("@/components/desktop/desktop-app-toolbar", () => ({
  DesktopAppToolbar: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import AppsPage from "@/app/dashboard/apps/page";
import { AppCard } from "@/components/dashboard/app-card";
import type { CatalogApp } from "@talome/types";

let catalog: { status: number; body: unknown };
let storesRoute: { status: number; body: unknown } = { status: 200, body: [] };
const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  const route = url.includes("/api/apps?limit=2000")
    ? catalog
    : url.endsWith("/api/stores")
      ? storesRoute
      : { status: 200, body: url.includes("/api/stacks") ? { stacks: [] } : [] };
  return { ok: route.status >= 200 && route.status < 300, status: route.status, json: async () => route.body } as Response;
});

function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
      <AppsPage />
    </SWRConfig>,
  );
}

beforeEach(() => {
  storesRoute = { status: 200, body: [] };
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App Store states", () => {
  it("shows an empty state for an empty catalog (regression: skeleton forever)", async () => {
    catalog = { status: 200, body: [] };
    renderPage();
    expect(await screen.findByText("No app sources yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add an app source" })).toHaveAttribute("href", "/dashboard/settings/app-sources");
  });

  it("shows an error with Retry when the catalog fails to load", async () => {
    catalog = { status: 500, body: { error: "boom" } };
    renderPage();
    expect(await screen.findByText("Couldn't load the App Store")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("doesn't claim there are no sources when they couldn't be loaded (regression)", async () => {
    catalog = { status: 200, body: [] };
    storesRoute = { status: 500, body: { error: "boom" } };
    renderPage();
    expect(await screen.findByText("No apps listed yet")).toBeInTheDocument();
    expect(screen.queryByText("No app sources yet")).toBeNull();
    const action = screen.getByRole("link", { name: "Open app sources" });
    expect(action).toHaveAttribute("data-slot", "button");
  });
});

describe("App card delete", () => {
  const app = {
    id: "notes",
    name: "Notes",
    tagline: "Mine",
    description: "Mine",
    icon: "📝",
    category: "productivity",
    source: "user-created",
    storeId: "user-apps",
    installed: { status: "running" },
  } as unknown as CatalogApp;

  it("is a sibling of the card link, never inside it (regression: button in a link)", () => {
    const onDelete = vi.fn();
    render(<AppCard app={app} onDelete={onDelete} hasUpdate />);
    const button = screen.getByRole("button", { name: "Delete Notes" });
    expect(button.closest("a")).toBeNull();
    button.click();
    expect(onDelete).toHaveBeenCalledWith("notes");
    // Placed at the bottom of the cover, away from the Update badge (top-left).
    expect(button.className).not.toMatch(/\btop-2\b/);
  });
});
