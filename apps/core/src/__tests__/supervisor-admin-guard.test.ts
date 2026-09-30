import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// The events route reads the DB; these tests only exercise the role guard.
vi.mock("../db/index.js", () => ({ db: {}, schema: {} }));

import { supervisor } from "../routes/supervisor.js";

function appAs(role: "admin" | "member") {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sessionRole" as never, role as never);
    await next();
  });
  app.route("/api/supervisor", supervisor);
  return app;
}

describe("supervisor routes", () => {
  it("refuse members: they can't restart services or switch the server mode (regression)", async () => {
    const member = appAs("member");
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      for (const [method, path, body] of [
        ["POST", "/api/supervisor/restart", { service: "dashboard" }],
        ["POST", "/api/supervisor/mode", { mode: "dev" }],
        ["GET", "/api/supervisor/status", undefined],
      ] as const) {
        const res = await member.request(path, {
          method,
          headers: { "Content-Type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        });
        expect(res.status, `${method} ${path}`).toBe(403);
      }
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  it("let admins through", async () => {
    // No supervisor runs in tests: 404 "Supervisor not running", not 403.
    const res = await appAs("admin").request("/api/supervisor/status");
    expect(res.status).not.toBe(403);
  });
});
