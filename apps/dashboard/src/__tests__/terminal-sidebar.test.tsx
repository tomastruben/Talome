/**
 * The Terminal window's sidebar (the relayed request: "introduce sidebar for
 * other native apps like terminal"): sessions on the window glass, honest
 * loading and error states, a New session row that reports its own failure,
 * and ending a session through the destructive confirm. Classic mode keeps
 * the toolbar's session picker and gets no sidebar.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { ReactNode } from "react";

const embedded = vi.hoisted(() => ({ value: true }));
vi.mock("@/hooks/use-desktop-mode", () => ({ useIsEmbeddedFrame: () => embedded.value }));
vi.mock("@/hooks/use-keyboard-mode", () => ({
  useKeyboardMode: () => ({ showToggle: false, mode: "physical", inputMode: "text", toggle: vi.fn() }),
}));
// xterm can't run in jsdom: a stub that says which session it is attached to.
vi.mock("next/dynamic", () => ({
  default: () =>
    function TerminalInnerStub({ sessionId }: { sessionId?: string }) {
      return <div data-testid="terminal-inner" data-session={sessionId} />;
    },
}));
const { announce } = vi.hoisted(() => ({ announce: vi.fn() }));
vi.mock("@/components/ui/live-announcer", () => ({ announce }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() }) }));

import { TerminalPage } from "@/components/terminal/terminal-page";
import { useTerminalHeaderAction } from "@/components/terminal/use-terminal-header-action";
import { WindowSidebarSlot } from "@/components/ui/source-list";
import { ConfirmDialogHost } from "@/components/ui/confirm-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { launchTerminalAgentAtom } from "@/atoms/terminal";

type Route = { status: number; body?: unknown };
type Handler = Route | (() => Route | Promise<Route>);

const LOCKED = 'The terminal is disabled while the security mode is "locked". An admin can change it in Settings -> Security.';
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

let routes: Record<string, Handler>;
const calls: Array<{ method: string; path: string }> = [];

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), "http://localhost");
  const method = init?.method ?? "GET";
  const key = `${method} ${url.port === "4001" ? "daemon:" : ""}${url.pathname}`;
  calls.push({ method, path: url.pathname });
  const handler = routes[key];
  const route = handler ? (typeof handler === "function" ? await handler() : handler) : { status: 500, body: { error: "not mocked" } };
  return {
    ok: route.status >= 200 && route.status < 300,
    status: route.status,
    json: async () => route.body,
  } as Response;
});

let store: ReturnType<typeof createStore>;
function renderTerminal() {
  store = createStore();
  return render(
    <Provider store={store}>
      <TooltipProvider>
        {embedded.value && <WindowSidebarSlot />}
        <TerminalPage />
        <ConfirmDialogHost />
      </TooltipProvider>
    </Provider>,
  );
}

const sidebar = () => screen.findByRole("navigation", { name: "Terminal" });
const row = (nav: HTMLElement, name: RegExp | string) => within(nav).getByRole("button", { name });

beforeEach(() => {
  embedded.value = true;
  localStorage.clear();
  calls.length = 0;
  fetchMock.mockClear();
  announce.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  routes = {
    "POST /api/terminal/session": { status: 200, body: { token: "tok" } },
    "GET /api/terminal/project-root": { status: 200, body: { path: "/srv/talome" } },
    "GET /api/terminal/sessions": {
      status: 200,
      body: {
        sessions: [
          session("sess_default", { clients: 1 }),
          session("sess_session-2", { recovered: true }),
          session("sess_evolution-ev_1758000000000"),
        ],
      },
    },
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Terminal window sidebar", () => {
  it("lists sessions in the window's sidebar slot, Default first, with an attached dot", async () => {
    renderTerminal();
    const nav = await sidebar();
    // Rendered into the slot beside the app, not inside the terminal's dark surface
    expect(nav.closest(".dark")).toBeNull();
    await within(nav).findByText("session 2");

    const sessions = within(nav).getByRole("heading", { name: "Sessions" }).closest("section")!;
    const labels = within(sessions).getAllByRole("button").map((b) => b.textContent);
    expect(labels[0]).toContain("Default");
    expect(labels.some((l) => l?.includes("session 2"))).toBe(true);

    const defaultRow = row(nav, /^Default/);
    expect(defaultRow).toHaveTextContent("Attached");
    expect(defaultRow).toHaveAttribute("title", "Last active 5 min ago");
    expect(row(nav, /^session 2/)).toHaveAttribute("title", "Last active 5 min ago · Restored after a restart");
    expect(row(nav, /^session 2/)).not.toHaveTextContent("Attached");

    // Agents' sessions sit in their own section, and can be ended, as in the picker
    const system = within(nav).getByRole("heading", { name: "System" }).closest("section")!;
    expect(within(system).getByRole("button", { name: /^Evolution/ })).toBeInTheDocument();
    expect(within(system).getByRole("button", { name: /^End Evolution/ })).toBeInTheDocument();
  });

  it("renames an unselected session from its sidebar pencil without switching or restarting the shell", async () => {
    routes["PATCH /api/terminal/sessions/sess_session-2"] = { status: 200, body: { ok: true } };
    renderTerminal();
    const nav = await sidebar();
    await within(nav).findByText("session 2");
    const selectedShell = (await screen.findByTestId("terminal-inner")).getAttribute("data-session");
    fireEvent.click(within(nav).getByRole("button", { name: "Rename session 2" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename session" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Session name" }), { target: { value: "Media jobs" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save name" }));
    await within(nav).findByText("Media jobs");
    expect(screen.getByTestId("terminal-inner")).toHaveAttribute("data-session", selectedShell);
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
    expect(calls.filter((call) => call.method === "PATCH")).toEqual([{ method: "PATCH", path: "/api/terminal/sessions/sess_session-2" }]);
  });

  it("offers keyboard renaming and explains both attachment states", async () => {
    renderTerminal();
    const nav = await sidebar();
    await within(nav).findByText("session 2");
    expect(within(nav).getByTitle(/Attached to 1 browser client/)).toBeInTheDocument();
    expect(within(nav).getAllByTitle("No browser client attached. The shell keeps running.")).toHaveLength(2);
    fireEvent.keyDown(row(nav, /^session 2/), { key: "F2" });
    const dialog = await screen.findByRole("dialog", { name: "Rename session" });
    expect(within(dialog).getByRole("textbox", { name: "Session name" })).toHaveValue("session 2");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(0);
  });

  it("ends an agent's session through the same destructive confirm", async () => {
    let deleted = false;
    routes["DELETE /api/terminal/sessions/sess_evolution-ev_1758000000000"] = () => {
      deleted = true;
      return { status: 200, body: { ok: true } };
    };
    renderTerminal();
    const nav = await sidebar();
    const system = (await within(nav).findByRole("heading", { name: "System" })).closest("section")!;

    fireEvent.click(within(system).getByRole("button", { name: /^End Evolution/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByRole("heading", { name: /^End “Evolution/ })).toBeInTheDocument();
    routes["GET /api/terminal/sessions"] = { status: 200, body: { sessions: [session("sess_default"), session("sess_session-2")] } };
    fireEvent.click(within(dialog).getByRole("button", { name: "End session" }));
    await waitFor(() => expect(deleted).toBe(true));
    await waitFor(() => expect(within(nav).queryByRole("heading", { name: "System" })).toBeNull());
  });

  it("selecting a row marks it current and attaches the terminal to it", async () => {
    renderTerminal();
    const nav = await sidebar();
    await within(nav).findByText("session 2");
    expect(row(nav, /^Default/)).toHaveAttribute("aria-current", "page");

    fireEvent.click(row(nav, /^session 2/));
    expect(row(nav, /^session 2/)).toHaveAttribute("aria-current", "page");
    expect(row(nav, /^Default/)).not.toHaveAttribute("aria-current");
    await waitFor(() => expect(screen.getByTestId("terminal-inner")).toHaveAttribute("data-session", "sess_session-2"));
  });

  it("shows the skeleton only before the first load, never on a later refresh", async () => {
    let release!: (route: Route) => void;
    routes["GET /api/terminal/sessions"] = () => new Promise<Route>((resolve) => { release = resolve; });
    renderTerminal();
    const nav = await sidebar();
    // The skeleton waits 200ms so a fast load never flashes it
    await waitFor(() => expect(nav.querySelector('[data-slot="source-list-skeleton"]')).not.toBeNull(), { timeout: 1000 });
    expect(within(nav).getByRole("status")).toHaveAttribute("aria-busy", "true");

    await act(async () => release({ status: 200, body: { sessions: [session("sess_default"), session("sess_session-2")] } }));
    await within(nav).findByText("session 2");
    expect(nav.querySelector('[data-slot="source-list-skeleton"]')).toBeNull();
    await screen.findByTestId("terminal-inner");

    // A later refresh (the 15s poll, or the one after creating a session) keeps the rows
    routes["POST /api/terminal/sessions"] = { status: 200, body: { sessionId: "sess_session-3", name: "session-3", exists: false } };
    routes["GET /api/terminal/sessions"] = () => new Promise<Route>((resolve) => { release = resolve; });
    fireEvent.click(within(nav).getByRole("button", { name: "New session" }));
    await act(() => new Promise((r) => setTimeout(r, 300)));
    expect(nav.querySelector('[data-slot="source-list-skeleton"]')).toBeNull();
    expect(within(nav).getByText("session 2")).toBeInTheDocument();
    await act(async () => release({ status: 200, body: { sessions: [session("sess_default"), session("sess_session-2"), session("sess_session-3")] } }));
  });

  it("says when sessions can't be loaded, and Retry loads them", async () => {
    routes["GET /api/terminal/sessions"] = { status: 500, body: { error: "down" } };
    renderTerminal();
    const nav = await sidebar();
    expect(await within(nav).findByText("Couldn't load sessions.")).toBeInTheDocument();
    expect(within(nav).queryByRole("button", { name: /^Default/ })).toBeNull();

    routes["GET /api/terminal/sessions"] = { status: 200, body: { sessions: [session("sess_default"), session("sess_session-2")] } };
    fireEvent.click(within(nav).getByRole("button", { name: "Retry" }));
    expect(await within(nav).findByText("session 2")).toBeInTheDocument();
    expect(within(nav).queryByText("Couldn't load sessions.")).toBeNull();
  });

  it("keeps the rows and says Couldn't refresh when a later refresh fails", async () => {
    renderTerminal();
    const nav = await sidebar();
    await within(nav).findByText("session 2");
    await screen.findByTestId("terminal-inner");

    // The create succeeds; the refresh after it doesn't
    routes["POST /api/terminal/sessions"] = { status: 200, body: { sessionId: "sess_session-3", name: "session-3", exists: false } };
    routes["GET /api/terminal/sessions"] = { status: 500 };
    fireEvent.click(within(nav).getByRole("button", { name: "New session" }));
    expect(await within(nav).findByText("Couldn't refresh")).toBeInTheDocument();
    expect(within(nav).getByText("session 2")).toBeInTheDocument();
    // Not reported as a failed create
    expect(within(nav).queryByRole("alert")).toBeNull();
    expect(announce).toHaveBeenCalledWith("Opened session 3");

    routes["GET /api/terminal/sessions"] = { status: 200, body: { sessions: [session("sess_default"), session("sess_session-2"), session("sess_session-3")] } };
    fireEvent.click(within(nav).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(within(nav).queryByText("Couldn't refresh")).toBeNull());
  });

  it("creates a session from the sidebar, selects it and announces it", async () => {
    routes["GET /api/terminal/sessions"] = {
      status: 200,
      body: { sessions: [session("sess_default"), session("sess_session-1"), session("sess_session-2")] },
    };
    routes["POST /api/terminal/sessions"] = { status: 200, body: { sessionId: "sess_session-3", name: "session-3", exists: false } };
    renderTerminal();
    const nav = await sidebar();
    await within(nav).findByText("session 2");
    await screen.findByTestId("terminal-inner");

    fireEvent.click(within(nav).getByRole("button", { name: "New session" }));
    await waitFor(() => expect(announce).toHaveBeenCalledWith("Opened session 3"));
    // Ids, not display names, pick the next free name (regression: the names
    // "session 1"/"session 2" never matched "session-1", so it reopened session-1)
    const body = fetchMock.mock.calls
      .filter(([input, init]) => String(input).endsWith("/api/terminal/sessions") && init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(body).toEqual([{ name: "session-3" }]);
    expect(row(nav, /^session 3/)).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("terminal-inner")).toHaveAttribute("data-session", "sess_session-3");
  });

  it("a failed create shows an inline alert with Retry and keeps the terminal mounted", async () => {
    routes["POST /api/terminal/sessions"] = { status: 500, body: { error: "The terminal daemon is restarting." } };
    renderTerminal();
    const nav = await sidebar();
    await within(nav).findByText("session 2");
    await screen.findByTestId("terminal-inner");

    fireEvent.click(within(nav).getByRole("button", { name: "New session" }));
    const alert = await within(nav).findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't create a session");
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeInTheDocument();
    // The terminal keeps running; no connection-error screen
    expect(screen.getByTestId("terminal-inner")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't connect to the terminal")).toBeNull();
  });

  it("Delete and the row's end button open the destructive confirm; confirming ends the session", async () => {
    let deleted = false;
    routes["DELETE /api/terminal/sessions/sess_session-2"] = () => { deleted = true; return { status: 200, body: { ok: true } }; };
    renderTerminal();
    const nav = await sidebar();
    await within(nav).findByText("session 2");

    // Default can't be ended
    expect(within(nav).queryByRole("button", { name: "End Default" })).toBeNull();
    fireEvent.keyDown(row(nav, /^Default/), { key: "Delete" });
    expect(screen.queryByRole("alertdialog")).toBeNull();

    // Delete on the row
    fireEvent.keyDown(row(nav, /^session 2/), { key: "Delete" });
    let dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByRole("heading", { name: "End “session 2”?" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(deleted).toBe(false);

    // The row's end button, then confirm
    fireEvent.click(within(nav).getByRole("button", { name: "End session 2" }));
    dialog = await screen.findByRole("alertdialog");
    routes["GET /api/terminal/sessions"] = { status: 200, body: { sessions: [session("sess_default")] } };
    fireEvent.click(within(dialog).getByRole("button", { name: "End session" }));
    await waitFor(() => expect(deleted).toBe(true));
    await waitFor(() => expect(within(nav).queryByText("session 2")).toBeNull());
  });

  it("ending the selected session falls back to Default", async () => {
    routes["DELETE /api/terminal/sessions/sess_session-2"] = { status: 200, body: { ok: true } };
    renderTerminal();
    const nav = await sidebar();
    await within(nav).findByText("session 2");
    fireEvent.click(row(nav, /^session 2/));
    await waitFor(() => expect(screen.getByTestId("terminal-inner")).toHaveAttribute("data-session", "sess_session-2"));

    fireEvent.keyDown(row(nav, /^session 2/), { key: "Backspace" });
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "End session" }));
    await waitFor(() => expect(screen.getByTestId("terminal-inner")).toHaveAttribute("data-session", "sess_default"));
    expect(row(nav, /^Default/)).toHaveAttribute("aria-current", "page");
  });

  it("shows the server's reason when the terminal is locked, and Retry asks again", async () => {
    let tokenCalls = 0;
    routes["POST /api/terminal/session"] = () => {
      tokenCalls += 1;
      return tokenCalls === 1 ? { status: 423, body: { error: LOCKED } } : { status: 200, body: { token: "tok" } };
    };
    renderTerminal();
    // A 4xx is a decision, not a hiccup: shown at once, without three retries
    expect(await screen.findByText("Couldn't connect to the terminal")).toBeInTheDocument();
    expect(screen.getByText(LOCKED)).toBeInTheDocument();
    expect(tokenCalls).toBe(1);
    // No new sessions while the terminal is unavailable
    const nav = await sidebar();
    expect(within(nav).getByRole("button", { name: "New session" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByTestId("terminal-inner");
    expect(tokenCalls).toBe(2);
    expect(screen.queryByText("Couldn't connect to the terminal")).toBeNull();
  });
});

describe("Terminal in classic mode", () => {
  it("has no sidebar; the session picker has sentence-case sections", async () => {
    embedded.value = false;
    renderTerminal();
    await screen.findByTestId("terminal-inner");
    expect(screen.queryByRole("navigation", { name: "Terminal" })).toBeNull();

    const picker = screen.getByRole("button", { name: /^Default/ });
    await waitFor(() => expect(calls.some((c) => c.path === "/api/terminal/sessions")).toBe(true));
    fireEvent.click(picker);
    const sessions = await screen.findByText("Sessions");
    expect(sessions.className).not.toMatch(/uppercase/);
    expect(screen.getByText("System").className).not.toMatch(/uppercase/);
    expect(screen.getByRole("button", { name: "End session 2" })).toBeInTheDocument();
  });

  it("offers the same End actions as the window's sidebar", async () => {
    // In a window: the sidebar's End buttons
    const windowed = renderTerminal();
    const nav = await sidebar();
    await within(nav).findByText("session 2");
    const windowEnds = within(nav)
      .getAllByRole("button", { name: /^End / })
      .map((b) => b.getAttribute("aria-label"))
      .sort();
    windowed.unmount();

    // Classic: the session picker's End buttons
    embedded.value = false;
    renderTerminal();
    await screen.findByTestId("terminal-inner");
    fireEvent.click(screen.getByRole("button", { name: /^Default/ }));
    await screen.findByText("System");
    const classicEnds = screen
      .getAllByRole("button", { name: /^End / })
      .map((b) => b.getAttribute("aria-label"))
      .sort();

    expect(windowEnds).toHaveLength(2);
    expect(windowEnds).toContain("End session 2");
    expect(windowEnds.some((label) => label?.startsWith("End Evolution"))).toBe(true);
    expect(classicEnds).toEqual(windowEnds);
    // Default can't be ended from either
    expect(classicEnds).not.toContain("End Default");
  });

  it("names the agent in the session commands, apart from the shell's New session", () => {
    const launch = vi.fn();
    const testStore = createStore();
    testStore.set(launchTerminalAgentAtom, () => launch);
    const wrapper = ({ children }: { children: ReactNode }) => <Provider store={testStore}>{children}</Provider>;
    const { result } = renderHook(() => useTerminalHeaderAction(), { wrapper });
    expect(result.current.commandItems.map((item) => item.label)).toEqual([
      "Continue Claude Code",
      "New Claude Code session",
    ]);
  });
});
