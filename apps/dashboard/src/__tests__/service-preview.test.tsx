import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Provider, createStore } from "jotai";
import { pageTitleAtom } from "@/atoms/page-title";
import { QuickLookContent } from "@/components/quick-look/quick-look";
import type { Container } from "@talome/types";
import { containerDisplayName, findContainerReference } from "@/lib/container-label";
import { QuickLookProvider, useQuickLook } from "@/components/quick-look/quick-look-context";

const navigation = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-desktop-mode", () => ({ useIsEmbeddedFrame: () => true }));
vi.mock("@/lib/desktop-navigation", () => ({ requestDesktopNavigation: navigation }));
const container: Container = { id: "559a5c6ca5b2abcdef", name: "559a5c6ca5b2", image: "public.ecr.aws/supabase/logflare:1.45.6", labels: {}, status: "stopped", created: "", ports: [] };

function PreviewTrigger() {
  const preview = useQuickLook();
  return <><button onClick={() => preview.open(container, 4000)}>Open service</button><span>{preview.isOpen ? "Nested preview" : "No nested preview"}</span></>;
}

beforeEach(() => navigation.mockReset());
describe("service previews", () => {
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
