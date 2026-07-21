import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolOutput } from "@/components/ai-elements/tool";
import { requestDesktopNavigation } from "@/lib/desktop-navigation";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("@/lib/desktop-navigation", () => ({
  requestDesktopNavigation: vi.fn(),
}));

const requestDesktopNavigationMock = vi.mocked(requestDesktopNavigation);

describe("Assistant entity navigation", () => {
  beforeEach(() => {
    push.mockReset();
    requestDesktopNavigationMock.mockReset();
    requestDesktopNavigationMock.mockReturnValue(true);
  });

  it("opens media search results through the desktop window manager", () => {
    render(
      <ToolOutput
        toolName="search_media"
        errorText={undefined}
        output={{
          tv: [],
          movies: [{ tmdbId: 448, title: "Send Help", year: 2026 }],
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open Send Help in Media" }));

    expect(requestDesktopNavigationMock).toHaveBeenCalledWith(
      "/dashboard/media?tab=movies&q=Send+Help",
    );
    expect(push).not.toHaveBeenCalled();
  });

  it("opens container results in a separate Services window", () => {
    render(
      <ToolOutput
        toolName="list_containers"
        errorText={undefined}
        output={[{ id: "radarr", name: "Radarr", status: "running" }]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open Radarr in Services" }));

    expect(requestDesktopNavigationMock).toHaveBeenCalledWith(
      "/dashboard/containers?q=Radarr",
    );
    expect(push).not.toHaveBeenCalled();
  });

  it("opens audiobook results in a separate Audiobooks window", () => {
    render(
      <ToolOutput
        toolName="audiobookshelf_search"
        errorText={undefined}
        output={{
          items: [{ id: "book-49", title: "The Creative Act", author: "Rick Rubin" }],
          total: 1,
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /The Creative Act/ }));

    expect(requestDesktopNavigationMock).toHaveBeenCalledWith(
      "/dashboard/audiobooks/book-49",
    );
    expect(push).not.toHaveBeenCalled();
  });

  it("opens Assistant terminal actions in a separate Terminal window", () => {
    render(
      <ToolOutput
        toolName="launch_claude_code"
        errorText={undefined}
        output={{
          command: "cd /Users/tomas/.talome/server && claude",
          projectRoot: "/Users/tomas/.talome/server",
          task: "Inspect Talome",
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open in Terminal" }));

    expect(requestDesktopNavigationMock).toHaveBeenCalledWith(
      "/dashboard/terminal",
    );
    expect(push).not.toHaveBeenCalled();
  });

  it("falls back to classic in-window navigation outside desktop mode", () => {
    requestDesktopNavigationMock.mockReturnValue(false);
    render(
      <ToolOutput
        toolName="get_library"
        errorText={undefined}
        output={{
          tv: [{ tvdbId: 81189, title: "Breaking Bad", year: 2008 }],
          movies: [],
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open Breaking Bad in Media" }));

    expect(push).toHaveBeenCalledWith(
      "/dashboard/media?tab=tv&q=Breaking+Bad",
    );
  });
});
