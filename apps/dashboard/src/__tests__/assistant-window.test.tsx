/**
 * The Assistant in a desktop window: its chat sidebar makes Delete easy to
 * find and safe (on hover, always on the open chat, and in each row's context
 * menu; the same undoable delete as the classic list), shows the full title
 * on hover and a muted time that tells similar chats apart; its content
 * column follows the window's width, not the screen's; and nothing floats
 * over text you can read.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/dashboard/assistant",
}));
const embedded = vi.hoisted(() => ({ value: true }));
vi.mock("@/hooks/use-desktop-mode", () => ({ useIsEmbeddedFrame: () => embedded.value }));
const toastMock = vi.hoisted(() => Object.assign(vi.fn(() => "toast-1"), { dismiss: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("swr", () => ({ default: () => ({ data: undefined }) }));
vi.mock("thinking-orbs", () => ({ ThinkingOrb: () => null }));
vi.mock("@/components/ai-elements/chat-input-bar", () => ({ ChatInputBar: ({ onVoiceMode }: { onVoiceMode: () => void }) => <button data-testid="composer" onClick={onVoiceMode}>Start voice conversation</button> }));
vi.mock("@/components/assistant/voice-mode", () => ({ VoiceMode: ({ open, onClose }: { open: boolean; onClose: () => void }) => open ? <div role="dialog" aria-label="Voice conversation"><button onClick={onClose}>End voice conversation</button></div> : null }));
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

const HOUR = 3_600_000;
const longTitle = (n: number) => `Help the user work with the LiteMol Protein Viewer. PDB entry ${n}`;
const assistant = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock("@/components/assistant/assistant-context", () => ({ useAssistant: () => assistant.state }));

import AssistantPage from "@/app/dashboard/assistant/page";
import { WindowSidebarSlot } from "@/components/ui/source-list";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CHAT_ROW_ACTION_SHOWN, chatRowMeta, chatTitle } from "@/components/assistant/chat-source-item";
import { relativeTime } from "@/lib/format";

const SRC = join(__dirname, "..");
const read = (path: string) => readFileSync(join(SRC, path), "utf8");

function conversations() {
  const now = Date.now();
  return [
    { id: "a", title: longTitle(1), platform: "web", externalId: null, createdAt: "", updatedAt: new Date(now - 2 * HOUR - 60_000).toISOString() },
    { id: "b", title: longTitle(2), platform: "web", externalId: null, createdAt: "", updatedAt: new Date(now - 3 * HOUR - 60_000).toISOString() },
    { id: "t", title: "Downloads tonight", platform: "telegram", externalId: "42", createdAt: "", updatedAt: new Date(now - 4 * HOUR).toISOString() },
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
    ...overrides,
  };
}

function Window({ children }: { children: ReactNode }) {
  return (
    <Provider store={createStore()}>
      <TooltipProvider>
        <WindowSidebarSlot />
        {children}
      </TooltipProvider>
    </Provider>
  );
}

function renderWindow() {
  const utils = render(
    <Window>
      <AssistantPage />
    </Window>,
  );
  return { ...utils, sidebar: () => screen.getByRole("navigation", { name: "Chats" }) };
}

const openChat = () => ({
  activeId: "a",
  messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Open the viewer" }] }],
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
  toastMock.mockClear();
  setAssistant();
  window.history.replaceState(null, "", "/dashboard/assistant");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the Assistant's chat sidebar", () => {
  it("removes the chat sidebar during voice mode and restores it on exit", () => {
    renderWindow();
    expect(screen.getByRole("navigation", { name: "Chats" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start voice conversation" }));
    expect(screen.getByRole("dialog", { name: "Voice conversation" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Chats" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "End voice conversation" }));
    expect(screen.getByRole("navigation", { name: "Chats" })).toBeInTheDocument();
  });

  it("shows the full title on hover and a muted time (or the bot's platform) that tells similar chats apart", () => {
    const { sidebar } = renderWindow();
    const rows = within(sidebar());
    const second = rows.getByRole("button", { name: new RegExp(`^${longTitle(2).replace(/[.]/g, "\\.")}`) });
    expect(second).toHaveAttribute("title", longTitle(2));
    expect(second).toHaveTextContent(relativeTime(conversations()[1].updatedAt));
    expect(second).toHaveTextContent("3 hr ago");
    // Title and time are read as two parts, not run together ("PDB entry 23 hr ago")
    expect(second).toHaveAccessibleName(`${longTitle(2)}, 3 hr ago`);
    expect(rows.getByRole("button", { name: /^Downloads tonight/ })).toHaveTextContent("Telegram");
  });

  it("keeps Delete on screen for the open chat, where the time would be", () => {
    setAssistant(openChat());
    const { sidebar } = renderWindow();
    const open = within(sidebar()).getByRole("button", { name: longTitle(1) });
    expect(open).toHaveAttribute("aria-current", "page");
    // No time on the open chat: Delete stays in its place
    expect(open).not.toHaveTextContent("ago");
    const row = open.closest<HTMLElement>("[data-chat-row]")!;
    expect(row.className).toContain(CHAT_ROW_ACTION_SHOWN);
    const remove = within(row).getByRole("button", { name: `Delete "${longTitle(1)}"` });
    // CHAT_ROW_ACTION_SHOWN reaches exactly this button
    expect(remove.matches("[data-chat-row] > div > button + button")).toBe(true);

    // Other rows show it on hover and focus only
    const other = within(sidebar()).getByRole("button", { name: /^Help the user.*PDB entry 2/ }).closest<HTMLElement>("[data-chat-row]")!;
    expect(other.className).not.toContain(CHAT_ROW_ACTION_SHOWN);
  });

  it("deletes from a row's context menu with the same Undo as the classic list", async () => {
    const { sidebar } = renderWindow();
    const row = within(sidebar()).getByRole("button", { name: /^Help the user.*PDB entry 2/ });
    fireEvent.contextMenu(row);
    const item = await screen.findByRole("menuitem", { name: "Delete" });
    fireEvent.click(item);

    expect(within(sidebar()).queryByRole("button", { name: /^Help the user.*PDB entry 2/ })).not.toBeInTheDocument();
    expect(toastMock).toHaveBeenCalledWith(
      `Deleted "${longTitle(2)}"`,
      expect.objectContaining({ action: expect.objectContaining({ label: "Undo" }) }),
    );
    // Nothing is deleted on the server until the Undo window has passed
    expect(assistant.state.deleteConversation).not.toHaveBeenCalled();
  });

  it("deletes from the row's own button too, without opening the chat", () => {
    const { sidebar } = renderWindow();
    fireEvent.click(within(sidebar()).getByRole("button", { name: `Delete "${longTitle(2)}"` }));
    expect(within(sidebar()).queryByRole("button", { name: /^Help the user.*PDB entry 2/ })).not.toBeInTheDocument();
    expect(assistant.state.setActiveId).not.toHaveBeenCalled();
  });

  it("drops a date group once Undo has emptied it", () => {
    setAssistant({
      conversations: [
        ...conversations(),
        { id: "o", title: "The only older chat", platform: "web", externalId: null, createdAt: "", updatedAt: new Date(Date.now() - 30 * 24 * HOUR).toISOString() },
      ],
    });
    const { sidebar } = renderWindow();
    expect(within(sidebar()).getByRole("heading", { name: "Older" })).toBeInTheDocument();
    fireEvent.click(within(sidebar()).getByRole("button", { name: 'Delete "The only older chat"' }));
    expect(within(sidebar()).queryByRole("heading", { name: "Older" })).not.toBeInTheDocument();
  });

  it("names chats the same way everywhere", () => {
    expect(chatTitle({ title: "  " })).toBe("Untitled conversation");
    expect(chatRowMeta({ platform: "discord", updatedAt: new Date().toISOString() })).toBe("Discord");
    expect(chatRowMeta({ platform: "web", updatedAt: new Date().toISOString() })).toBe("just now");
  });
});

describe("the Assistant's content column", () => {
  it("sizes its gutters and suggestion grid by its own width, not the screen's", () => {
    const { container } = renderWindow();
    expect(container.querySelector(".\\@container\\/assistant")).not.toBeNull();
    const suggestion = screen.getByRole("button", { name: "Check system health" });
    const grid = suggestion.parentElement!;
    expect(grid.className).toContain("grid-cols-1");
    expect(grid.className).toContain("@xs/assistant:grid-cols-2");
    // A long label wraps to a second line instead of losing its end
    expect(within(suggestion).getByText("Check system health").className).toContain("line-clamp-2");
    // Screen breakpoints misjudge a window: its column is narrower than the screen
    expect(read("app/dashboard/assistant/page.tsx")).not.toMatch(/\bsm:(px|mb|text|grid)-|sm:py-6/);
    expect(read("components/ai-elements/chat-input-bar.tsx")).not.toMatch(/\bsm:px-/);
  });

  it("gives the Assistant's turns the whole column and your own a bubble of at most four fifths", () => {
    const message = read("components/ai-elements/message.tsx");
    expect(message).not.toMatch(/max-w-\[\d+%\]/);
    expect(message).toMatch(/"is-user ml-auto max-w-4\/5 justify-end"/);
    expect(message).toMatch(/group-\[\.is-assistant\]:-mx-2 group-\[\.is-assistant\]:w-auto group-\[\.is-assistant\]:max-w-none/);
    expect(message).not.toMatch(/uppercase/);
  });

  it("keeps the composer's text at text-sm in a window narrower than md (16px on touch only)", () => {
    const input = read("components/ai-elements/prompt-input.tsx");
    expect(input).not.toMatch(/text-lg md:text-sm/);
    expect(input).toMatch(/text-sm pointer-coarse:text-base/);
  });
});

describe("nothing floats over text you can read", () => {
  const rem = (step: string) => Number(step) * 0.25;

  it("pads the conversation's end by exactly the fade, so the last line is never faded", () => {
    setAssistant(openChat());
    renderWindow();
    const content = screen.getByText("Open the viewer").parentElement!;
    const scroller = content.parentElement!;
    const pad = /(?:^|\s)pb-(\d+(?:\.\d+)?)(?:\s|$)/.exec(content.className)?.[1];
    const fade = /\[mask-image:linear-gradient\(to_bottom,black_calc\(100%-([\d.]+)rem\),transparent\)\]/.exec(scroller.className)?.[1];
    expect(pad).toBeDefined();
    expect(fade).toBeDefined();
    expect(rem(pad!)).toBeGreaterThanOrEqual(Number(fade));
  });

  it("clears a band for the scroll-to-bottom button while it shows", () => {
    setAssistant(openChat());
    renderWindow();
    const scroller = screen.getByText("Open the viewer").parentElement!.parentElement!;
    const band = /group-has-\[\[data-conversation-scroll-button\]\]\/conversation:\[mask-image:linear-gradient\(to_bottom,black_calc\(100%-([\d.]+)rem\),transparent_calc\(100%-([\d.]+)rem\)\)\]/.exec(scroller.className);
    expect(band).not.toBeNull();
    const clear = Number(band![2]);

    const conversation = read("components/ai-elements/conversation.tsx");
    const button = /export const ConversationScrollButton = [\s\S]*?\n\};/.exec(conversation)![0];
    expect(button).toContain("data-conversation-scroll-button");
    const bottom = rem(/\bbottom-(\d+(?:\.\d+)?)\b/.exec(button)![1]);
    const size = /size="icon-sm"/.test(button) ? 2 : /size="icon"/.test(button) ? 2.25 : NaN;
    // The button's top edge sits inside the band the mask leaves empty
    expect(bottom + size).toBeLessThanOrEqual(clear);
  });

  it("renders the classic history list with the full title on hover, unchanged otherwise", async () => {
    embedded.value = false;
    await act(async () => {
      render(
        <Window>
          <AssistantPage />
        </Window>,
      );
    });
    expect(screen.queryByRole("navigation", { name: "Chats" })).not.toBeInTheDocument();
    const row = screen.getByRole("button", { name: /^Help the user.*PDB entry 2/ });
    expect(row).toHaveAttribute("title", longTitle(2));
    expect(screen.getByRole("button", { name: `Delete "${longTitle(2)}"` })).toBeInTheDocument();
  });
});
