import { render, waitFor } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_APP_ACTIONS_REQUEST_MESSAGE,
  desktopAppActionsAtom,
} from "@/atoms/desktop-app-actions";
import { DesktopAppActionBridge } from "@/components/desktop/desktop-app-action-bridge";
import { pageTitleAtom } from "@/atoms/page-title";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DesktopAppActionBridge", () => {
  it("republishes the current title actions when the desktop requests them", async () => {
    const store = createStore();
    store.set(pageTitleAtom, "Assistant");
    store.set(desktopAppActionsAtom, [{
      id: "auto-mode",
      label: "Auto",
      kind: "toggle",
      active: true,
      onSelect: vi.fn(),
    }]);
    const postMessage = vi.spyOn(window, "postMessage");

    render(
      <Provider store={store}>
        <DesktopAppActionBridge />
      </Provider>,
    );
    await waitFor(() => expect(postMessage).toHaveBeenCalled());
    postMessage.mockClear();

    const request = new MessageEvent("message", {
      data: { type: DESKTOP_APP_ACTIONS_REQUEST_MESSAGE },
      origin: window.location.origin,
    });
    Object.defineProperty(request, "source", { value: window });
    window.dispatchEvent(request);

    await waitFor(() => expect(postMessage).toHaveBeenCalledWith({
      type: "talome:desktop-app-actions",
      title: "Assistant",
      actions: [{
        id: "auto-mode",
        label: "Auto",
        icon: undefined,
        kind: "toggle",
        placement: undefined,
        active: true,
        disabled: undefined,
        items: undefined,
      }],
    }, window.location.origin));
  });
});
