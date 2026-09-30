import { useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopLaunchpad } from "@/components/desktop/desktop-launchpad";

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
vi.mock("@/hooks/use-service-stacks", () => ({ useServiceStacks: () => ({ stacks: mocks.stacks, isLoading: mocks.loading, error: mocks.error, refresh: mocks.refresh }) }));

function Harness() {
  const [open, setOpen] = useState(false);
  return <>
    <button onClick={() => setOpen(true)}>Open apps</button>
    <button>Outside action</button>
    <DesktopLaunchpad open={open} zIndex={1400} onOpenChange={setOpen} onLaunch={(app) => { mocks.launch(app); setOpen(false); }} onLaunchService={(app) => { mocks.launchService(app); setOpen(false); }} />
  </>;
}
async function open() {
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole("button", { name: "Open apps" }));
  return user;
}

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
    const search = screen.getByRole("searchbox", { name: "Search apps" });
    expect(search).toHaveFocus();
    const dialog = screen.getByRole("dialog", { name: "Launchpad" });
    for (let index = 0; index < 18; index++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Open apps" })).toHaveFocus();
  });

  it("filters permitted apps and launches the first search result on Enter", async () => {
    const user = await open();
    await user.type(screen.getByRole("searchbox"), "  fIlEs ");
    expect(screen.getByRole("button", { name: "Files", exact: true })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Media", exact: true })).not.toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(mocks.launch).toHaveBeenCalledWith(expect.objectContaining({ url: "/dashboard/files" }));
  });

  it("offers an actionable empty search and resets the query when reopened", async () => {
    const user = await open();
    await user.type(screen.getByRole("searchbox"), "nothing-matches");
    expect(screen.getByText("No apps found")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByRole("searchbox")).toHaveValue("");
    expect(screen.getByRole("searchbox")).toHaveFocus();
    await user.type(screen.getByRole("searchbox"), "files");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Open apps" }));
    expect(screen.getByRole("searchbox")).toHaveValue("");
  });

  it("keeps built-in apps available while installed apps load", async () => {
    mocks.loading = true;
    await open();
    expect(screen.getByRole("status", { name: "Loading installed apps" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Files", exact: true })).toBeVisible();
    expect(screen.queryByText("No apps running yet")).not.toBeInTheDocument();
  });

  it("distinguishes an installed-app failure and retries without unhandled rejection", async () => {
    mocks.error = "Failed to fetch service stacks";
    mocks.refresh.mockRejectedValueOnce(new Error("Still unavailable"));
    const user = await open();
    expect(screen.getByRole("alert")).toHaveTextContent("Installed apps couldn’t be loaded");
    expect(screen.queryByText("No apps running yet")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(mocks.refresh).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled());
  });

  it("searches installed apps by name and preserves the service launch identity", async () => {
    const primary = { id: "weather-container", name: "weather-ui", status: "running", ports: [] };
    mocks.stacks = [{ id: "weather", name: "Mountain Weather Station", storeId: "user-apps", appId: "weather", nativeSurface: { schemaVersion: 1 }, primaryContainer: primary, containers: [primary] }];
    const user = await open();
    await user.type(screen.getByRole("searchbox"), "weather");
    const installed = screen.getByRole("region", { name: "Installed applications" });
    expect(within(installed).getByRole("button", { name: "Mountain Weather Station" })).toBeVisible();
    await user.keyboard("{Enter}");
    expect(mocks.launchService).toHaveBeenCalledWith(expect.objectContaining({ id: "weather-ui", name: "Mountain Weather Station" }));
  });

  it("does not launch a result while confirming composed text", async () => {
    await open();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Files" } });
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Enter", isComposing: true });
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("hides and restores apps without launching or stopping them, and remembers visibility", async () => {
    const user = await open();
    await user.click(screen.getByRole("button", { name: "Customize" }));
    await user.click(screen.getByRole("button", { name: "Hide Media", exact: true }));
    expect(mocks.launch).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Done", exact: true }));
    expect(screen.queryByRole("button", { name: "Media", exact: true })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Open apps" }));
    expect(screen.queryByRole("button", { name: "Media", exact: true })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Customize" }));
    expect(screen.getByRole("button", { name: "Show Media", exact: true })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Reset", exact: true }));
    await user.click(screen.getByRole("button", { name: "Done", exact: true }));
    expect(screen.getByRole("button", { name: "Media", exact: true })).toBeVisible();
  });

  it("omits APIs and disambiguates searchable instances of the same browser app", async () => {
    const make = (id: string, ui: boolean) => ({ id, name: id, image: "mailpit:latest", status: "running", labels: { "com.docker.compose.project": id }, ports: [{host: 8025,container:8025,protocol:"tcp"}], webUi: ui ? {port:8025,protocol:"http",path:"/",title:"Mailpit",source:"detected"} : null });
    const a = make("finance-os", true), b = make("learning", true), api = make("api", false);
    mocks.stacks = [a,b,api].map(c => ({id:c.id,name:c.name,primaryContainer:c,containers:[c]}));
    const user = await open();
    expect(screen.getByRole("button", {name:"Mailpit — Finance OS"})).toBeVisible();
    expect(screen.getByRole("button", {name:"Mailpit — Learning"})).toBeVisible();
    expect(screen.queryByRole("button", {name:"api",exact:true})).not.toBeInTheDocument();
    await user.type(screen.getByRole("searchbox"), "finance");
    await user.keyboard("{Enter}");
    expect(mocks.launchService).toHaveBeenCalledWith(expect.objectContaining({id:"finance-os"}));
  });
});
