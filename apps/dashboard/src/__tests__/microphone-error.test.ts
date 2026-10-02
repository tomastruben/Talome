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

  it("does not claim a system denial when permission cannot be determined", async () => {
    mockPermission("prompt");
    expect(await microphoneErrorMessage(err("NotAllowedError"))).toMatch(/couldn't access the microphone/);
    mockPermission("throw");
    expect(await microphoneErrorMessage(err("NotAllowedError"))).toMatch(/couldn't access the microphone/);
    mockPermission("missing");
    expect(await microphoneErrorMessage(err("SecurityError"))).toMatch(/couldn't access the microphone/);
  });

  it("explains capture failure without claiming permission is missing when it is granted", async () => {
    mockPermission("granted");
    const message = await microphoneErrorMessage(err("NotAllowedError"));
    expect(message).toMatch(/permission is granted/);
    expect(message).toMatch(/in-app browser/);
    expect(message).not.toMatch(/blocked for this site/);
  });

  it("identifies a document policy block before interpreting denied permission", async () => {
    mockPermission("denied");
    vi.stubGlobal("document", { permissionsPolicy: { allowsFeature: () => false } });
    expect(await microphoneErrorMessage(err("NotAllowedError"))).toMatch(/page's permissions policy/);
  });

  it("explains an insecure origin or missing capture API", async () => {
    vi.stubGlobal("isSecureContext", false);
    expect(await microphoneErrorMessage(new TypeError("missing API"))).toMatch(/HTTPS or on localhost/);
    vi.stubGlobal("isSecureContext", true);
    mockPermission("missing");
    expect(await microphoneErrorMessage(new TypeError("missing API"))).toMatch(/doesn't support microphone capture/);
  });

  it("never claims access was denied for an unknown failure", async () => {
    const message = await microphoneErrorMessage(new Error("weird"));
    expect(message).not.toMatch(/denied/i);
    expect(message).toMatch(/Couldn't start the microphone/);
  });
});

describe("desktop windows allow the microphone", () => {
  it("lists microphone in the window frame's permissions, so voice works in a window", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(__dirname, "..", "components/desktop/desktop-experience.tsx"), "utf8");
    expect(source).toMatch(/allow="[^"]*\bmicrophone\b[^"]*"/);
  });
});
