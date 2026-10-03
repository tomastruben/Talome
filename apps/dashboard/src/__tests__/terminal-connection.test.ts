import { afterEach, describe, expect, it, vi } from "vitest";
import { getTerminalDaemonHttpUrl, getTerminalDaemonWsUrl } from "@/lib/constants";
import { proxy } from "@/proxy";
import { NextRequest } from "next/server";

afterEach(() => vi.unstubAllGlobals());

describe("secure terminal connections", () => {
  it("uses the HTTPS page's host and port for WebSocket and HTTP traffic", () => {
    vi.stubGlobal("window", { location: new URL("https://mini.tailnet.ts.net:8443/dashboard/terminal") });
    expect(getTerminalDaemonWsUrl() + "/ws").toBe("wss://mini.tailnet.ts.net:8443/api/terminal/ws");
    expect(getTerminalDaemonHttpUrl() + "/session").toBe("https://mini.tailnet.ts.net:8443/api/terminal/session");
  });

  it("keeps direct daemon access over local HTTP", () => {
    vi.stubGlobal("window", { location: new URL("http://localhost:3000/dashboard/terminal") });
    expect(getTerminalDaemonWsUrl()).toBe("ws://localhost:4001");
    expect(getTerminalDaemonHttpUrl()).toBe("http://localhost:4001");
  });

  it("proxies only the exact socket endpoint directly to the daemon", () => {
    const request = new NextRequest("https://mini.tailnet.ts.net:8443/api/terminal/ws");
    expect(proxy(request).headers.get("x-middleware-rewrite")).toBe("http://127.0.0.1:4001/ws");
    for (const path of ["session", "sessions", "upload", "ws/other"]) {
      const response = proxy(new NextRequest(`https://mini.tailnet.ts.net:8443/api/terminal/${path}`));
      expect(response.headers.get("x-middleware-rewrite")).toBe(`http://127.0.0.1:4000/api/terminal/${path}`);
    }
  });
});
