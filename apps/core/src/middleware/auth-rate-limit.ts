import type { Hono } from "hono";
import { rateLimit } from "./rate-limit.js";

/**
 * The auth endpoints that take a password, recovery code or invitation token.
 * Only these are throttled: /api/auth/me, /status and /verify (Caddy's
 * forward_auth, called on every proxied request) must never hit a limit.
 */
export const AUTH_ATTEMPT_PATHS = [
  "/api/auth/setup",
  "/api/auth/login",
  "/api/auth/recover",
  "/api/auth/invitations/:token/accept",
] as const;

/** 10 attempts per minute per client IP, shared across the endpoints above. */
export const AUTH_ATTEMPT_LIMIT = { maxRequests: 10, windowMs: 60_000 } as const;

/**
 * Brute-force protection for sign-in, first-run setup, recovery and invite
 * acceptance. Hono runs handlers in registration order and a route handler
 * does not call next(), so this must be registered BEFORE
 * app.route("/api/auth", auth) or it never runs.
 */
export function registerAuthAttemptLimit(app: Hono): void {
  app.on("POST", [...AUTH_ATTEMPT_PATHS], rateLimit(AUTH_ATTEMPT_LIMIT.maxRequests, AUTH_ATTEMPT_LIMIT.windowMs));
}
