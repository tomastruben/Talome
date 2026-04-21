import type { MiddlewareHandler } from "hono";

/**
 * Restrict access to admin-only routes.
 * Must be applied after requireSession (which sets sessionRole).
 */
export function requireRole(role: "admin"): MiddlewareHandler {
  return async (c, next) => {
    const userRole = c.get("sessionRole" as never) as string | undefined;
    if (userRole !== role) {
      return c.json({ error: "Forbidden — admin access required" }, 403);
    }
    await next();
  };
}
