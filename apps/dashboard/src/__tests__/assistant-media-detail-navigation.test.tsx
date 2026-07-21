import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnifiedMediaSheet } from "@/components/media/media-detail-sheet";
import { TooltipProvider } from "@/components/ui/tooltip";
import { requestDesktopNavigation } from "@/lib/desktop-navigation";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));

vi.mock("@/hooks/use-desktop-mode", () => ({
  useIsEmbeddedFrame: () => true,
}));

vi.mock("@/hooks/use-downloads", () => ({
  useDownloads: () => ({ queue: [] }),
}));

vi.mock("@/lib/desktop-navigation", () => ({
  requestDesktopNavigation: vi.fn(),
}));

const requestDesktopNavigationMock = vi.mocked(requestDesktopNavigation);

describe("Assistant media detail navigation", () => {
  beforeEach(() => {
    push.mockReset();
    requestDesktopNavigationMock.mockReset();
  });

  it("opens View details through the desktop window manager", () => {
    const onClose = vi.fn();
    requestDesktopNavigationMock.mockReturnValue(true);

    render(
      <TooltipProvider>
        <UnifiedMediaSheet
          item={{
            kind: "library",
            data: {
              id: 448,
              title: "Send Help",
              type: "movie",
              hasFile: true,
            },
          }}
          onClose={onClose}
        />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "View details" }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(requestDesktopNavigationMock).toHaveBeenCalledWith(
      "/dashboard/media/movie/448",
    );
    expect(push).not.toHaveBeenCalled();
  });

  it("keeps the sheet actions above the desktop Dock", () => {
    render(
      <TooltipProvider>
        <UnifiedMediaSheet
          item={{
            kind: "library",
            data: {
              id: 448,
              title: "Send Help",
              type: "movie",
            },
          }}
          onClose={vi.fn()}
        />
      </TooltipProvider>,
    );

    expect(screen.getByRole("dialog")).toHaveClass("pb-20");
  });

  it("keeps classic-mode navigation as a fallback", () => {
    requestDesktopNavigationMock.mockReturnValue(false);

    render(
      <TooltipProvider>
        <UnifiedMediaSheet
          item={{
            kind: "library",
            data: {
              id: 81189,
              title: "Breaking Bad",
              type: "tv",
            },
          }}
          onClose={vi.fn()}
        />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "View details" }));

    expect(push).toHaveBeenCalledWith("/dashboard/media/tv/81189");
  });
});
