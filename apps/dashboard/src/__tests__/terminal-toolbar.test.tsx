/**
 * The Terminal's controls (the relayed request: "revisit positions of the
 * controls of the Terminal window"): a clean title bar that just says Terminal,
 * one toolbar row on the window glass (in place in classic mode) holding the
 * session picker where no sidebar lists the sessions, the Auto switch, the
 * image and keyboard controls and one split button for the agent. Every
 * control is 44px on touch, and a phone's row folds the small controls into a
 * menu so it fits at 375px.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ComponentProps } from "react";

const embedded = vi.hoisted(() => ({ value: true }));
vi.mock("@/hooks/use-desktop-mode", () => ({ useIsEmbeddedFrame: () => embedded.value }));
const keyboard = vi.hoisted(() => ({ showToggle: false }));
vi.mock("@/hooks/use-keyboard-mode", () => ({
  useKeyboardMode: () => ({ showToggle: keyboard.showToggle, mode: "virtual", inputMode: "text", toggle: vi.fn() }),
}));
vi.mock("next/dynamic", () => ({
  default: () =>
    function TerminalInnerStub({ sessionId }: { sessionId?: string }) {
      return <div data-testid="terminal-inner" data-session={sessionId} />;
    },
}));
vi.mock("@/components/ui/live-announcer", () => ({ announce: vi.fn() }));
const { toast } = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast }));

import { TerminalPage } from "@/components/terminal/terminal-page";
import { TerminalToolbar } from "@/components/terminal/terminal-toolbar";
import { RebuildDashboardButton } from "@/components/terminal/rebuild-dashboard-button";
import TerminalError from "@/app/dashboard/terminal/error";
import { WindowToolbarSlot } from "@/components/desktop/window-content";
import { WINDOW_SIDEBAR_REPLACES, WindowSidebarSlot } from "@/components/ui/source-list";
import { ConfirmDialogHost } from "@/components/ui/confirm-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { launchTerminalAgentAtom } from "@/atoms/terminal";
import { pageTitleAtom } from "@/atoms/page-title";
import { desktopAppActionsAtom } from "@/atoms/desktop-app-actions";

const SRC = join(__dirname, "..");
const read = (path: string) => readFileSync(join(SRC, path), "utf8");

type Route = { status: number; body?: unknown };
const now = Date.now();
const session = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  clients: 0,
  createdAt: now - 60_000,
  lastActivityAt: now - 5 * 60_000,
  uptime: 60_000,
  ...extra,
});
let routes: Record<string, Route>;
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), "http://localhost");
  const route = routes[`${init?.method ?? "GET"} ${url.pathname}`] ?? { status: 500, body: { error: "not mocked" } };
  return { ok: route.status >= 200 && route.status < 300, status: route.status, json: async () => route.body } as Response;
});

let store: ReturnType<typeof createStore>;
function renderTerminal() {
  store = createStore();
  return render(
    <Provider store={store}>
      <TooltipProvider>
        {embedded.value && <WindowSidebarSlot />}
        {embedded.value && <WindowToolbarSlot />}
        <TerminalPage />
        <ConfirmDialogHost />
      </TooltipProvider>
    </Provider>,
  );
}

const noop = () => {};
function renderToolbar(props: Partial<ComponentProps<typeof TerminalToolbar>> = {}, launch?: (...args: unknown[]) => void) {
  store = createStore();
  if (launch) store.set(launchTerminalAgentAtom, () => launch);
  return render(
    <Provider store={store}>
      <TooltipProvider>
        <TerminalToolbar
          userSessions={[session("sess_default", { name: "Default", clients: 1 })]}
          systemSessions={[]}
          selectedSessionId="sess_default"
          selectedSessionName="Default"
          onSelect={noop}
          onCreate={noop}
          onDelete={noop}
          onRefresh={noop}
          connected
          autoMode={false}
          onAutoModeChange={noop}
          remote={false}
          onRemoteChange={noop}
          remoteActive={false}
          onImageUpload={noop}
          {...props}
        />
        <ConfirmDialogHost />
      </TooltipProvider>
    </Provider>,
  );
}

/** Radix menus open on pointerdown (or Enter); jsdom has no layout, so use the keyboard. */
const openMenu = (trigger: HTMLElement) => fireEvent.keyDown(trigger, { key: "Enter" });

beforeEach(() => {
  embedded.value = true;
  keyboard.showToggle = false;
  localStorage.clear();
  fetchMock.mockClear();
  toast.mockClear();
  toast.success.mockClear();
  toast.error.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  routes = {
    "POST /api/terminal/session": { status: 200, body: { token: "tok" } },
    "GET /api/terminal/project-root": { status: 200, body: { path: "/srv/talome" } },
    "GET /api/terminal/sessions": {
      status: 200,
      body: { sessions: [session("sess_default", { clients: 1 }), session("sess_session-2")] },
    },
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Terminal in a desktop window", () => {
  it("keeps the title bar clean: no title-bar controls, and the window is just \"Terminal\"", async () => {
    renderTerminal();
    await screen.findByTestId("terminal-inner");
    expect(store.get(desktopAppActionsAtom)).toEqual([]);
    // No page title, so the window shows the app's own name
    await waitFor(() => expect(store.get(pageTitleAtom)).toBeNull());

    // Switching sessions doesn't rename the window
    const nav = await screen.findByRole("navigation", { name: "Terminal" });
    fireEvent.click(await within(nav).findByRole("button", { name: /^session 2/ }));
    await waitFor(() => expect(store.get(pageTitleAtom)).toBeNull());
  });

  it("puts every control in the window's toolbar row, on the glass and outside the dark well", async () => {
    const { container } = renderTerminal();
    await screen.findByTestId("terminal-inner");
    const toolbar = container.querySelector<HTMLElement>('[data-desktop-app-toolbar="true"]')!;
    expect(toolbar).not.toBeNull();
    expect(toolbar.closest(".dark")).toBeNull();
    // The toolbar slot comes before the terminal in the window's column
    expect(toolbar.compareDocumentPosition(screen.getByTestId("terminal-inner")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const row = within(toolbar);
    expect(row.getByRole("switch", { name: "Auto: skip permission prompts" })).toBeInTheDocument();
    expect(row.getByRole("button", { name: "Attach image" })).toBeInTheDocument();
    expect(row.getByRole("button", { name: "Continue Claude Code" })).toBeInTheDocument();
    expect(row.getByRole("button", { name: "More Claude Code options" })).toBeInTheDocument();
    // No "Session" menu, no Rebuild, no session name repeated beside the title
    expect(row.queryByRole("button", { name: "Session" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Rebuild/ })).toBeNull();
    // Nothing on the glass paints the opaque page colour (a switch's thumb is the switch)
    const opaque = Array.from(toolbar.querySelectorAll<HTMLElement>("[class]"))
      .filter((element) => /(?:^|\s)bg-background(?:\s|$)/.test(element.getAttribute("class") ?? ""))
      .filter((element) => element.dataset.slot !== "switch-thumb");
    expect(opaque).toEqual([]);
  });

  it("drops the session picker where the sidebar lists the sessions (and keeps it in narrow windows)", async () => {
    const { container } = renderTerminal();
    await screen.findByTestId("terminal-inner");
    const toolbar = container.querySelector<HTMLElement>('[data-desktop-app-toolbar="true"]')!;
    const picker = within(toolbar).getByRole("button", { name: /^Default/ });
    const wrapper = picker.parentElement!;
    for (const name of WINDOW_SIDEBAR_REPLACES.split(" ")) expect(wrapper).toHaveClass(name);
  });
});

describe("Terminal in classic mode", () => {
  it("uses the same toolbar in place, above the terminal, and leaves the header title alone", async () => {
    embedded.value = false;
    const { container } = renderTerminal();
    await screen.findByTestId("terminal-inner");
    expect(container.querySelector('[data-desktop-app-toolbar="true"]')).toBeNull();
    const toolbar = container.querySelector<HTMLElement>("[data-terminal-toolbar]")!;
    expect(toolbar).not.toBeNull();
    expect(toolbar.closest(".dark")).toBeNull();
    expect(within(toolbar).getByRole("button", { name: /^Default/ })).toBeInTheDocument();
    expect(within(toolbar).getByRole("switch", { name: "Auto: skip permission prompts" })).toBeInTheDocument();
    expect(within(toolbar).getByRole("button", { name: "Continue Claude Code" })).toBeInTheDocument();
    expect(store.get(pageTitleAtom)).toBeNull();
  });

  it("leaves the home indicator to the classic shell, so a phone isn't padded twice", () => {
    const page = read("components/terminal/terminal-page.tsx");
    expect(page).not.toMatch(/safe-area-inset-bottom/);
    expect(read("components/ui/sidebar.tsx") + read("components/layout/dashboard-shell.tsx")).toMatch(/pb-\[env\(safe-area-inset-bottom\)\]/);
  });

  it("hides the session's time on touch rather than drawing it under the End button", async () => {
    embedded.value = false;
    renderTerminal();
    await screen.findByTestId("terminal-inner");
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/api/terminal/sessions"))).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: /^Default/ }));
    await screen.findByRole("button", { name: "End session 2" });
    const times = Array.from(document.querySelectorAll<HTMLElement>("[data-session-time]"));
    const deletable = times.filter((time) => time.parentElement?.querySelector('button[aria-label^="End "]'));
    expect(deletable.length).toBeGreaterThan(0);
    for (const time of deletable) {
      // display:none, which the global touch rule (it forces opacity to 1) can't undo
      expect(time).toHaveClass("pointer-coarse:hidden");
      expect(time.className).not.toMatch(/pointer-coarse:opacity-0/);
    }
    const touchRule = /@media \(hover: none\) and \(pointer: coarse\) \{\s*\[class\*="group-hover"\]\[class\*="opacity-0"\] \{([^}]*)\}/.exec(read("app/globals.css"));
    expect(touchRule?.[1]).not.toMatch(/display/);
  });
});

describe("Terminal toolbar controls", () => {
  it("names Auto and explains it, and fills the switch amber only when on", () => {
    const onAutoModeChange = vi.fn();
    renderToolbar({ onAutoModeChange });
    const auto = screen.getByRole("switch", { name: "Auto: skip permission prompts" });
    expect(auto).toHaveAttribute("aria-checked", "false");
    expect(auto).toHaveClass("data-[state=checked]:bg-status-warning");
    expect(screen.getByText("Auto")).toHaveClass("text-muted-foreground");
    fireEvent.click(auto);
    expect(onAutoModeChange).toHaveBeenCalledWith(true);
  });

  it("gives the Auto switch its hint without hover (the tooltip's trigger is the label)", () => {
    renderToolbar();
    expect(screen.getByRole("switch", { name: "Auto: skip permission prompts" })).toHaveAccessibleDescription("Require permission prompts");
    localStorage.setItem("talome-terminal-agent", "codex");
    renderToolbar();
    const switches = screen.getAllByRole("switch", { name: "Auto: skip permission prompts" });
    expect(switches.at(-1)).toHaveAccessibleDescription("Codex keeps its own permission settings");
  });

  it("shows remote control on the launch button while it's on for the next launch", () => {
    renderToolbar({ remote: true }, vi.fn());
    const primary = screen.getByRole("button", { name: "Continue Claude Code with remote control" });
    expect(primary.querySelector("[data-terminal-remote]")).not.toBeNull();
  });

  it("doesn't claim remote control for an agent that can't take it", () => {
    localStorage.setItem("talome-terminal-agent", "kimi");
    renderToolbar({ remote: true }, vi.fn());
    const primary = screen.getByRole("button", { name: "Continue Kimi Code" });
    expect(primary.querySelector("[data-terminal-remote]")).toBeNull();
  });

  it("remembers Auto on this device when switched in the page", async () => {
    embedded.value = false;
    renderTerminal();
    await screen.findByTestId("terminal-inner");
    fireEvent.click(screen.getByRole("switch", { name: "Auto: skip permission prompts" }));
    expect(localStorage.getItem("talome-auto-mode")).toBe("true");
    expect(screen.getByRole("switch", { name: "Auto: skip permission prompts" })).toHaveAttribute("aria-checked", "true");
  });

  it("continues the agent from the split button, and starts a new one from its menu", async () => {
    const launch = vi.fn();
    renderToolbar({}, launch);
    fireEvent.click(screen.getByRole("button", { name: "Continue Claude Code" }));
    expect(launch).toHaveBeenLastCalledWith("claude-code", true);

    openMenu(screen.getByRole("button", { name: "More Claude Code options" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Continue Claude Code",
      "New Claude Code session",
    ]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "New Claude Code session" }));
    expect(launch).toHaveBeenLastCalledWith("claude-code", false);
  });

  it("chooses the agent in the same menu, as a radio group, and offers remote control only for Claude Code", async () => {
    const onRemoteChange = vi.fn();
    renderToolbar({ onRemoteChange }, vi.fn());
    openMenu(screen.getByRole("button", { name: "More Claude Code options" }));
    let menu = await screen.findByRole("menu");
    const agents = within(menu).getAllByRole("menuitemradio");
    expect(agents.map((item) => item.textContent)).toEqual(["Claude Code", "Codex", "Kimi Code"]);
    expect(within(menu).getByRole("menuitemradio", { name: "Claude Code" })).toHaveAttribute("aria-checked", "true");

    const remote = within(menu).getByRole("menuitemcheckbox", { name: "Remote control for the next launch" });
    expect(remote).toHaveAttribute("aria-checked", "false");
    fireEvent.click(remote);
    expect(onRemoteChange).toHaveBeenCalledWith(true);

    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Codex" }));
    expect(localStorage.getItem("talome-terminal-agent")).toBe("codex");
    const primary = await screen.findByRole("button", { name: "Continue Codex" });
    expect(primary).toBeInTheDocument();

    openMenu(screen.getByRole("button", { name: "More Codex options" }));
    menu = await screen.findByRole("menu");
    expect(within(menu).queryByRole("menuitemcheckbox", { name: /Remote control/ })).toBeNull();
  });

  it("can't launch before the terminal is connected", async () => {
    renderToolbar({ connected: false });
    expect(screen.getByRole("button", { name: "Continue Claude Code" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Attach image" })).toBeDisabled();
    openMenu(screen.getByRole("button", { name: "More Claude Code options" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Continue Claude Code" })).toHaveAttribute("data-disabled");
  });

  it("shows a running remote session from its state, with a static healthy dot and words", () => {
    const { rerender } = renderToolbar({ remote: true, remoteActive: false });
    expect(screen.queryByText(/Remote/, { selector: "[role=status] *" })).toBeNull();
    rerender(
      <Provider store={store}>
        <TooltipProvider>
          <TerminalToolbar
            userSessions={[]}
            systemSessions={[]}
            onSelect={noop}
            onCreate={noop}
            onDelete={noop}
            onRefresh={noop}
            connected
            autoMode={false}
            onAutoModeChange={noop}
            remote={false}
            onRemoteChange={noop}
            remoteActive
          />
        </TooltipProvider>
      </Provider>,
    );
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Remote session active");
    expect(status.querySelector(".bg-status-healthy")).not.toBeNull();
    expect(status.innerHTML).not.toMatch(/animate-/);
  });

  it("gives every control a 44px target on touch", () => {
    keyboard.showToggle = true;
    const { container } = renderToolbar({ showKeyboardToggle: true, onToggleKeyboard: vi.fn(), connectionStatus: "disconnected", onReconnect: vi.fn() });
    const targets = [
      ...Array.from(container.querySelectorAll<HTMLElement>("[data-terminal-toolbar] button:not([role=switch])")),
      container.querySelector<HTMLElement>("[data-terminal-auto]")!,
    ];
    expect(targets.length).toBeGreaterThanOrEqual(8);
    for (const target of targets) {
      expect(target.className, target.getAttribute("aria-label") ?? target.textContent ?? "").toMatch(/pointer-coarse:(h|size)-11/);
    }
  });

  it("folds the image and keyboard controls into one menu on a narrow row", async () => {
    const onToggleKeyboard = vi.fn();
    renderToolbar({ showKeyboardToggle: true, onToggleKeyboard });
    const more = screen.getByRole("button", { name: "More terminal controls" });
    expect(more).toHaveClass("@md:hidden");
    for (const name of ["Attach image", "Virtual keyboard"]) {
      expect(screen.getByRole("button", { name })).toHaveClass("hidden", "@md:inline-flex");
    }
    openMenu(more);
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Attach image…" })).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "Virtual keyboard" }));
    expect(onToggleKeyboard).toHaveBeenCalled();
  });

  it("keeps a lone image button inline (a window, or a device without touch)", () => {
    renderToolbar();
    expect(screen.queryByRole("button", { name: "More terminal controls" })).toBeNull();
    expect(screen.getByRole("button", { name: "Attach image" })).not.toHaveClass("hidden");
  });

  it("lays its row out by its column (container queries), never the screen", () => {
    const source = read("components/terminal/terminal-toolbar.tsx");
    expect(source).not.toMatch(/(?:^|[\s"'`])(?:max-)?(?:sm|md|lg|xl|2xl):[\w[-]/);
    expect(source).toContain("@md:");
  });
});

it("renames a session through its display name without changing the selected PTY", async () => {
  routes["PATCH /api/terminal/sessions/sess_default"] = { status: 200, body: { ok: true } };
  renderTerminal();
  await screen.findByRole("button", { name: "Rename session" });
  fireEvent.click(screen.getByRole("button", { name: "Rename session" }));
  fireEvent.change(screen.getByLabelText("Session name"), { target: { value: "  My shell  " } });
  fireEvent.click(screen.getByRole("button", { name: "Save name" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/sessions/sess_default"), expect.objectContaining({ method: "PATCH", body: JSON.stringify({ displayName: "My shell" }) }));
  expect(screen.getByTestId("terminal-inner")).toHaveAttribute("data-session", "sess_default");
  expect(within(screen.getByRole("navigation", { name: "Terminal" })).getByRole("button", { name: /^My shell/ })).toBeInTheDocument();
});

describe("Terminal error boundary", () => {
  it("uses the shared error state that fills the window, with Retry", () => {
    const reset = vi.fn();
    render(<TerminalError error={new Error("boom")} reset={reset} />);
    expect(screen.getByText("Couldn't open the Terminal")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(reset).toHaveBeenCalled();
    expect(read("app/dashboard/terminal/error.tsx")).not.toMatch(/text-\[\d/);
  });
});

describe("Rebuild (moved out of the Terminal toolbar)", () => {
  it("shows its work with the button's busy state and reports the outcome in a toast", async () => {
    let finish!: (route: Route) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      finish = (route) => resolve({ ok: route.status < 300, status: route.status, json: async () => route.body } as Response);
    })));
    render(<RebuildDashboardButton />);
    const button = screen.getByRole("button", { name: "Rebuild" });
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button.className).not.toMatch(/text-status-/);
    await act(async () => finish({ status: 200, body: { ok: true, duration: 4200 } }));
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/^Rebuilt Talome in 4[.,]2 s$/), expect.anything());
    expect(read("components/terminal/terminal-session-toolbar.tsx")).not.toMatch(/Rebuild|animate-spin/);
  });
});
