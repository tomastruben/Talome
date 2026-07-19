import { describe, expect, it } from "vitest";
import {
  parseDesktopAppActionsMessage,
  parseDesktopAppActionTriggerMessage,
  parseDesktopAppFocusMessage,
} from "@/atoms/desktop-app-actions";

describe("desktop app action messages", () => {
  it("accepts a valid app action list", () => {
    expect(parseDesktopAppActionsMessage({
      type: "talome:desktop-app-actions",
      title: "Media Vault",
      actions: [
        { id: "cinema", label: "Cinema", icon: "projector" },
        { id: "select", label: "Cancel", active: true },
        { id: "auto", label: "Auto", kind: "toggle", placement: "trailing" },
        { id: "back", label: "Back", icon: "back", placement: "leading" },
      ],
    })).toEqual({
      type: "talome:desktop-app-actions",
      title: "Media Vault",
      actions: [
        { id: "cinema", label: "Cinema", icon: "projector" },
        { id: "select", label: "Cancel", active: true },
        { id: "auto", label: "Auto", kind: "toggle", placement: "trailing" },
        { id: "back", label: "Back", icon: "back", placement: "leading" },
      ],
    });
  });

  it("rejects malformed or unsupported app actions", () => {
    expect(parseDesktopAppActionsMessage({
      type: "talome:desktop-app-actions",
      actions: [{ id: "cinema", label: "Cinema", icon: "unknown" }],
    })).toBeNull();
    expect(parseDesktopAppActionsMessage({
      type: "talome:desktop-app-actions",
      actions: [{ id: "", label: "Cinema" }],
    })).toBeNull();
    expect(parseDesktopAppActionsMessage({
      type: "talome:desktop-app-actions",
      actions: [{ id: "auto", label: "Auto", kind: "slider" }],
    })).toBeNull();
    expect(parseDesktopAppActionsMessage({
      type: "talome:desktop-app-actions",
      title: "",
      actions: [],
    })).toBeNull();
  });

  it("accepts only valid action trigger messages", () => {
    expect(parseDesktopAppActionTriggerMessage({
      type: "talome:desktop-app-action-trigger",
      actionId: "select",
    })).toEqual({
      type: "talome:desktop-app-action-trigger",
      actionId: "select",
    });
    expect(parseDesktopAppActionTriggerMessage({
      type: "talome:desktop-app-action-trigger",
      actionId: "",
    })).toBeNull();
  });

  it("accepts only desktop app focus messages", () => {
    expect(parseDesktopAppFocusMessage({
      type: "talome:desktop-app-focus",
    })).toEqual({ type: "talome:desktop-app-focus" });
    expect(parseDesktopAppFocusMessage({ type: "other" })).toBeNull();
  });
});
