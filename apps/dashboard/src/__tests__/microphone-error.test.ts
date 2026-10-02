import { afterEach, describe, expect, it, vi } from "vitest";
import { microphoneErrorMessage } from "@/lib/microphone-error";

const err = (name: string) => new DOMException("x", name);

function mockPermission(state: PermissionState | "throw" | "missing") {
  if (state === "missing") {
    vi.stubGlobal("navigator", { ...navigator, permissions: undefined });
    return;
  }
  vi.stubGlobal("navigator", {
    ...navigator,
    permissions: {
      query: vi.fn(async () => {
        if (state === "throw") throw new TypeError("unsupported");
        return { state };
      }),
    },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("microphone error messages", () => {
  it("says there is no microphone when none is connected (no prompt is ever shown)", async () => {
    expect(await microphoneErrorMessage(err("NotFoundError"))).toMatch(/No microphone found/);
    expect(await microphoneErrorMessage(err("OverconstrainedError"))).toMatch(/No microphone found/);
  });

  it("says the microphone is busy when another app holds it", async () => {
    expect(await microphoneErrorMessage(err("NotReadableError"))).toMatch(/busy or unavailable/);
  });

  it("says the site is blocked when the person blocked it", async () => {
    mockPermission("denied");
    expect(await microphoneErrorMessage(err("NotAllowedError"))).toMatch(/blocked for this site/);
  });

  it("points at system privacy settings when it was blocked without asking", async () => {
    mockPermission("prompt");
    expect(await microphoneErrorMessage(err("NotAllowedError"))).toMatch(/without asking/);
    mockPermission("throw");
    expect(await microphoneErrorMessage(err("NotAllowedError"))).toMatch(/without asking/);
    mockPermission("missing");
    expect(await microphoneErrorMessage(err("SecurityError"))).toMatch(/without asking/);
  });

  it("never claims access was denied for an unknown failure", async () => {
    const message = await microphoneErrorMessage(new Error("weird"));
    expect(message).not.toMatch(/denied/i);
    expect(message).toMatch(/Couldn't start the microphone/);
  });
});
