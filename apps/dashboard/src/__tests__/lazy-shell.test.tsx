import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactNode } from "react";
import { act, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { SWRConfig } from "swr";

// ── Mocks ────────────────────────────────────────────────────────────────────

const assistantMock = vi.hoisted(() => ({
  opener: null as ((prefill?: string) => void) | null,
}));

vi.mock("@/components/assistant/assistant-context", () => ({
  useAssistant: () => ({
    registerOpenPalette: (fn: (prefill?: string) => void) => {
      assistantMock.opener = fn;
    },
  }),
}));

// Stand-in for the heavy palette chunk: renders what it was asked to open with.
vi.mock("@/components/assistant/command-palette", () => ({
  CommandPalette: ({ initialRequest }: { initialRequest?: { mode: string; prefill?: string } | null }) => (
    <div data-testid="palette">{initialRequest ? `${initialRequest.mode}:${initialRequest.prefill ?? ""}` : "closed"}</div>
  ),
}));

vi.mock("@/components/media/media-detail-sheet", () => ({
  UnifiedMediaSheet: ({ item }: { item: { kind: string; data?: { title?: string }; pendingTitle?: string } | null }) => (
    <div data-testid="sheet">{item ? `${item.kind}:${item.data?.title ?? item.pendingTitle ?? ""}` : "none"}</div>
  ),
}));

import { CommandPaletteLauncher } from "@/components/assistant/command-palette-launcher";
import {
  MediaDetailProvider,
  useMediaDetail,
  useMediaLibraryDemand,
} from "@/components/media/media-detail-context";

// ── Command palette launcher ────────────────────────────────────────────────

describe("CommandPaletteLauncher", () => {
  beforeEach(() => {
    assistantMock.opener = null;
  });

  it("renders nothing until first use, then mounts the palette open in search mode on Ctrl+K", async () => {
    render(<CommandPaletteLauncher />);
    expect(screen.queryByTestId("palette")).toBeNull();

    act(() => {
      fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    });
    expect(await screen.findByTestId("palette")).toHaveTextContent("search:");
  });

  it("opens in chat mode with a prefill when requested before the palette loaded", async () => {
    render(<CommandPaletteLauncher />);
    expect(assistantMock.opener).toBeTypeOf("function");
    act(() => {
      assistantMock.opener?.("Why is Plex down?");
    });
    expect(await screen.findByTestId("palette")).toHaveTextContent("chat:Why is Plex down?");
  });

  it("ignores '/' while typing in an input", async () => {
    render(
      <>
        <input data-testid="field" />
        <CommandPaletteLauncher />
      </>,
    );
    act(() => {
      fireEvent.keyDown(screen.getByTestId("field"), { key: "/" });
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("palette")).toBeNull();

    act(() => {
      fireEvent.keyDown(document.body, { key: "/" });
    });
    expect(await screen.findByTestId("palette")).toHaveTextContent("chat:");
  });
});

// ── Media library demand ────────────────────────────────────────────────────

const LIBRARY = {
  movies: [{ id: 1, title: "Interstellar", year: 2014, type: "movie" }],
  tv: [],
};

function swrWrapper({ children }: { children: ReactNode }) {
  return <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>;
}

describe("MediaDetailProvider library fetching", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/api/media/library")) {
        return new Response(JSON.stringify(LIBRARY), { status: 200 });
      }
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const libraryRequests = () => fetchMock.mock.calls.filter((c) => String(c[0]).includes("/api/media/library"));

  it("does not fetch the library on mount", async () => {
    render(
      <MediaDetailProvider>
        <div>page</div>
      </MediaDetailProvider>,
      { wrapper: swrWrapper },
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(libraryRequests()).toHaveLength(0);
  });

  it("fetches the library while a consumer declares demand and findItem sees it", async () => {
    function Consumer() {
      useMediaLibraryDemand(true);
      const { findItem } = useMediaDetail();
      return <div data-testid="match">{findItem("Interstellar (2014)")?.title ?? "none"}</div>;
    }
    render(
      <MediaDetailProvider>
        <Consumer />
      </MediaDetailProvider>,
      { wrapper: swrWrapper },
    );
    await waitFor(() => expect(screen.getByTestId("match")).toHaveTextContent("Interstellar"));
    expect(libraryRequests()).toHaveLength(1);
  });

  it("openDetail loads the library on demand and opens the library sheet", async () => {
    function Opener() {
      const { openDetail } = useMediaDetail();
      return <button type="button" onClick={() => openDetail("Interstellar")}>open</button>;
    }
    render(
      <MediaDetailProvider>
        <Opener />
      </MediaDetailProvider>,
      { wrapper: swrWrapper },
    );
    expect(libraryRequests()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    await waitFor(() => expect(screen.getByTestId("sheet")).toHaveTextContent("library:Interstellar"));
    expect(libraryRequests()).toHaveLength(1);
  });
});
