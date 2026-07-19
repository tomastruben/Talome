"use client";

import { useEffect, useRef } from "react";
import { useAtomValue } from "jotai";
import {
  desktopAppActionsAtom,
  parseDesktopAppActionTriggerMessage,
  type DesktopAppAction,
  type DesktopAppActionDescriptor,
} from "@/atoms/desktop-app-actions";

function publishActions(actions: DesktopAppActionDescriptor[]) {
  window.parent.postMessage(
    { type: "talome:desktop-app-actions", actions },
    window.location.origin,
  );
}

export function DesktopAppActionBridge() {
  const actions = useAtomValue(desktopAppActionsAtom);
  const actionsRef = useRef<DesktopAppAction[]>([]);

  useEffect(() => {
    actionsRef.current = actions;
    publishActions(actions.map((action) => ({
      id: action.id,
      label: action.label,
      icon: action.icon,
      active: action.active,
      disabled: action.disabled,
    })));
  }, [actions]);

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
      publishActions([]);
    };
  }, []);

  return null;
}
