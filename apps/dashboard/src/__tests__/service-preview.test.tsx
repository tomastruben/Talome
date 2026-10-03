import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Provider, createStore } from "jotai";
import { pageTitleAtom } from "@/atoms/page-title";
import { QuickLookContent } from "@/components/quick-look/quick-look";
import type { Container } from "@talome/types";
import { containerDisplayName, findContainerReference } from "@/lib/container-label";
import { QuickLookProvider, useQuickLook } from "@/components/quick-look/quick-look-context";

const api = vi.hoisted(() => ({ post: vi.fn(), refresh: vi.fn(), containers: [] as Container[] }));
vi.mock("@/hooks/use-containers", () => ({ useContainers: () => ({ containers: api.containers, refresh: api.refresh }) }));
vi.mock("@/hooks/use-talome-api", () => ({ talomePost: api.post }));
const navigation = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-desktop-mode", () => ({ useIsEmbeddedFrame: () => true }));
vi.mock("@/lib/desktop-navigation", () => ({ requestDesktopNavigation: navigation }));
const container: Container = { id: "559a5c6ca5b2abcdef", name: "559a5c6ca5b2", image: "public.ecr.aws/supabase/logflare:1.45.6", labels: {}, status: "stopped", created: "", ports: [] };

function PreviewTrigger() {
  const preview = useQuickLook();
  return <><button onClick={() => preview.open(container, 4000)}>Open service</button><span>{preview.isOpen ? "Nested preview" : "No nested preview"}</span></>;
}

beforeEach(() => {
  navigation.mockReset();
  api.post.mockReset();
  api.refresh.mockReset();
  api.containers = [];
});
describe("service previews", () => {
  it("starts once, then displays the refreshed running service", async () => {
    let finish!: () => void;
    api.post.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    api.refresh.mockImplementation(() => { api.containers = [{ ...container, status: "running", ports: [{ host: 4000, container: 4000, protocol: "tcp" }] }]; });
    const { container: view } = render(<QuickLookContent standalone container={container} onClose={vi.fn()} />);
    const start = screen.getByRole("button", { name: "Start logflare" });
    fireEvent.click(start);
    fireEvent.click(start);
    expect(start).toBeDisabled();
    expect(screen.getByText("Starting…")).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledExactlyOnceWith(`/api/containers/${container.id}/start`);
    await act(async () => finish());
    await waitFor(() => expect(view.querySelector('iframe[title="logflare"]')).not.toBeNull());
    expect(screen.queryByRole("button", { name: "Start logflare" })).toBeNull();
    expect(api.refresh).toHaveBeenCalledOnce();
  });
  it("shows start errors and allows retry", async () => {
    api.post.mockRejectedValueOnce(new Error("Docker could not start logflare"));
    render(<QuickLookContent container={container} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Start logflare" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Docker could not start logflare");
    expect(screen.getByRole("button", { name: "Start logflare" })).toBeEnabled();
  });
  it("does not offer start for paused services", () => {
    render(<QuickLookContent container={{ ...container, status: "paused" }} onClose={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Start logflare" })).toBeNull();
  });
  it("keeps a stopped detached preview to one shell header", () => {
    const store = createStore();
    const { container: view } = render(<Provider store={store}><QuickLookContent standalone container={container} onClose={vi.fn()} /></Provider>);
    expect(store.get(pageTitleAtom)).toBe("logflare");
    expect(screen.getByText("stopped")).toBeInTheDocument();
    expect(view.querySelector("[data-app-toolbar]")).toBeNull();
  });
  it("detaches even stopped containers without opening a nested dialog", () => {
    navigation.mockReturnValue(true);
    render(<QuickLookProvider><PreviewTrigger /></QuickLookProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Open service" }));
    expect(navigation).toHaveBeenCalledWith(`/dashboard/containers/preview?id=${container.id}&name=logflare&port=4000`);
    expect(screen.getByText("No nested preview")).toBeInTheDocument();
  });
  it("keeps the local preview in classic mode", () => {
    navigation.mockReturnValue(false);
    render(<QuickLookProvider><PreviewTrigger /></QuickLookProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Open service" }));
    expect(screen.getByText("Nested preview")).toBeInTheDocument();
  });
  it("uses readable names when Docker supplies only a hash", () => {
    expect(containerDisplayName(container)).toBe("logflare");
    expect(containerDisplayName({ ...container, labels: { "com.docker.compose.service": "analytics" } })).toBe("analytics");
    expect(containerDisplayName({ ...container, name: "My Plex" })).toBe("My Plex");
  });
  it("resolves unique short IDs but rejects ambiguous IDs", () => {
    expect(findContainerReference([container], "559a5c6ca5b2")).toBe(container);
    const other = { ...container, id: "559a5c6ca5b2ffff", name: "other" };
    const unnamed = { ...container, name: "analytics" };
    expect(findContainerReference([unnamed, other], "559a5c6ca5b2")).toBeUndefined();
    expect(findContainerReference([container], "559")).toBeUndefined();
  });
});
