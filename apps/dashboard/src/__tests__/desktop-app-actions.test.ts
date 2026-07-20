import { describe, expect, it } from "vitest";
import {
  parseDesktopAppActionsMessage,
  parseDesktopAppActionTriggerMessage,
  parseDesktopAppFocusMessage,
  parseDesktopPlayerOpenMessage,
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
        {
          id: "sessions",
          label: "default",
          icon: "source-code",
          kind: "menu",
          placement: "leading",
          items: [
            { id: "session-default", label: "default", active: true },
            { id: "session-refresh", label: "Refresh sessions", separatorBefore: true },
          ],
        },
      ],
    })).toEqual({
      type: "talome:desktop-app-actions",
      title: "Media Vault",
      actions: [
        { id: "cinema", label: "Cinema", icon: "projector" },
        { id: "select", label: "Cancel", active: true },
        { id: "auto", label: "Auto", kind: "toggle", placement: "trailing" },
        { id: "back", label: "Back", icon: "back", placement: "leading" },
        {
          id: "sessions",
          label: "default",
          icon: "source-code",
          kind: "menu",
          placement: "leading",
          items: [
            { id: "session-default", label: "default", active: true },
            { id: "session-refresh", label: "Refresh sessions", separatorBefore: true },
          ],
        },
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
      actions: [{ id: "sessions", label: "default", kind: "menu" }],
    })).toBeNull();
    expect(parseDesktopAppActionsMessage({
      type: "talome:desktop-app-actions",
      actions: [{ id: "sessions", label: "default", items: [{ id: "one", label: "One" }] }],
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

  it("accepts only complete desktop player requests", () => {
    expect(parseDesktopPlayerOpenMessage({
      type: "talome:desktop-player-open",
      title: "Send Help",
      filePath: "/Volumes/Media/Send Help.mkv",
      fileName: "Send Help.mkv",
      preferOriginal: true,
      preferDirect: false,
    })).toEqual({
      type: "talome:desktop-player-open",
      title: "Send Help",
      filePath: "/Volumes/Media/Send Help.mkv",
      fileName: "Send Help.mkv",
      preferOriginal: true,
      preferDirect: false,
    });
    expect(parseDesktopPlayerOpenMessage({
      type: "talome:desktop-player-open",
      title: "Send Help",
      filePath: "",
      fileName: "Send Help.mkv",
      preferOriginal: true,
      preferDirect: false,
    })).toBeNull();
    expect(parseDesktopPlayerOpenMessage({
      type: "talome:desktop-player-open",
      title: "Send Help",
      filePath: "/Volumes/Media/Send Help.mkv",
      fileName: "Send Help.mkv",
      preferOriginal: "yes",
      preferDirect: false,
    })).toBeNull();
  });
});
