/**
 * App lifecycle trust on the app detail page (design P0-11): 404 empty state,
 * Open is not intercepted, uninstall asks with "Keep app data" on, failed
 * operations stay in the primary slot, rename/ports only when installed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import type { OperationRecord, LiveOperation } from "@/lib/app-operations";

const { toastFns } = vi.hoisted(() => ({
  toastFns: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), toastFns) }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ storeId: "talome-store", appId: "jellyfin" }),
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
vi.mock("streamdown", () => ({ Streamdown: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock("@/components/terminal/claude-terminal", () => ({ ClaudeTerminal: () => null }));
vi.mock("@/components/quick-look/quick-look-context", () => ({ useQuickLook: () => ({ open: vi.fn() }) }));
vi.mock("@/components/app-detail/verification-panel", () => ({
  VerificationPanel: () => null,
  verificationUrl: () => "/verification",
}));
vi.mock("@/hooks/use-user", () => ({
  useUser: () => ({ isAdmin: true, isLoading: false, hasPermission: () => true }),
}));

const ops = vi.hoisted(() => ({
  state: {
    live: null as LiveOperation | null,
    isActive: false,
    history: [] as OperationRecord[],
  },
}));
vi.mock("@/hooks/use-app-operations", () => ({
  useAppOperations: () => ({
    ...ops.state,
    error: undefined,
    isLoading: false,
    refresh: vi.fn(async () => ops.state.history),
    adopt: vi.fn(async () => null),
  }),
}));

import AppDetailPage from "@/app/dashboard/apps/[storeId]/[appId]/page";
import { ConfirmDialogHost, confirmStore } from "@/components/ui/confirm-dialog";

type Route = { status: number; body: unknown };
let routes: Record<string, Route>;
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  const key = Object.keys(routes).find((k) => {
    const [m, path] = k.includes(" ") ? k.split(" ") : ["GET", k];
    return m === method && url.includes(path);
  });
  const route = key ? routes[key] : { status: 404, body: { error: "not mocked" } };
  return {
    ok: route.status >= 200 && route.status < 300,
    status: route.status,
    statusText: "",
    json: async () => route.body,
  } as Response;
});

function app(overrides: Record<string, unknown> = {}) {
  return {
    id: "jellyfin",
    name: "Jellyfin",
    version: "10.9.0",
    tagline: "Your media",
    description: "Your media",
    icon: "📺",
    category: "media",
    author: "Jellyfin",
    source: "talome",
    storeId: "talome-store",
    composePath: "/x.yml",
    ports: [{ host: 8096, container: 8096 }],
    volumes: [],
    env: [],
    installed: null,
    ...overrides,
  };
}

const installed = {
  appId: "jellyfin",
  storeId: "talome-store",
  status: "running",
  installedAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  envConfig: {},
  containerIds: [],
  version: "10.9.0",
};

function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
      <AppDetailPage />
      <ConfirmDialogHost />
    </SWRConfig>,
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
  Object.values(toastFns).forEach((fn) => fn.mockClear());
  ops.state = { live: null, isActive: false, history: [] };
  routes = {
    "/api/containers?grouped=true": { status: 200, body: [] },
    "/api/updates/jellyfin": { status: 200, body: { hasUpdate: false, currentVersion: "10.9.0", availableVersion: "10.9.0", releaseNotes: null } },
  };
});

afterEach(() => {
  confirmStore.reset();
  vi.unstubAllGlobals();
});

describe("app detail lifecycle", () => {
  it("shows an empty state for an unknown app (regression: 'vundefined' and Install)", async () => {
    routes["/api/apps/talome-store/jellyfin"] = { status: 404, body: { error: "App not found" } };
    renderPage();
    expect(await screen.findByText("App not found")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to App Store" })).toHaveAttribute("href", "/dashboard/apps");
    expect(screen.queryByText(/vundefined/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  });

  it("opens the app directly instead of the external-link dialog (regression)", async () => {
    routes["/api/apps/talome-store/jellyfin"] = { status: 200, body: app({ installed, webPort: 8096 }) };
    renderPage();
    const open = await screen.findByRole("link", { name: "Open Jellyfin" });
    expect(open).toHaveAttribute("href", "http://localhost:8096");
    expect(open).toHaveAttribute("data-trusted-link");
    fireEvent.click(open);
    expect(screen.queryByText("Open external link?")).toBeNull();
  });

  it("still asks before following a link from store content", async () => {
    routes["/api/apps/talome-store/jellyfin"] = { status: 200, body: app({ website: "https://jellyfin.org" }) };
    renderPage();
    const link = await screen.findByRole("link", { name: "jellyfin.org" });
    fireEvent.click(link);
    expect(await screen.findByText("Open external link?")).toBeInTheDocument();
  });

  it("asks before uninstalling, with Keep app data on (regression: one-click uninstall)", async () => {
    routes["/api/apps/talome-store/jellyfin"] = { status: 200, body: app({ installed }) };
    routes["DELETE /api/apps/talome-store/jellyfin"] = { status: 200, body: { ok: true, dataKept: true } };
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Uninstall/ }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Uninstall Jellyfin?")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    const keep = within(dialog).getByRole("checkbox", { name: /Keep app data/ });
    expect(keep).toBeChecked();

    fireEvent.click(within(dialog).getByRole("button", { name: "Uninstall Jellyfin" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true));
    const [url] = fetchMock.mock.calls.find(([, init]) => init?.method === "DELETE")!;
    expect(String(url)).not.toContain("keepData");
    await waitFor(() => expect(toastFns.success).toHaveBeenCalledWith("Uninstalled Jellyfin · data kept"));
  });

  it("erases data only when Keep app data is turned off", async () => {
    routes["/api/apps/talome-store/jellyfin"] = { status: 200, body: app({ installed }) };
    routes["DELETE /api/apps/talome-store/jellyfin"] = { status: 200, body: { ok: true, dataRemoved: true } };
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Uninstall/ }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Keep app data/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Uninstall Jellyfin" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true));
    const [url] = fetchMock.mock.calls.find(([, init]) => init?.method === "DELETE")!;
    expect(String(url)).toContain("keepData=false");
  });

  it("keeps a failed install in the primary slot with Retry, Ask Talome and View log (regression)", async () => {
    routes["/api/apps/talome-store/jellyfin"] = { status: 200, body: app() };
    ops.state.history = [
      {
        id: "op-7",
        appId: "jellyfin",
        kind: "install",
        actor: "user:abc",
        status: "failed",
        step: "pulling",
        progress: 35,
        detail: null,
        error: "pull access denied",
        startedAt: "2026-09-30T11:50:00.000Z",
        updatedAt: "2026-09-30T11:51:00.000Z",
        finishedAt: "2026-09-30T11:51:00.000Z",
      },
    ];
    renderPage();
    expect(await screen.findByText("Couldn't install Jellyfin")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Ask Talome/ }).getAttribute("href")).toContain("/dashboard/assistant?prompt=");
    fireEvent.click(screen.getByRole("button", { name: "View log" }));
    expect(screen.getByText("op-7")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Couldn't install Jellyfin")).toBeNull();
    expect(screen.getByRole("button", { name: "Install" })).toBeInTheDocument();
  });

  it("offers rename and port edits only for an installed app (regression)", async () => {
    routes["/api/apps/talome-store/jellyfin"] = { status: 200, body: app() };
    const { unmount } = renderPage();
    await screen.findByRole("heading", { name: "Jellyfin" });
    expect(screen.queryByRole("button", { name: /Rename/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Change ports" })).toBeNull();
    unmount();

    routes["/api/apps/talome-store/jellyfin"] = { status: 200, body: app({ installed }) };
    renderPage();
    expect(await screen.findByRole("button", { name: "Rename Jellyfin" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change ports" })).toBeInTheDocument();
  });

  it("points to the store an app id was installed from", async () => {
    routes["/api/apps/talome-store/jellyfin"] = {
      status: 200,
      body: app({ installedFrom: { storeId: "umbrel-store", storeName: "Umbrel" } }),
    };
    renderPage();
    const open = await screen.findByRole("link", { name: "Open installed copy" });
    expect(open).toHaveAttribute("href", "/dashboard/apps/umbrel-store/jellyfin");
    expect(screen.getByText(/Installed from Umbrel/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  });
});
