import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { AUTH_ATTEMPT_LIMIT, registerAuthAttemptLimit } from "../middleware/auth-rate-limit.js";

/** Mirrors index.ts: the limiter, then the auth routes (whose handlers end the chain). */
function appWithAuth() {
  const app = new Hono();
  registerAuthAttemptLimit(app);
  const auth = new Hono();
  auth.post("/login", (c) => c.json({ error: "That username and password don't match." }, 401));
  auth.post("/setup", (c) => c.json({ ok: true }));
  auth.get("/me", (c) => c.json({ ok: true }));
  auth.get("/verify", (c) => c.body(null, 200));
  app.route("/api/auth", auth);
  return app;
}

function login(app: Hono, ip: string) {
  return app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ username: "owner", password: "guess" }),
  });
}

describe("auth attempt rate limit", () => {
  it("answers 429 on the 11th sign-in attempt from one address within a minute", async () => {
    const app = appWithAuth();
    for (let i = 0; i < AUTH_ATTEMPT_LIMIT.maxRequests; i++) {
      expect((await login(app, "10.0.0.1")).status).toBe(401);
    }
    const limited = await login(app, "10.0.0.1");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();
    // Another address is unaffected.
    expect((await login(app, "10.0.0.2")).status).toBe(401);
  });

  it("never throttles the session checks that run on every page and proxied request", async () => {
    const app = appWithAuth();
    for (let i = 0; i < 30; i++) {
      expect((await app.request("/api/auth/me", { headers: { "x-forwarded-for": "10.0.0.3" } })).status).toBe(200);
      expect((await app.request("/api/auth/verify", { headers: { "x-forwarded-for": "10.0.0.3" } })).status).toBe(200);
    }
  });

  it("is registered before the auth routes in the server (a later limiter never runs)", () => {
    const source = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
    const limiter = source.indexOf("registerAuthAttemptLimit(app)");
    const routes = source.indexOf('app.route("/api/auth", auth)');
    expect(limiter).toBeGreaterThan(-1);
    expect(routes).toBeGreaterThan(-1);
    expect(limiter).toBeLessThan(routes);

    // Every path-scoped limiter in index.ts precedes the routes it protects.
    for (const match of source.matchAll(/app\.use\("([^"]+)\/\*", rateLimit\(/g)) {
      const prefix = match[1];
      const firstRoute = source.search(new RegExp(`app\\.route\\("${prefix.replace(/[/]/g, "\\/")}[/"]`));
      if (firstRoute !== -1) expect(match.index, `${prefix} limiter must precede its routes`).toBeLessThan(firstRoute);
    }
  });
});
