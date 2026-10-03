"use client";

import { Fragment, useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import {
  HugeiconsIcon,
  ArrowDown01Icon,
  ArrowLeft01Icon,
  Tick01Icon,
} from "@/components/icons";
import {
  desktopAppActionsAtom,
  desktopShellActionsAtom,
  type DesktopAppAction,
} from "@/atoms/desktop-app-actions";
import {
  DESKTOP_WINDOW_CHROME_MESSAGE,
  isDesktopWindowChromeRequestMessage,
  parseDesktopWindowStateMessage,
  type DesktopWindowState,
} from "@/atoms/desktop-window-chrome";
import { pageBackAtom } from "@/atoms/page-back";
import { pageTitleAtom } from "@/atoms/page-title";
import { desktopActionIcons } from "@/components/desktop/desktop-action-icons";
import { ToolbarGroup, ToolbarGroupButton } from "@/components/desktop/toolbar-group";
import { WindowToolbarSlot } from "@/components/desktop/window-content";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

function announceUnifiedChrome(unified: boolean) {
  window.parent.postMessage({ type: DESKTOP_WINDOW_CHROME_MESSAGE, unified }, window.location.origin);
}

/**
 * What the desktop window around this frame says about itself (active or
 * not, and the app's name), and this frame's answer: it draws the unified
 * toolbar, so the window draws no title bar of its own.
 */
export function useDesktopWindowState(): DesktopWindowState | null {
  const [state, setState] = useState<DesktopWindowState | null>(null);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== window.parent) return;
      const next = parseDesktopWindowStateMessage(event.data);
      if (next) {
        setState(next);
        return;
      }
      if (isDesktopWindowChromeRequestMessage(event.data)) announceUnifiedChrome(true);
    };
    window.addEventListener("message", handleMessage);
    announceUnifiedChrome(true);
    return () => {
      window.removeEventListener("message", handleMessage);
      announceUnifiedChrome(false);
    };
  }, []);

  return state;
}

/** A quiet text verb for the toolbar's trailing end (a page's published action). */
const TRAILING_ACTION_CLASS =
  "flex h-8 min-w-0 max-w-44 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm text-muted-foreground outline-none transition-colors duration-150 ease-out hover:bg-foreground/8 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 pointer-coarse:h-11 data-[state=open]:bg-foreground/10 data-[state=open]:text-foreground";
/** A labelled verb inside the leading capsule */
const CAPSULE_TEXT_CLASS =
  "flex h-8 min-w-0 max-w-44 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm text-muted-foreground outline-none transition-colors duration-150 ease-out hover:bg-foreground/8 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 pointer-coarse:h-11 data-[state=open]:bg-foreground/10 data-[state=open]:text-foreground";

function ActionMenu({ action, align, triggerClassName }: { action: DesktopAppAction; align: "start" | "end"; triggerClassName: string }) {
  const icon = action.icon ? desktopActionIcons[action.icon] : undefined;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={action.disabled}
          aria-label={action.label}
          className={cn(triggerClassName, action.active && "bg-muted text-foreground")}
        >
          {icon && <HugeiconsIcon icon={icon} size={15} aria-hidden="true" className="shrink-0" />}
          <span className="tm-cap-trim truncate">{action.label}</span>
          <HugeiconsIcon icon={ArrowDown01Icon} size={12} aria-hidden="true" className="shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="min-w-52">
        <DropdownMenuGroup>
          {action.items?.map((item) => (
            <Fragment key={item.id}>
              {item.separatorBefore && <DropdownMenuSeparator />}
              <DropdownMenuItem disabled={item.disabled} onSelect={() => item.onSelect()}>
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.active && <HugeiconsIcon icon={Tick01Icon} size={13} className="ml-auto" />}
              </DropdownMenuItem>
            </Fragment>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Back, and any other navigation a page publishes, in one capsule before the title. */
function LeadingAction({ action }: { action: DesktopAppAction }) {
  const icon = action.icon ? desktopActionIcons[action.icon] : undefined;
  if (action.kind === "menu") return <ActionMenu action={action} align="start" triggerClassName={CAPSULE_TEXT_CLASS} />;
  if (icon) {
    return (
      <ToolbarGroupButton
        icon={icon}
        label={action.label}
        active={action.active}
        disabled={action.disabled}
        aria-pressed={action.kind === "toggle" ? action.active === true : undefined}
        onClick={() => action.onSelect?.()}
      />
    );
  }
  return (
    <button
      type="button"
      disabled={action.disabled}
      aria-pressed={action.kind === "toggle" ? action.active === true : undefined}
      className={cn(CAPSULE_TEXT_CLASS, action.active && "bg-foreground/10 text-foreground")}
      onClick={() => action.onSelect?.()}
    >
      <span className="tm-cap-trim truncate">{action.label}</span>
    </button>
  );
}

/** A verb a page publishes for the window (an AppSpec native app's "Ask about…"), at the row's end. */
function TrailingAction({ action }: { action: DesktopAppAction }) {
  const icon = action.icon ? desktopActionIcons[action.icon] : undefined;
  if (action.kind === "menu") return <ActionMenu action={action} align="end" triggerClassName={TRAILING_ACTION_CLASS} />;
  return (
    <button
      type="button"
      disabled={action.disabled}
      aria-pressed={action.kind === "toggle" ? action.active === true : undefined}
      title={action.label}
      aria-label={action.label}
      data-window-action-icon={icon ? "" : undefined}
      className={cn(TRAILING_ACTION_CLASS, action.active && "bg-foreground/10 text-foreground")}
      onClick={() => action.onSelect?.()}
    >
      {icon && <HugeiconsIcon icon={icon} size={15} aria-hidden="true" className="shrink-0" />}
      <span className="tm-cap-trim truncate">{action.label}</span>
    </button>
  );
}

/**
 * The unified toolbar: the top row of a desktop window's content column, one
 * 52px band that is the window's title bar and its toolbar at once (there is
 * no separate title bar). Left to right: the Back capsule (only where the
 * page can go back), the title (the page's place, else the app's name; quiet
 * while the window is inactive), then the app's own controls, which its
 * <DesktopAppToolbar> portals into the slot and which end with the search
 * field, and last any verb a page publishes for the window.
 *
 * The window controls float over the row's leading inset (globals.css,
 * `--window-controls-inset`), or over the sidebar's top where a sidebar shows.
 * Empty space in the row drags the window and a double-click fills it
 * (window-drag.ts); controls in it never do.
 */
export function WindowToolbar() {
  const windowState = useDesktopWindowState();
  const pageTitle = useAtomValue(pageTitleAtom);
  const pageBack = useAtomValue(pageBackAtom);
  const shellActions = useAtomValue(desktopShellActionsAtom);
  const appActions = useAtomValue(desktopAppActionsAtom);

  const actions = [...shellActions, ...appActions];
  const leading = actions.filter((action) => action.placement === "leading");
  const trailing = actions.filter((action) => action.placement !== "leading");
  const title = pageTitle ?? windowState?.title ?? "";
  const appName = windowState?.title || title;
  const active = windowState?.active ?? true;

  return (
    <div
      data-window-toolbar=""
      data-window-drag-region="toolbar"
      className="tm-window-unified-toolbar"
    >
      <div className="tm-window-toolbar-heading">
      {(pageBack || leading.length > 0) && (
        <div className="tm-window-toolbar-item">
          <ToolbarGroup
            aria-label={appName ? `${appName} navigation` : "Navigation"}
            data-window-toolbar-actions="leading"
          >
            {pageBack && <ToolbarGroupButton icon={ArrowLeft01Icon} label="Back" onClick={() => pageBack()} />}
            {leading.map((action) => <LeadingAction key={action.id} action={action} />)}
          </ToolbarGroup>
        </div>
      )}
      <div data-window-title="" className="tm-window-toolbar-item tm-window-title">
        <span
          title={title}
          className={cn(
            "tm-cap-trim min-w-0 truncate text-sm font-medium leading-5 transition-colors duration-150 ease-out",
            !active && "text-muted-foreground",
          )}
        >
          {title}
        </span>
      </div>
      </div>
      <WindowToolbarSlot />
      {trailing.length > 0 && (
        <div
          role="group"
          aria-label={appName ? `${appName} actions` : "Actions"}
          data-window-toolbar-actions="trailing"
          className="tm-window-toolbar-item tm-window-toolbar-trailing ml-auto"
        >
          {trailing.map((action) => <TrailingAction key={action.id} action={action} />)}
        </div>
      )}
    </div>
  );
}
