"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useAtomValue } from "jotai";
import {
  desktopAppActionsAtom,
  desktopShellActionsAtom,
  parseDesktopAppActionTriggerMessage,
  parseDesktopAppActionsRequestMessage,
  type DesktopAppAction,
  type DesktopAppChromeDescriptor,
  type DesktopAppActionDescriptor,
} from "@/atoms/desktop-app-actions";
import { pageBackAtom } from "@/atoms/page-back";
import { pageTitleAtom } from "@/atoms/page-title";
import { DESKTOP_ROUTE_STATE_MESSAGE, requestDesktopNavigation, shouldHandleDesktopLink } from "@/lib/desktop-navigation";

const BACK_ACTION_ID = "talome-page-back";

function publishActions(title: string | undefined, actions: DesktopAppActionDescriptor[]) {
  window.parent.postMessage(
    { type: "talome:desktop-app-actions", title, actions },
    window.location.origin,
  );
}

export function DesktopAppActionBridge() {
  const pathname = usePathname();
  const search = useSearchParams().toString();

  useEffect(() => {
    const publishRoute = () => window.parent.postMessage(
      { type: DESKTOP_ROUTE_STATE_MESSAGE, url: `${window.location.pathname}${window.location.search}${window.location.hash}` },
      window.location.origin,
    );
    publishRoute();
    window.addEventListener("hashchange", publishRoute);
    return () => window.removeEventListener("hashchange", publishRoute);
  }, [pathname, search]);

  const actions = useAtomValue(desktopAppActionsAtom);
  const shellActions = useAtomValue(desktopShellActionsAtom);
  const pageBack = useAtomValue(pageBackAtom);
  const pageTitle = useAtomValue(pageTitleAtom);
  const actionsRef = useRef<DesktopAppAction[]>([]);
  const chromeRef = useRef<DesktopAppChromeDescriptor>({ actions: [] });

  useEffect(() => {
    const appActions = [...shellActions, ...actions];
    const bridgeActions: DesktopAppAction[] = pageBack
      ? [{
        id: BACK_ACTION_ID,
        label: "Back",
        icon: "back",
        placement: "leading",
        onSelect: pageBack,
      }, ...appActions]
      : appActions;
    actionsRef.current = bridgeActions;
    const chrome = {
      title: pageTitle ?? undefined,
      actions: bridgeActions.map((action) => ({
        id: action.id,
        label: action.label,
        icon: action.icon,
        kind: action.kind,
        placement: action.placement,
        active: action.active,
        disabled: action.disabled,
        items: action.items?.map((item) => ({
          id: item.id,
          label: item.label,
          active: item.active,
          disabled: item.disabled,
        })),
      })),
    };
    chromeRef.current = chrome;
    publishActions(chrome.title, chrome.actions);
  }, [actions, pageBack, pageTitle, shellActions]);

  useEffect(() => {
    const handlePointerDown = () => {
      window.parent.postMessage(
        { type: "talome:desktop-app-focus" },
        window.location.origin,
      );
    };
    const handleDashboardLink = (event: MouseEvent) => {
      const target = event.target;
      const anchor = target instanceof Element
        ? target.closest<HTMLAnchorElement>("a[href]")
        : null;
      if (!anchor || !shouldHandleDesktopLink(event, anchor)) return;
      if (requestDesktopNavigation(anchor.href)) event.preventDefault();
    };
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== window.parent) {
        return;
      }
      if (parseDesktopAppActionsRequestMessage(event.data)) {
        publishActions(chromeRef.current.title, chromeRef.current.actions);
        return;
      }
      const message = parseDesktopAppActionTriggerMessage(event.data);
      if (!message) return;
      for (const action of actionsRef.current) {
        if (action.id === message.actionId) {
          action.onSelect?.();
          return;
        }
        const menuItem = action.items?.find((item) => item.id === message.actionId);
        if (menuItem) {
          menuItem.onSelect();
          return;
        }
      }
    };

    window.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("click", handleDashboardLink, true);
    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("click", handleDashboardLink, true);
      window.removeEventListener("message", handleMessage);
      publishActions(undefined, []);
    };
  }, []);

  return null;
}
