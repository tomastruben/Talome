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
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@/hooks/use-desktop-mode", () => ({ useIsEmbeddedFrame: () => false }));
vi.mock("@/components/desktop/desktop-app-toolbar", () => ({
  DesktopAppToolbar: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import AppsPage from "@/app/dashboard/apps/page";

let catalog: { status: number; body: unknown };
const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  const route = url.includes("/api/apps?limit=2000") ? catalog : { status: 200, body: url.includes("/api/stacks") ? { stacks: [] } : [] };
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
});
