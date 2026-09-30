/**
 * /api/terminal/* proxies to the terminal daemon with the daemon's internal
 * key, so it must never be reachable without a logged-in admin: anonymous
 * callers and members cannot mint PTY tokens, list sessions or spawn the
 * daemon, and no PTY token is minted while the security mode is "locked".
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

vi.hoisted(() => {
  const dir = (process.env.TMPDIR || "/tmp").replace(/\/$/, "");
  process.env.DATABASE_PATH = `${dir}/talome-security-terminal-${process.pid}-${Date.now()}.db`;
  process.env.TALOME_SECRET ||= "a".repeat(64);
});

const m = vi.hoisted(() => ({
  ensureDaemonRunning: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../terminal-spawn.js", () => ({ ensureDaemonRunning: m.ensureDaemonRunning }));

import { Hono } from "hono";
import { runMigrations } from "../db/migrate.js";
import { setSetting } from "../utils/settings.js";
import { requireSession, createSessionToken, SESSION_COOKIE } from "../middleware/session.js";
import { setupTerminal } from "../routes/terminal.js";

const realFetch = globalThis.fetch;
const daemonCalls: Array<{ url: string; headers: Headers }> = [];

function buildApp(): Hono {
  const app = new Hono();
  app.use("/api/*", requireSession);
  setupTerminal(app, null);
  return app;
}

async function cookieFor(role: "admin" | "member"): Promise<string> {
  const token = await createSessionToken(`user-${role}`, role, role);
  return `${SESSION_COOKIE}=${token}`;
}

beforeAll(() => {
  runMigrations();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("http://127.0.0.1:")) {
      daemonCalls.push({ url, headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ token: "eph_test", sessions: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return realFetch(input, init);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  daemonCalls.length = 0;
  m.ensureDaemonRunning.mockClear();
  setSetting("security_mode", "cautious");
});

describe("terminal proxy access", () => {
  it("anonymous callers cannot mint PTY tokens, list sessions or start the daemon", async () => {
    const app = buildApp();
    expect((await app.request("/api/terminal/session", { method: "POST" })).status).toBe(401);
    expect((await app.request("/api/terminal/sessions")).status).toBe(401);
    expect((await app.request("/api/terminal/ensure-daemon", { method: "POST" })).status).toBe(401);
    expect(daemonCalls).toHaveLength(0);
    expect(m.ensureDaemonRunning).not.toHaveBeenCalled();
  });

  it("members are refused", async () => {
    const app = buildApp();
    const cookie = await cookieFor("member");
    const res = await app.request("/api/terminal/session", { method: "POST", headers: { cookie } });
    expect(res.status).toBe(403);
    expect((await app.request("/api/terminal/ensure-daemon", { method: "POST", headers: { cookie } })).status).toBe(403);
    expect(daemonCalls).toHaveLength(0);
  });

  it("a logged-in admin gets a PTY token through the proxy", async () => {
    const app = buildApp();
    const res = await app.request("/api/terminal/session", { method: "POST", headers: { cookie: await cookieFor("admin") } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ token: "eph_test" });
    expect(daemonCalls).toHaveLength(1);
    expect(daemonCalls[0].url).toMatch(/\/session$/);
    expect(daemonCalls[0].headers.get("x-daemon-auth")).toBeTruthy();
  });

  it("no PTY token is minted in locked mode, even for an admin", async () => {
    setSetting("security_mode", "locked");
    const app = buildApp();
    const cookie = await cookieFor("admin");
    const res = await app.request("/api/terminal/session", { method: "POST", headers: { cookie } });
    expect(res.status).toBe(423);
    expect(daemonCalls).toHaveLength(0);
    // Listing sessions is still allowed (no shell is opened).
    expect((await app.request("/api/terminal/sessions", { headers: { cookie } })).status).toBe(200);
  });

  it("the daemon port lookup stays public", async () => {
    const res = await buildApp().request("/api/terminal-daemon-port");
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty("port");
  });
});
