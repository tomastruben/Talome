import { fireEvent, render, screen } from "@testing-library/react";
import type { ServiceStack } from "@talome/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LauncherWidget } from "@/components/widgets/launcher-widget";

const mocks = vi.hoisted(() => ({
  quickLookOpen: vi.fn(),
}));

const jellyfinContainer = {
  id: "jellyfin-container",
  name: "jellyfin",
  image: "jellyfin/jellyfin:10.10.7",
  status: "running" as const,
  ports: [
    { host: 1901, container: 1900, protocol: "tcp" as const },
    { host: 7359, container: 7359, protocol: "tcp" as const },
    { host: 8096, container: 8096, protocol: "tcp" as const },
    { host: 8921, container: 8920, protocol: "tcp" as const },
  ],
  created: "2026-07-19T10:00:00.000Z",
  labels: {},
};

const stacks: ServiceStack[] = [{
  id: "jellyfin",
  name: "Jellyfin",
  kind: "talome",
  icon: "🎬",
  status: "running",
  primaryContainer: jellyfinContainer,
  containers: [jellyfinContainer],
  cpuPercent: 0,
  memoryUsageMb: 0,
  runningCount: 1,
  totalCount: 1,
}];

vi.mock("@/hooks/use-service-stacks", () => ({
  useServiceStacks: () => ({
    stacks,
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

vi.mock("@/components/quick-look/quick-look-context", () => ({
  useQuickLook: () => ({
    open: mocks.quickLookOpen,
    close: vi.fn(),
    container: null,
    isOpen: false,
  }),
}));

describe("LauncherWidget", () => {
  beforeEach(() => {
    mocks.quickLookOpen.mockReset();
  });

  it("delegates service launches to the desktop window manager", () => {
    const onLaunch = vi.fn();
    render(<LauncherWidget onLaunch={onLaunch} />);

    fireEvent.click(screen.getByRole("button", { name: "Jellyfin" }));

    expect(onLaunch).toHaveBeenCalledWith(expect.objectContaining({
      id: "jellyfin",
      name: "Jellyfin",
      url: "http://localhost:8096",
      container: jellyfinContainer,
    }));
    expect(mocks.quickLookOpen).not.toHaveBeenCalled();
  });

  it("keeps Quick Look as the default in classic mode", () => {
    render(<LauncherWidget />);

    fireEvent.click(screen.getByRole("button", { name: "Jellyfin" }));

    expect(mocks.quickLookOpen).toHaveBeenCalledWith(jellyfinContainer);
  });
});
