"use client";

import { useEffect, useRef } from "react";
import { useAtomValue } from "jotai";
import {
  desktopAppActionsAtom,
  parseDesktopAppActionTriggerMessage,
  type DesktopAppAction,
  type DesktopAppActionDescriptor,
} from "@/atoms/desktop-app-actions";
import { pageBackAtom } from "@/atoms/page-back";
import { pageTitleAtom } from "@/atoms/page-title";

const BACK_ACTION_ID = "talome-page-back";

function publishActions(title: string | undefined, actions: DesktopAppActionDescriptor[]) {
  window.parent.postMessage(
    { type: "talome:desktop-app-actions", title, actions },
    window.location.origin,
  );
}

export function DesktopAppActionBridge() {
  const actions = useAtomValue(desktopAppActionsAtom);
  const pageBack = useAtomValue(pageBackAtom);
  const pageTitle = useAtomValue(pageTitleAtom);
  const actionsRef = useRef<DesktopAppAction[]>([]);

  useEffect(() => {
    const bridgeActions: DesktopAppAction[] = pageBack
      ? [{
        id: BACK_ACTION_ID,
        label: "Back",
        icon: "back",
        placement: "leading",
        onSelect: pageBack,
      }, ...actions]
      : actions;
    actionsRef.current = bridgeActions;
    publishActions(pageTitle ?? undefined, bridgeActions.map((action) => ({
      id: action.id,
      label: action.label,
      icon: action.icon,
      kind: action.kind,
      placement: action.placement,
      active: action.active,
      disabled: action.disabled,
    })));
  }, [actions, pageBack, pageTitle]);

  useEffect(() => {
    const handlePointerDown = () => {
      window.parent.postMessage(
        { type: "talome:desktop-app-focus" },
        window.location.origin,
      );
    };
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== window.parent) {
        return;
      }
      const message = parseDesktopAppActionTriggerMessage(event.data);
      if (!message) return;
      actionsRef.current.find((action) => action.id === message.actionId)?.onSelect();
    };

    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("message", handleMessage);
      publishActions(undefined, []);
    };
  }, []);

  return null;
}
