/**
 * Deleting the chat you have open: it leaves the screen at once (New chat is
 * selected), nothing you send during the Undo window can go to it, the delete
 * that follows never wipes what you started meanwhile, and Undo reopens it
 * unless you have moved on to another chat.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TOAST_DURATION } from "@/lib/toast";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/dashboard/assistant",
}));
const embedded = vi.hoisted(() => ({ value: true }));
vi.mock("@/hooks/use-desktop-mode", () => ({ useIsEmbeddedFrame: () => embedded.value }));
const toastMock = vi.hoisted(() =>
  Object.assign(vi.fn<(message: string, options?: unknown) => string>(() => "toast-1"), { dismiss: vi.fn(), error: vi.fn() }),
);
vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("swr", () => ({ default: () => ({ data: undefined }) }));
vi.mock("thinking-orbs", () => ({ ThinkingOrb: () => null }));
// The composer sends one fixed message
vi.mock("@/components/ai-elements/chat-input-bar", () => ({
  ChatInputBar: ({ onSubmit }: { onSubmit: (message: { text: string; files: [] }) => void }) => (
    <button type="button" onClick={() => onSubmit({ text: "Are you still there?", files: [] })}>
      Send
    </button>
  ),
}));
vi.mock("@/components/assistant/voice-mode", () => ({ VoiceMode: () => null }));
vi.mock("@/components/assistant/assistant-model-selector", () => ({ AssistantModelSelector: () => null }));
vi.mock("@/components/chat/chat-message", () => ({
  ChatMessage: ({ message }: { message: { parts: { type: string; text?: string }[] } }) => (
    <p>{message.parts.map((part) => part.text ?? "").join("")}</p>
  ),
}));
vi.mock("@/components/terminal/claude-terminal", () => ({ ClaudeTerminal: () => null }));
vi.mock("@/components/layout/mobile-nav", () => ({ MobileNav: () => null }));
vi.mock("@/components/ui/sidebar", () => ({ SidebarTrigger: () => null }));
vi.mock("@/components/creator/blueprint-draft-bar", () => ({ BlueprintDraftBar: () => null }));
vi.mock("@/hooks/use-blueprint-build", () => ({
  useBlueprintBuild: () => ({ build: vi.fn(), building: false, error: null }),
}));

// A small stand-in for AssistantProvider that keeps state, so the page's
// reaction to its own calls (startNew, setActiveId, sends) can be observed
const fake = vi.hoisted(() => {
  let state: Record<string, unknown> = {};
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(patch: Record<string, unknown>) {
      state = { ...state, ...patch };
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
});
vi.mock("@/components/assistant/assistant-context", async () => {
  const { useSyncExternalStore } = await import("react");
  return { useAssistant: () => useSyncExternalStore(fake.subscribe, fake.get) };
});

import AssistantPage from "@/app/dashboard/assistant/page";
import { WindowSidebarSlot } from "@/components/ui/source-list";
import { TooltipProvider } from "@/components/ui/tooltip";

type Msg = { id: string; role: "user" | "assistant"; parts: { type: "text"; text: string }[] };
type Conv = { id: string; title: string; platform: string; externalId: string | null; createdAt: string; updatedAt: string };

const OPEN = "Help the user work with the LiteMol Protein Viewer. PDB entry 1";
const OTHER = "Help the user work with the LiteMol Protein Viewer. PDB entry 2";
const text = (id: string, body: string): Msg => ({ id, role: "user", parts: [{ type: "text", text: body }] });
const saved: Record<string, Msg[]> = {
  a: [text("a1", "Open the viewer")],
  b: [text("b1", "Show the second entry")],
};

function conversations(): Conv[] {
  const now = Date.now();
  return [
    { id: "a", title: OPEN, platform: "web", externalId: null, createdAt: "", updatedAt: new Date(now - 60_000).toISOString() },
    { id: "b", title: OTHER, platform: "web", externalId: null, createdAt: "", updatedAt: new Date(now - 2 * 60_000).toISOString() },
  ];
}

let sent: { to: string; text: string }[] = [];

function setAssistant(activeId: string | null) {
  sent = [];
  const stop = vi.fn();
  const setActiveId = vi.fn((id: string | null) => fake.set({ activeId: id, messages: id ? saved[id] ?? [] : [] }));
  fake.set({
    messages: activeId ? saved[activeId] : [],
    status: "ready",
    error: undefined,
    clearError: vi.fn(),
    stop,
    conversations: conversations(),
    activeId,
    setActiveId,
    // Like the provider: stops the response, clears the open chat
    startNew: vi.fn(() => {
      stop();
      fake.set({ activeId: null, messages: [] });
    }),
    // Like ensureConversation: the open chat, or a new one
    handleSubmit: vi.fn((body: string) => {
      const to = (fake.get().activeId as string | null) ?? "new";
      sent.push({ to, text: body });
      fake.set({ activeId: to, messages: [...(fake.get().messages as Msg[]), text(`s${sent.length}`, body)] });
    }),
    // Like the provider: a deleted open chat is cleared from the screen
    deleteConversation: vi.fn(async (id: string) => {
      fake.set({ conversations: (fake.get().conversations as Conv[]).filter((conv) => conv.id !== id) });
      if (fake.get().activeId === id) fake.set({ activeId: null, messages: [] });
      return true;
    }),
    isSubmitting: false,
    regenerate: vi.fn(),
    model: "m",
    setModel: vi.fn(),
    modelOptions: [],
    activeProvider: "anthropic",
    modelReady: true,
  });
}

const assistant = () => fake.get() as Record<string, ReturnType<typeof vi.fn>>;

function renderPage() {
  render(
    <Provider store={createStore()}>
      <TooltipProvider>
        <WindowSidebarSlot />
        <AssistantPage />
      </TooltipProvider>
    </Provider>,
  );
  return { sidebar: () => screen.getByRole("navigation", { name: "Chats" }) };
}

const rowFor = (sidebar: HTMLElement, title: string) =>
  within(sidebar).queryByRole("button", { name: new RegExp(`^${title.replace(/[.]/g, "\\.")}`) });

function undo() {
  const [, options] = toastMock.mock.calls.at(-1) as [string, { action: { onClick: () => void } }];
  act(() => options.action.onClick());
}

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  embedded.value = true;
  toastMock.mockClear();
  toastMock.dismiss.mockClear();
  setAssistant("a");
  window.history.replaceState(null, "", "/dashboard/assistant?c=a");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("deleting the open chat in the Assistant's window", () => {
  it("leaves the chat at once and selects New chat", () => {
    const { sidebar } = renderPage();
    expect(screen.getByText("Open the viewer")).toBeInTheDocument();

    fireEvent.click(within(sidebar()).getByRole("button", { name: `Delete "${OPEN}"` }));

    expect(screen.queryByText("Open the viewer")).not.toBeInTheDocument();
    expect(rowFor(sidebar(), OPEN)).toBeNull();
    expect(within(sidebar()).getByRole("button", { name: "New chat" })).toHaveAttribute("aria-current", "page");
    // Its response, if one was being written, stops (as New chat does)
    expect(assistant().startNew).toHaveBeenCalledTimes(1);
    expect(assistant().stop).toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledWith(
      `Deleted "${OPEN}"`,
      expect.objectContaining({ action: expect.objectContaining({ label: "Undo" }) }),
    );
    // Still undoable: nothing is deleted on the server yet
    expect(assistant().deleteConversation).not.toHaveBeenCalled();
  });

  it("sends nothing to it during the Undo window, and the delete that follows keeps the new chat", async () => {
    const { sidebar } = renderPage();
    fireEvent.click(within(sidebar()).getByRole("button", { name: `Delete "${OPEN}"` }));

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(sent).toEqual([{ to: "new", text: "Are you still there?" }]);

    await act(async () => {
      vi.advanceTimersByTime(TOAST_DURATION.undo);
    });
    expect(assistant().deleteConversation).toHaveBeenCalledWith("a", undefined);
    // The new chat stays on screen with what you sent
    expect(screen.getByText("Are you still there?")).toBeInTheDocument();
    expect(assistant().setActiveId).not.toHaveBeenCalledWith("a");
  });

  it("reopens it, as saved, when you choose Undo", async () => {
    const { sidebar } = renderPage();
    fireEvent.click(within(sidebar()).getByRole("button", { name: `Delete "${OPEN}"` }));
    undo();

    expect(toastMock.dismiss).toHaveBeenCalledWith("toast-1");
    expect(assistant().setActiveId).toHaveBeenLastCalledWith("a");
    expect(screen.getByText("Open the viewer")).toBeInTheDocument();
    expect(rowFor(sidebar(), OPEN)).toHaveAttribute("aria-current", "page");

    await act(async () => {
      vi.advanceTimersByTime(TOAST_DURATION.undo * 2);
    });
    expect(assistant().deleteConversation).not.toHaveBeenCalled();
  });

  it("only puts it back in the list once you have opened another chat", () => {
    const { sidebar } = renderPage();
    fireEvent.click(within(sidebar()).getByRole("button", { name: `Delete "${OPEN}"` }));
    fireEvent.click(rowFor(sidebar(), OTHER)!);
    expect(screen.getByText("Show the second entry")).toBeInTheDocument();

    undo();

    expect(assistant().setActiveId).toHaveBeenLastCalledWith("b");
    expect(screen.getByText("Show the second entry")).toBeInTheDocument();
    expect(rowFor(sidebar(), OPEN)).not.toHaveAttribute("aria-current");
    expect(rowFor(sidebar(), OTHER)).toHaveAttribute("aria-current", "page");
  });

  it("keeps a new chat you sent from when Undo comes after it", () => {
    const { sidebar } = renderPage();
    fireEvent.click(within(sidebar()).getByRole("button", { name: `Delete "${OPEN}"` }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    undo();

    expect(assistant().setActiveId).not.toHaveBeenCalledWith("a");
    expect(screen.getByText("Are you still there?")).toBeInTheDocument();
    expect(rowFor(sidebar(), OPEN)).toBeInTheDocument();
  });

  it("leaves another chat open when you delete a chat that isn't", () => {
    const { sidebar } = renderPage();
    fireEvent.click(within(sidebar()).getByRole("button", { name: `Delete "${OTHER}"` }));

    expect(assistant().startNew).not.toHaveBeenCalled();
    expect(screen.getByText("Open the viewer")).toBeInTheDocument();
    expect(rowFor(sidebar(), OPEN)).toHaveAttribute("aria-current", "page");
  });
});

describe("deleting the chat a Back left behind, in the classic layout", () => {
  it("sends the next message to a new chat, not the one being deleted", () => {
    embedded.value = false;
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Back to conversations" }));
    // The home view lists it, still open behind the scenes
    fireEvent.click(screen.getByRole("button", { name: `Delete "${OPEN}"` }));
    expect(assistant().startNew).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(sent).toEqual([{ to: "new", text: "Are you still there?" }]);
    expect(screen.queryByText("Open the viewer")).not.toBeInTheDocument();
  });
});
