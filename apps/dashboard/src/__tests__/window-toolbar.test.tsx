/**
 * The unified toolbar a Talome page draws at the top of its desktop window
 * (components/desktop/window-toolbar.tsx), the capsule its verbs share
 * (toolbar-group.tsx) and the messages it trades with the window
 * (atoms/desktop-window-chrome.ts).
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const embedded = vi.hoisted(() => ({ value: true }));
vi.mock("@/hooks/use-desktop-mode", () => ({ useIsEmbeddedFrame: () => embedded.value }));

import { desktopAppActionsAtom, desktopShellActionsAtom } from "@/atoms/desktop-app-actions";
import {
  DESKTOP_WINDOW_CHROME_MESSAGE,
  DESKTOP_WINDOW_CHROME_REQUEST_MESSAGE,
  DESKTOP_WINDOW_STATE_MESSAGE,
  isDesktopWindowChromeRequestMessage,
  isDesktopWindowZoomMessage,
  parseDesktopWindowChromeMessage,
  parseDesktopWindowDragMessage,
  parseDesktopWindowStateMessage,
} from "@/atoms/desktop-window-chrome";
import { pageBackAtom } from "@/atoms/page-back";
import { pageTitleAtom } from "@/atoms/page-title";
import { DesktopAppToolbar } from "@/components/desktop/desktop-app-toolbar";
import { ToolbarGroup, ToolbarGroupButton } from "@/components/desktop/toolbar-group";
import { findWindowDragRegion } from "@/components/desktop/window-drag";
import { WindowToolbar } from "@/components/desktop/window-toolbar";
import { FolderAddIcon } from "@/components/icons";

let posted: unknown[];
beforeEach(() => {
  embedded.value = true;
  posted = [];
  vi.spyOn(window, "postMessage").mockImplementation((message: unknown) => {
    posted.push(message);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** A message from the desktop window around the frame (in jsdom, the parent is the window itself). */
function fromWindow(data: unknown) {
  const event = new MessageEvent("message", { data, origin: window.location.origin });
  Object.defineProperty(event, "source", { value: window.parent });
  act(() => {
    window.dispatchEvent(event);
  });
}

function renderToolbar(store = createStore(), app?: React.ReactNode) {
  const view = render(
    <Provider store={store}>
      <div className="tm-window-content">
        <WindowToolbar />
        <div data-testid="scroller">{app}</div>
      </div>
    </Provider>,
  );
  return { ...view, store, row: document.querySelector<HTMLElement>("[data-window-toolbar]")! };
}

describe("WindowToolbar", () => {
  it("tells the window it draws the unified toolbar, on mount, on request and when it goes", () => {
    const view = renderToolbar();
    expect(posted).toContainEqual({ type: DESKTOP_WINDOW_CHROME_MESSAGE, unified: true });
    posted = [];
    fromWindow({ type: DESKTOP_WINDOW_CHROME_REQUEST_MESSAGE });
    expect(posted).toEqual([{ type: DESKTOP_WINDOW_CHROME_MESSAGE, unified: true }]);
    view.unmount();
    expect(posted).toContainEqual({ type: DESKTOP_WINDOW_CHROME_MESSAGE, unified: false });
  });

  it("titles the window with the page's place, else the app's name, quiet while the window is inactive", () => {
    const { store, row } = renderToolbar();
    fromWindow({ type: DESKTOP_WINDOW_STATE_MESSAGE, active: true, title: "Files" });
    const title = within(row).getByText("Files");
    expect(title).toHaveClass("text-sm", "font-medium", "truncate");
    expect(title).not.toHaveClass("text-muted-foreground");
    expect(title.className).not.toMatch(/\bopacity-/);

    act(() => store.set(pageTitleAtom, "Photos"));
    expect(within(row).getByText("Photos")).toBeInTheDocument();
    expect(within(row).queryByText("Files")).toBeNull();

    fromWindow({ type: DESKTOP_WINDOW_STATE_MESSAGE, active: false, title: "Files" });
    expect(within(row).getByText("Photos")).toHaveClass("text-muted-foreground");
    // Only the window's own messages count
    const event = new MessageEvent("message", {
      data: { type: DESKTOP_WINDOW_STATE_MESSAGE, active: true, title: "Spoofed" },
      origin: "http://evil.example",
    });
    Object.defineProperty(event, "source", { value: window.parent });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(within(row).getByText("Photos")).toHaveClass("text-muted-foreground");
  });

  it("puts Back in a capsule before the title, and a page's verbs at the trailing end", () => {
    const store = createStore();
    const back = vi.fn();
    const routeBack = vi.fn();
    const ask = vi.fn();
    store.set(pageBackAtom, () => back);
    store.set(desktopShellActionsAtom, [{ id: "shell-route-back", label: "Back to apps", icon: "back", placement: "leading", onSelect: routeBack }]);
    store.set(desktopAppActionsAtom, [{ id: "native-app-assistant", label: "Ask about Grocy", onSelect: ask }]);
    const { row } = renderToolbar(store);
    fromWindow({ type: DESKTOP_WINDOW_STATE_MESSAGE, active: true, title: "Grocy" });

    const navigation = within(row).getByRole("group", { name: "Grocy navigation" });
    expect(navigation).toHaveAttribute("data-slot", "toolbar-group");
    fireEvent.click(within(navigation).getByRole("button", { name: "Back" }));
    fireEvent.click(within(navigation).getByRole("button", { name: "Back to apps" }));
    const actions = within(row).getByRole("group", { name: "Grocy actions" });
    fireEvent.click(within(actions).getByRole("button", { name: "Ask about Grocy" }));
    expect(back).toHaveBeenCalledOnce();
    expect(routeBack).toHaveBeenCalledOnce();
    expect(ask).toHaveBeenCalledOnce();

    // Left to right: Back, the title, the page's verbs
    const title = within(row).getByText("Grocy");
    expect(navigation.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(title.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // None of them is in the old title bar's touch rules (those grow 2px-apart buttons)
    expect(row.querySelector("[data-window-actions]")).toBeNull();
  });

  it("has no Back capsule and no action group where the page has neither", () => {
    const { row } = renderToolbar();
    expect(within(row).queryByRole("group")).toBeNull();
    expect(within(row).queryByRole("button")).toBeNull();
  });

  it("runs a page's menu from the toolbar", async () => {
    const store = createStore();
    const refresh = vi.fn();
    store.set(desktopAppActionsAtom, [{
      id: "sessions",
      label: "default",
      kind: "menu",
      placement: "leading",
      items: [
        { id: "session-default", label: "default", active: true, onSelect: vi.fn() },
        { id: "session-refresh", label: "Refresh sessions", onSelect: refresh },
      ],
    }]);
    const { row } = renderToolbar(store);
    fireEvent.pointerDown(within(row).getByRole("button", { name: "default" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Refresh sessions" }));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("holds the app's own toolbar between the title and the trailing verbs, and drags only from empty space", () => {
    const store = createStore();
    store.set(desktopAppActionsAtom, [{ id: "native-app-assistant", label: "Ask about Grocy", onSelect: vi.fn() }]);
    const { row } = renderToolbar(
      store,
      <DesktopAppToolbar className="flex items-center gap-2 pb-4">
        <span>12 items</span>
        <input aria-label="Search" />
      </DesktopAppToolbar>,
    );
    fromWindow({ type: DESKTOP_WINDOW_STATE_MESSAGE, active: true, title: "Grocy" });

    const appToolbar = row.querySelector<HTMLElement>("[data-desktop-app-toolbar]")!;
    expect(appToolbar).toHaveClass("tm-window-toolbar", "flex");
    expect(screen.getByTestId("scroller")).not.toContainElement(appToolbar);
    const title = within(row).getByText("Grocy");
    const actions = within(row).getByRole("group", { name: "Grocy actions" });
    expect(title.compareDocumentPosition(appToolbar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(appToolbar.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    expect(row).toHaveClass("tm-window-unified-toolbar");
    expect(findWindowDragRegion(title)).toBe(row);
    expect(findWindowDragRegion(within(row).getByText("12 items"))).toBe(row);
    expect(findWindowDragRegion(within(row).getByRole("textbox", { name: "Search" }))).toBeNull();
    expect(findWindowDragRegion(within(actions).getByRole("button"))).toBeNull();
  });
});

describe("ToolbarGroup", () => {
  it("is a named capsule of 32px icon buttons, 44px on touch, that work as menu triggers", () => {
    const ref = vi.fn();
    const onClick = vi.fn();
    render(
      <ToolbarGroup aria-label="Folder actions">
        <ToolbarGroupButton ref={ref} icon={FolderAddIcon} label="New folder" onClick={onClick} />
        <ToolbarGroupButton icon={FolderAddIcon} label="Select" active />
      </ToolbarGroup>,
    );
    const group = screen.getByRole("group", { name: "Folder actions" });
    // A rounded-full capsule: a foreground fill and a hairline, in both themes (tokens only)
    expect(group).toHaveClass("rounded-full", "bg-foreground/5", "outline-1", "-outline-offset-1", "outline-border");
    expect(group.className).not.toMatch(/\bbg-(background|card|black|white)\b|#|rgba/);

    const button = within(group).getByRole("button", { name: "New folder" });
    expect(button).toHaveAttribute("title", "New folder");
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveClass("h-8", "min-w-8", "rounded-full", "pointer-coarse:h-11", "pointer-coarse:min-w-11");
    expect(button).toHaveClass("focus-visible:ring-2", "focus-visible:ring-inset");
    expect(button.textContent).toBe("");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
    expect(ref).toHaveBeenCalledWith(button);
    // A verb that's on shows it, without becoming a toggle
    const on = within(group).getByRole("button", { name: "Select" });
    expect(on).toHaveAttribute("data-active", "true");
    expect(on).not.toHaveAttribute("aria-pressed");
  });
});

describe("window chrome messages", () => {
  it("accept only well-formed messages", () => {
    expect(parseDesktopWindowStateMessage({ type: DESKTOP_WINDOW_STATE_MESSAGE, active: true, title: "Files" }))
      .toEqual({ active: true, title: "Files" });
    expect(parseDesktopWindowStateMessage({ type: DESKTOP_WINDOW_STATE_MESSAGE, active: "yes", title: "Files" })).toBeNull();
    expect(parseDesktopWindowStateMessage({ type: DESKTOP_WINDOW_STATE_MESSAGE, active: true, title: "x".repeat(129) })).toBeNull();

    expect(parseDesktopWindowChromeMessage({ type: DESKTOP_WINDOW_CHROME_MESSAGE, unified: false })).toEqual({ unified: false });
    expect(parseDesktopWindowChromeMessage({ type: DESKTOP_WINDOW_CHROME_MESSAGE })).toBeNull();
    expect(isDesktopWindowChromeRequestMessage({ type: DESKTOP_WINDOW_CHROME_REQUEST_MESSAGE })).toBe(true);
    expect(isDesktopWindowChromeRequestMessage("talome:desktop-window-chrome-request")).toBe(false);
    expect(isDesktopWindowZoomMessage({ type: "talome:desktop-window-zoom" })).toBe(true);
    expect(isDesktopWindowZoomMessage(null)).toBe(false);

    const drag = { type: "talome:desktop-window-drag", phase: "move", pointerId: 3, x: 10.5, y: -4, space: "parent" };
    expect(parseDesktopWindowDragMessage(drag)).toEqual(drag);
    for (const bad of [
      { ...drag, phase: "fling" },
      { ...drag, pointerId: 1.5 },
      { ...drag, x: Number.POSITIVE_INFINITY },
      { ...drag, y: 1e9 },
      { ...drag, x: "10" },
      { ...drag, space: "screen" },
      { ...drag, type: "talome:desktop-app-focus" },
    ]) {
      expect(parseDesktopWindowDragMessage(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});
