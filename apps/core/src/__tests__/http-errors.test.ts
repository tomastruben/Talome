import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { appErrorHandler, csrfProtection } from "../middleware/http-errors.js";
import { errorTracker } from "../middleware/error-tracker.js";

const TRUSTED = "http://192.168.1.10:3000";

function buildApp() {
  const app = new Hono();
  app.use("*", csrfProtection((origin) => origin === TRUSTED));
  app.post("/api/apps/x/stop", (c) => c.json({ ok: true }));
  app.delete("/api/users/u1", (c) => c.json({ ok: true }));
  app.post("/api/webhooks/hook", (c) => c.json({ ok: true }));
  app.post("/api/teapot", () => {
    throw new HTTPException(418, { res: new Response("teapot", { status: 418 }) });
  });
  app.post("/api/boom", () => {
    throw new Error("kaboom");
  });
  app.onError(appErrorHandler);
  return app;
}

function trackedCount(): number {
  return errorTracker.getRecent(60_000).length;
}

describe("CSRF rejections (e2e bug 5)", () => {
  let app: Hono;
  let before: number;
  beforeEach(() => {
    app = buildApp();
    before = trackedCount();
  });

  it("answers a bodyless no-Origin POST with 403 JSON, not a logged 500", async () => {
    const res = await app.request("/api/apps/x/stop", { method: "POST" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Cross-site request rejected/);
    expect(trackedCount()).toBe(before);
  });

  it("answers a bodyless no-Origin DELETE with 403", async () => {
    const res = await app.request("/api/users/u1", { method: "DELETE" });
    expect(res.status).toBe(403);
    expect(trackedCount()).toBe(before);
  });

  it("rejects an untrusted Origin with a form content type", async () => {
    const res = await app.request("/api/apps/x/stop", {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" },
      body: "a=1",
    });
    expect(res.status).toBe(403);
  });

  it("lets JSON requests through without an Origin (non-browser clients)", async () => {
    const res = await app.request("/api/apps/x/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
  });

  it("lets bodyless requests through with a trusted Origin (what the dashboard's fetch() sends)", async () => {
    const res = await app.request("/api/users/u1", { method: "DELETE", headers: { origin: TRUSTED } });
    expect(res.status).toBe(200);
  });

  it("lets bodyless requests through with Sec-Fetch-Site: same-origin (dashboard via its /api proxy)", async () => {
    const res = await app.request("/api/apps/x/stop", {
      method: "POST",
      headers: { origin: "https://talome.example.com", "sec-fetch-site": "same-origin" },
    });
    expect(res.status).toBe(200);
  });

  it("skips webhooks", async () => {
    const res = await app.request("/api/webhooks/hook", { method: "POST" });
    expect(res.status).toBe(200);
  });
});

describe("appErrorHandler", () => {
  it("returns an HTTPException's own response without tracking it", async () => {
    const app = buildApp();
    const before = trackedCount();
    const res = await app.request("/api/teapot", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(418);
    expect(await res.text()).toBe("teapot");
    expect(trackedCount()).toBe(before);
  });

  it("still answers other errors with a tracked 500", async () => {
    const app = buildApp();
    const before = trackedCount();
    const res = await app.request("/api/boom", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; errorId: string };
    expect(body.error).toBe("An unexpected error occurred");
    expect(body.errorId).toBeTruthy();
    expect(trackedCount()).toBe(before + 1);
  });
});
