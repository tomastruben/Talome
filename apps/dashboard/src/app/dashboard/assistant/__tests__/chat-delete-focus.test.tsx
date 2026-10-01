/**
 * Deleting a chat (with Undo) from either of the Assistant's lists: the
 * classic history list (phones, the classic layout, narrow windows) and the
 * window sidebar. Focus never falls to <body>: it moves to the next chat in
 * the same list, else the one before, else the composer (on a touch screen,
 * the view's landing point, so the on-screen keyboard stays down). The
 * classic list drops chats waiting on Undo before it is cut to three per
 * group, so a group keeps showing three, "Show N more" counts what is left,
 * and a group Delete emptied loses its heading.
 */
// Matcher types: this file is type-checked with the app (src/__tests__ is not)
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/dashboard/assistant",
}));
const embedded = vi.hoisted(() => ({ value: false }));
vi.mock("@/hooks/use-desktop-mode", () => ({ useIsEmbeddedFrame: () => embedded.value }));
const toastMock = vi.hoisted(() => Object.assign(vi.fn(() => "toast-1"), { dismiss: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("swr", () => ({ default: () => ({ data: undefined }) }));
vi.mock("thinking-orbs", () => ({ ThinkingOrb: () => null }));
// The composer's text field, as PromptInputTextarea names it
vi.mock("@/components/ai-elements/chat-input-bar", () => ({
  ChatInputBar: () => <textarea name="message" aria-label="Message" />,
}));
vi.mock("@/components/assistant/voice-mode", () => ({ VoiceMode: () => null }));
vi.mock("@/components/assistant/assistant-model-selector", () => ({ AssistantModelSelector: () => null }));
vi.mock("@/components/chat/chat-message", () => ({ ChatMessage: () => null }));
vi.mock("@/components/terminal/claude-terminal", () => ({ ClaudeTerminal: () => null }));
vi.mock("@/components/layout/mobile-nav", () => ({ MobileNav: () => null }));
vi.mock("@/components/ui/sidebar", () => ({ SidebarTrigger: () => null }));
vi.mock("@/components/creator/blueprint-draft-bar", () => ({ BlueprintDraftBar: () => null }));
vi.mock("@/hooks/use-blueprint-build", () => ({
  useBlueprintBuild: () => ({ build: vi.fn(), building: false, error: null }),
}));
const assistant = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock("@/components/assistant/assistant-context", () => ({ useAssistant: () => assistant.state }));

import AssistantPage from "@/app/dashboard/assistant/page";
import { WindowSidebarSlot } from "@/components/ui/source-list";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CHAT_LIST_LANDING, CHAT_LIST_ROW, chatFocusTarget } from "@/components/assistant/chat-list-focus";

// 15:00 on a fixed day, so "Today" holds every chat from earlier the same day
const NOW = new Date(2026, 9, 2, 15, 0);
const at = (date: Date) => date.toISOString();
const hoursAgo = (hours: number) => at(new Date(NOW.getTime() - hours * 3_600_000));
const chat = (id: string, title: string, updatedAt: string) => ({
  id,
  title,
  platform: "web",
  externalId: null,
  createdAt: "",
  updatedAt,
});

/** Today: five chats (three shown, "Show 2 more"); Yesterday: one; Older: one */
function conversations() {
  return [
    chat("a", "Chat A", hoursAgo(1)),
    chat("b", "Chat B", hoursAgo(2)),
    chat("c", "Chat C", hoursAgo(3)),
    chat("d", "Chat D", hoursAgo(4)),
    chat("e", "Chat E", hoursAgo(5)),
    chat("y", "Chat Y", at(new Date(2026, 9, 1, 12, 0))),
    chat("o", "Chat O", at(new Date(2026, 8, 1, 12, 0))),
  ];
}

function setAssistant(overrides: Record<string, unknown> = {}) {
  assistant.state = {
    messages: [],
    status: "ready",
    error: undefined,
    clearError: vi.fn(),
    stop: vi.fn(),
    conversations: conversations(),
    activeId: null,
    setActiveId: vi.fn(),
    deleteConversation: vi.fn(async () => true),
    handleSubmit: vi.fn(),
    regenerate: vi.fn(),
    model: "m",
    setModel: vi.fn(),
    modelOptions: [],
    activeProvider: "anthropic",
    modelReady: true,
    startNew: vi.fn(),
    isSubmitting: false,
    ...overrides,
  };
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <Provider store={createStore()}>
      <TooltipProvider>
        <WindowSidebarSlot />
        {children}
      </TooltipProvider>
    </Provider>
  );
}

function renderPage() {
  render(
    <Shell>
      <AssistantPage />
    </Shell>,
  );
  return { sidebar: () => screen.getByRole("navigation", { name: "Chats" }) };
}

/** The classic list's button that opens a chat */
const openButton = (title: string) => screen.getByRole("button", { name: title });
const queryOpenButton = (title: string) => screen.queryByRole("button", { name: title });

/**
 * Deletes from the row's own button the way a keyboard does it: the button
 * has focus (a click in jsdom doesn't move focus, as in Safari).
 */
function deleteWithKeyboard(button: HTMLElement) {
  act(() => button.focus());
  expect(button).toHaveFocus();
  fireEvent.click(button);
}

function stubPointer(coarse: boolean) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: coarse && query === "(pointer: coarse)",
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  })) as unknown as typeof window.matchMedia;
}

const originalMatchMedia = window.matchMedia;

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  embedded.value = false;
  toastMock.mockClear();
  setAssistant();
  window.history.replaceState(null, "", "/dashboard/assistant");
});

afterEach(() => {
  vi.useRealTimers();
  window.matchMedia = originalMatchMedia;
});

describe("deleting from the classic history list", () => {
  it("moves focus to the next chat's open button", () => {
    renderPage();
    deleteWithKeyboard(screen.getByRole("button", { name: 'Delete "Chat B"' }));
    expect(queryOpenButton("Chat B")).not.toBeInTheDocument();
    expect(openButton("Chat C")).toHaveFocus();
    // Still undoable: nothing is deleted on the server yet
    expect(assistant.state.deleteConversation).not.toHaveBeenCalled();
  });

  it("keeps three chats in a group and counts only what is left in Show N more", () => {
    renderPage();
    expect(screen.getByRole("button", { name: "Show 2 more" })).toBeInTheDocument();
    expect(queryOpenButton("Chat D")).not.toBeInTheDocument();

    deleteWithKeyboard(screen.getByRole("button", { name: 'Delete "Chat C"' }));

    // Chat D takes the place Chat C left, and takes focus as the next chat
    expect(openButton("Chat D")).toHaveFocus();
    expect(screen.getByRole("button", { name: "Show 1 more" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show 2 more" })).not.toBeInTheDocument();
    expect(queryOpenButton("Chat E")).not.toBeInTheDocument();
  });

  it("gives Show N more a 44px target on a touch screen", () => {
    renderPage();
    expect(screen.getByRole("button", { name: "Show 2 more" })).toHaveClass("pointer-coarse:min-h-11");
  });

  it("drops a group's heading once Delete has emptied it, and moves focus to the chat before", () => {
    renderPage();
    expect(screen.getByText("Older")).toBeInTheDocument();
    deleteWithKeyboard(screen.getByRole("button", { name: 'Delete "Chat O"' }));
    expect(screen.queryByText("Older")).not.toBeInTheDocument();
    // The last chat in the list: the one before it takes focus
    expect(openButton("Chat Y")).toHaveFocus();
  });

  it("moves focus to the composer once the list is empty", () => {
    setAssistant({ conversations: [chat("a", "Chat A", hoursAgo(1))] });
    renderPage();
    deleteWithKeyboard(screen.getByRole("button", { name: 'Delete "Chat A"' }));
    expect(screen.queryByText("Today")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveFocus();
  });

  it("moves focus to the heading instead on a touch screen, so the on-screen keyboard stays down", () => {
    stubPointer(true);
    setAssistant({ conversations: [chat("a", "Chat A", hoursAgo(1))] });
    renderPage();
    deleteWithKeyboard(screen.getByRole("button", { name: 'Delete "Chat A"' }));
    expect(screen.getByRole("heading", { name: "How can I help?" })).toHaveFocus();
    expect(screen.getByRole("textbox", { name: "Message" })).not.toHaveFocus();
  });

  it("still moves focus to the next chat on a touch screen", () => {
    stubPointer(true);
    renderPage();
    deleteWithKeyboard(screen.getByRole("button", { name: 'Delete "Chat A"' }));
    expect(openButton("Chat B")).toHaveFocus();
  });

  it("leaves focus where it is when the deleted row didn't have it", () => {
    renderPage();
    const composer = screen.getByRole("textbox", { name: "Message" });
    act(() => composer.focus());
    // A pointer click that doesn't focus the button (Safari)
    fireEvent.click(screen.getByRole("button", { name: 'Delete "Chat B"' }));
    expect(queryOpenButton("Chat B")).not.toBeInTheDocument();
    expect(composer).toHaveFocus();
  });

  it("brings the chat back in its place with Undo", () => {
    renderPage();
    deleteWithKeyboard(screen.getByRole("button", { name: 'Delete "Chat O"' }));
    const [, options] = toastMock.mock.calls.at(-1) as unknown as [string, { action: { onClick: () => void } }];
    act(() => options.action.onClick());
    expect(screen.getByText("Older")).toBeInTheDocument();
    expect(openButton("Chat O")).toBeInTheDocument();
  });
});

describe("deleting from the window sidebar", () => {
  const sidebarRow = (sidebar: HTMLElement, title: string) =>
    within(sidebar).getByRole("button", { name: new RegExp(`^${title}(,|$)`) });

  beforeEach(() => {
    embedded.value = true;
  });

  it("moves focus to the next chat in the sidebar, not in the hidden classic list", () => {
    const { sidebar } = renderPage();
    deleteWithKeyboard(within(sidebar()).getByRole("button", { name: 'Delete "Chat B"' }));
    expect(within(sidebar()).queryByRole("button", { name: /^Chat B/ })).not.toBeInTheDocument();
    expect(sidebarRow(sidebar(), "Chat C")).toHaveFocus();
  });

  it("moves focus to the next chat after a delete from the row's context menu", async () => {
    const { sidebar } = renderPage();
    // Focus was elsewhere when the menu opened (a right-click in Safari
    // doesn't focus the row): the menu took it, and the row it opened from
    // is gone, so the next chat takes it, not the place the menu came from
    act(() => screen.getByRole("textbox", { name: "Message" }).focus());
    fireEvent.contextMenu(sidebarRow(sidebar(), "Chat D"));
    const item = await screen.findByRole("menuitem", { name: "Delete" });
    act(() => item.focus());
    fireEvent.click(item);

    expect(within(sidebar()).queryByRole("button", { name: /^Chat D/ })).not.toBeInTheDocument();
    expect(sidebarRow(sidebar(), "Chat E")).toHaveFocus();
    // The menu's own focus return comes a tick later: it must not take focus back
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(sidebarRow(sidebar(), "Chat E")).toHaveFocus();
  });

  it("moves focus to the next chat when the deleted chat is the open one", () => {
    const startNew = vi.fn();
    setAssistant({ activeId: "b", startNew });
    const { sidebar } = renderPage();
    deleteWithKeyboard(within(sidebar()).getByRole("button", { name: 'Delete "Chat B"' }));
    // It leaves the open chat at once, as New chat does
    expect(startNew).toHaveBeenCalledTimes(1);
    expect(within(sidebar()).queryByRole("button", { name: /^Chat B/ })).not.toBeInTheDocument();
    expect(sidebarRow(sidebar(), "Chat C")).toHaveFocus();
  });

  it("hands focus back to the row when its context menu closes without Delete", async () => {
    const { sidebar } = renderPage();
    const row = sidebarRow(sidebar(), "Chat D");
    act(() => row.focus());
    fireEvent.contextMenu(row);
    const item = await screen.findByRole("menuitem", { name: "Delete" });
    fireEvent.keyDown(item, { key: "Escape" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.queryByRole("menuitem", { name: "Delete" })).not.toBeInTheDocument();
    expect(sidebarRow(sidebar(), "Chat D")).toHaveFocus();
  });

  it("moves focus to the composer once the sidebar has no chats", () => {
    setAssistant({ conversations: [chat("a", "Chat A", hoursAgo(1))] });
    const { sidebar } = renderPage();
    deleteWithKeyboard(within(sidebar()).getByRole("button", { name: 'Delete "Chat A"' }));
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveFocus();
  });

  it("moves focus to New chat instead on a touch screen", () => {
    stubPointer(true);
    setAssistant({ conversations: [chat("a", "Chat A", hoursAgo(1))] });
    const { sidebar } = renderPage();
    deleteWithKeyboard(within(sidebar()).getByRole("button", { name: 'Delete "Chat A"' }));
    expect(within(sidebar()).getByRole("button", { name: "New chat" })).toHaveFocus();
  });
});

describe("chatFocusTarget", () => {
  it("reads the rows and landing points the page marks", () => {
    // The attribute names the page and ChatSourceItem write
    expect(CHAT_LIST_ROW).toEqual({ history: "data-chat-history-row", sidebar: "data-chat-row" });
    expect(CHAT_LIST_LANDING).toEqual({ history: "data-assistant-home", sidebar: "data-new-chat" });
  });

  it("skips chats that aren't on screen (a collapsed group) for the nearest one that is", () => {
    document.body.innerHTML = `
      <div data-chat-history-row data-chat-id="a"><button>A</button></div>
      <div data-chat-history-row data-chat-id="d"><button>D</button></div>
      <textarea name="message"></textarea>`;
    const target = chatFocusTarget({ id: "a", list: "history", order: ["a", "b", "c", "d"] });
    expect(target).toHaveTextContent("D");
    // With nothing after it, the nearest chat before it
    expect(chatFocusTarget({ id: "d", list: "history", order: ["a", "b", "c", "d"] })).toHaveTextContent("A");
    // Rows of the other list don't count
    expect(chatFocusTarget({ id: "a", list: "sidebar", order: ["a", "d"] })?.tagName).toBe("TEXTAREA");
    document.body.innerHTML = "";
  });
});
