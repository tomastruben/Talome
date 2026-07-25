import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReleaseSearchPanel } from "@/components/media/release-search-panel";
import { TooltipProvider } from "@/components/ui/tooltip";

const matchingRelease = {
  title: "Devs.S01E01.1080p.WEB.H264-GROUP",
  quality: "WEBDL-1080p",
  size: 2_400_000_000,
  seeders: 21,
  raw: { guid: "matching" },
};

const outsideProfileRelease = {
  title: "Devs.S01E01.2160p.WEB.H265-GROUP",
  quality: "WEBDL-2160p",
  size: 8_200_000_000,
  rejected: true,
  downloadAllowed: false,
  rejections: ["Quality is not wanted in profile"],
  raw: { guid: "outside-profile" },
};

function renderPanel(
  overrides: Partial<React.ComponentProps<typeof ReleaseSearchPanel>> = {},
) {
  const props: React.ComponentProps<typeof ReleaseSearchPanel> = {
    loading: false,
    error: null,
    releases: [],
    submittingTitle: null,
    onGrab: vi.fn(),
    onSearch: vi.fn(),
    ...overrides,
  };

  render(
    <TooltipProvider>
      <ReleaseSearchPanel {...props} />
    </TooltipProvider>,
  );

  return props;
}

describe("ReleaseSearchPanel", () => {
  it("shows rejected releases as downloadable alternatives when none match", () => {
    renderPanel({ releases: [outsideProfileRelease] });

    expect(screen.getByText("No releases match the current profile")).toBeInTheDocument();
    expect(screen.getByText(outsideProfileRelease.title)).toBeInTheDocument();
    expect(screen.getByText("Outside profile").parentElement).toHaveTextContent(
      "Outside profile · Quality is not wanted in profile",
    );
    expect(screen.getByRole("button", { name: "Download release" })).toBeEnabled();
  });

  it("keeps valid matches primary and reveals outside-profile releases on request", () => {
    renderPanel({ releases: [matchingRelease, outsideProfileRelease] });

    expect(screen.getByText("Matches profile · 1")).toBeInTheDocument();
    expect(screen.getByText(matchingRelease.title)).toBeInTheDocument();
    expect(screen.queryByText(outsideProfileRelease.title)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show 1 release outside profile" }));

    expect(screen.getByText("Outside profile · 1")).toBeInTheDocument();
    expect(screen.getByText(outsideProfileRelease.title)).toBeInTheDocument();
  });

  it("can reveal indexer results even when title filtering produced zero matches", () => {
    const onShowAll = vi.fn();
    renderPanel({
      releases: [],
      totalFromIndexer: 3,
      showAll: false,
      onShowAll,
    });

    fireEvent.click(screen.getByRole("button", { name: "Show 3 indexer releases" }));

    expect(onShowAll).toHaveBeenCalledOnce();
  });
});
