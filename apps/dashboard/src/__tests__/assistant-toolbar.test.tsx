/**
 * The Assistant's chrome: one way home in each layout (the sidebar's "New
 * chat" in a wide window, a toolbar "New chat" in a narrow one and in the
 * classic header), a window title bar with no verbs and a Back only where it
 * goes somewhere New chat doesn't; a named, 44px keyboard toggle in the
 * composer that really holds back the on-screen keyboard; floating
 * conversation buttons that stay opaque on hover; and tool card headers you
 * can tap.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/dashboard/assistant",
}));
const embedded = vi.hoisted(() => ({ value: true }));
vi.mock("@/hooks/use-desktop-mode", () => ({ useIsEmbeddedFrame: () => embedded.value }));
const keyboard = vi.hoisted(() => ({
  value: { mode: "physical" as "virtual" | "physical", inputMode: "none" as "none" | "text", showToggle: false, toggle: () => {} },
}));
vi.mock("@/hooks/use-keyboard-mode", () => ({ useKeyboardMode: () => keyboard.value }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { dismiss: vi.fn(), error: vi.fn() }) }));
vi.mock("swr", () => ({ default: () => ({ data: undefined }) }));
vi.mock("thinking-orbs", () => ({ ThinkingOrb: () => null }));
// The composer renders the page's extra tools and records what it was given
const composer = vi.hoisted(() => ({ props: {} as { inputMode?: string } }));
vi.mock("@/components/ai-elements/chat-input-bar", () => ({
  ChatInputBar: (props: { inputMode?: string; extraTools?: ReactNode }) => {
    composer.props = props;
    return (
      <div data-testid="composer">
        <textarea name="message" aria-label="Message" />
        {props.extraTools}
      </div>
    );
  },
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
// A small stand-in for AssistantProvider that keeps state, so New chat
// really leaves the chat view
const assistant = vi.hoisted(() => {
  let state: Record<string, unknown> = {};
  const listeners = new Set<() => void>();
  return {
    get state() {
      return state;
    },
    set(next: Record<string, unknown>) {
      state = next;
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
  return { useAssistant: () => useSyncExternalStore(assistant.subscribe, () => assistant.state) };
});

import AssistantPage from "@/app/dashboard/assistant/page";
import { desktopAppActionsAtom } from "@/atoms/desktop-app-actions";
import { pageBackAtom } from "@/atoms/page-back";
import { pageTitleAtom } from "@/atoms/page-title";
import { ConversationDownload } from "@/components/ai-elements/conversation";
import { Tool, ToolHeader } from "@/components/ai-elements/tool";
import { WindowToolbarSlot } from "@/components/desktop/window-content";
import { WINDOW_SIDEBAR_REPLACES, WindowSidebarSlot } from "@/components/ui/source-list";
import { ConfirmDialogHost, confirmStore } from "@/components/ui/confirm-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";

const SRC = join(__dirname, "..");
const read = (path: string) => readFileSync(join(SRC, path), "utf8");

const TITLE = "Why is Plex buffering?";

function setAssistant(overrides: Record<string, unknown> = {}) {
  assistant.set({
    messages: [],
    status: "ready",
    error: undefined,
    clearError: vi.fn(),
    stop: vi.fn(),
    conversations: [
      { id: "a", title: TITLE, platform: "web", externalId: null, createdAt: "", updatedAt: new Date().toISOString() },
    ],
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
    startNew: vi.fn(() => assistant.set({ ...assistant.state, activeId: null, messages: [] })),
    ...overrides,
  });
}

const openChat = () => ({
  activeId: "a",
  messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Plex keeps stopping" }] }],
});

function renderPage() {
  const store = createStore();
  const utils = render(
    <Provider store={store}>
      <TooltipProvider>
        {embedded.value && <WindowSidebarSlot />}
        {embedded.value && <WindowToolbarSlot />}
        <AssistantPage />
        <ConfirmDialogHost />
      </TooltipProvider>
    </Provider>,
  );
  const toolbar = () => utils.container.querySelector<HTMLElement>('[data-desktop-app-toolbar="true"]');
  return { ...utils, store, toolbar };
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

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  // A decided confirm waits out its exit animation; don't leave it queued
  act(() => confirmStore.reset());
});

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  embedded.value = true;
  keyboard.value = { mode: "physical", inputMode: "none", showToggle: false, toggle: vi.fn() };
  composer.props = {};
  router.push.mockClear();
  setAssistant();
  window.history.replaceState(null, "", "/dashboard/assistant");
});

describe("the Assistant in a window", () => {
  it("publishes no title-bar verbs, and no Back that would only go home", () => {
    setAssistant(openChat());
    const { store } = renderPage();
    expect(store.get(pageTitleAtom)).toBe(TITLE);
    expect(store.get(desktopAppActionsAtom)).toEqual([]);
    expect(store.get(pageBackAtom)).toBeNull();
  });

  it("puts New chat in the toolbar row, which gives way to the sidebar's New chat row", () => {
    setAssistant(openChat());
    const { toolbar, container } = renderPage();
    const row = toolbar();
    expect(row).not.toBeNull();
    // The two never show together: the toolbar hides exactly when the sidebar shows
    expect(row!.className).toContain(WINDOW_SIDEBAR_REPLACES);
    const sidebarSlot = container.querySelector<HTMLElement>("[data-window-sidebar]")!;
    expect(sidebarSlot.className).toMatch(/(^|\s)hidden(\s|$)/);
    expect(sidebarSlot.className).toContain("@2xl/window:flex");
    expect(within(sidebarSlot).getByRole("button", { name: "New chat" })).toBeInTheDocument();

    const newChat = within(row!).getByRole("button", { name: "New chat" });
    expect(newChat.className).toContain("pointer-coarse:h-11");
    act(() => newChat.focus());
    fireEvent.click(newChat);
    expect(assistant.state.startNew).toHaveBeenCalledTimes(1);
    // The button left with the chat; focus moves on to the composer
    expect(toolbar()).toBeNull();
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveFocus();
  });

  it("lands on the home view's heading instead on a touch screen (no keyboard pops up)", () => {
    stubPointer(true);
    setAssistant(openChat());
    const { toolbar } = renderPage();
    const newChat = within(toolbar()!).getByRole("button", { name: "New chat" });
    act(() => newChat.focus());
    fireEvent.click(newChat);
    expect(screen.getByRole("heading", { name: "How can I help?" })).toHaveFocus();
  });

  it("stays in the chat when you choose to keep the reply being written", async () => {
    setAssistant({ ...openChat(), status: "streaming" });
    const { toolbar } = renderPage();
    const newChat = within(toolbar()!).getByRole("button", { name: "New chat" });
    act(() => newChat.focus());
    fireEvent.click(newChat);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(assistant.state.startNew).not.toHaveBeenCalled();
    expect(toolbar()).not.toBeNull();
  });

  it("shows no toolbar on the home view, which is already a new chat", () => {
    const { toolbar, store } = renderPage();
    expect(toolbar()).toBeNull();
    expect(store.get(pageTitleAtom)).toBe("Assistant");
    expect(store.get(pageBackAtom)).toBeNull();
  });

  it("keeps Back when it returns to the page that opened the Assistant", () => {
    setAssistant(openChat());
    window.history.replaceState(null, "", "/dashboard/assistant?from=%2Fdashboard%2Fmedia&c=a");
    const { store } = renderPage();
    const back = store.get(pageBackAtom);
    expect(back).toBeTypeOf("function");

    act(() => back!());
    expect(router.push).toHaveBeenCalledWith("/dashboard/media");
    // Used once: the title bar has nothing to go back to now
    expect(store.get(pageBackAtom)).toBeNull();
  });

  it("shows no Back when the desktop opened it (Back would only show the home view)", () => {
    setAssistant(openChat());
    window.history.replaceState(null, "", "/dashboard/assistant?from=%2Fdashboard%2Fdesktop&c=a");
    const first = renderPage();
    expect(first.store.get(pageBackAtom)).toBeNull();
    first.unmount();

    // In the classic layout the same origin is a page to go back to, and
    // Back is named for it, not for the chat list
    embedded.value = false;
    renderPage();
    const back = screen.getByRole("button", { name: "Back" });
    fireEvent.click(back);
    expect(router.push).toHaveBeenCalledWith("/dashboard/desktop");
  });
});

describe("the Assistant's classic header", () => {
  beforeEach(() => {
    embedded.value = false;
  });

  it("keeps Back to the chat list and the same New chat, at 44px on touch", () => {
    setAssistant(openChat());
    const { toolbar } = renderPage();
    expect(toolbar()).toBeNull();

    const back = screen.getByRole("button", { name: "Back to conversations" });
    expect(back.className).toContain("pointer-coarse:size-11");
    expect(screen.getByRole("button", { name: "Open navigation" }).className).toContain("pointer-coarse:size-11");

    const newChat = screen.getByRole("button", { name: "New chat" });
    expect(newChat.className).toContain("pointer-coarse:h-11");
    act(() => newChat.focus());
    fireEvent.click(newChat);
    expect(assistant.state.startNew).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "New chat" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveFocus();
  });

  it("offers neither on the home view", () => {
    renderPage();
    expect(screen.queryByRole("button", { name: "Back to conversations" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New chat" })).not.toBeInTheDocument();
  });
});

describe("the composer's keyboard toggle", () => {
  it("is named, says whether the on-screen keyboard is on, and is a 44px target on touch", () => {
    keyboard.value = { mode: "virtual", inputMode: "text", showToggle: true, toggle: vi.fn() };
    const { unmount } = renderPage();
    const toggle = screen.getByRole("button", { name: "Virtual keyboard" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle.className).toContain("pointer-coarse:size-11");
    expect(composer.props.inputMode).toBe("text");
    fireEvent.click(toggle);
    expect(keyboard.value.toggle).toHaveBeenCalledTimes(1);
    unmount();

    // Off: the composer holds the on-screen keyboard back (a hardware keyboard is in use)
    keyboard.value = { mode: "physical", inputMode: "none", showToggle: true, toggle: vi.fn() };
    renderPage();
    expect(screen.getByRole("button", { name: "Virtual keyboard" })).toHaveAttribute("aria-pressed", "false");
    expect(composer.props.inputMode).toBe("none");
  });

  it("stays out of sight without a touch screen, and leaves the keyboard to the browser", () => {
    renderPage();
    expect(screen.queryByRole("button", { name: "Virtual keyboard" })).not.toBeInTheDocument();
    // Still rendered (hidden), so the Tooltip tree keeps its shape for hydration
    expect(document.querySelector('button[aria-label="Virtual keyboard"]')).toHaveAttribute("hidden");
    expect(composer.props.inputMode).toBeUndefined();
  });
});

describe("buttons that float over the conversation", () => {
  it("stay opaque on hover inside a window, where --muted is see-through", () => {
    render(<ConversationDownload messages={[]} />);
    const download = screen.getByRole("button", { name: "Download conversation" });
    expect(download).toHaveAttribute("data-floating");
    expect(download.className).toContain("dark:hover:bg-surface-popover");
    expect(download.className).not.toMatch(/hover:bg-muted\b/);

    const source = read("components/ai-elements/conversation.tsx");
    const scrollButton = /export const ConversationScrollButton = [\s\S]*?\n\};/.exec(source)![0];
    expect(scrollButton).toContain("dark:hover:bg-surface-popover");
    expect(scrollButton).toContain("data-floating");
    expect(scrollButton).not.toMatch(/hover:bg-muted\b/);
  });
});

describe("a tool card's header", () => {
  it("is at least 44px tall on touch, with its chevron always showing there", () => {
    render(
      <Tool>
        <ToolHeader type="tool-get_system_stats" state="output-available" />
      </Tool>,
    );
    const header = screen.getByRole("button", { name: /Get system stats/ });
    expect(header.className).toContain("pointer-coarse:min-h-11");
    const chevron = [...header.querySelectorAll(":scope > svg")].at(-1);
    expect(chevron?.getAttribute("class")).toContain("pointer-coarse:opacity-100");
  });
});
