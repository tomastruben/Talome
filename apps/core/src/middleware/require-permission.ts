import type { MiddlewareHandler } from "hono";
import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import type { FeaturePermission, UserPermissions } from "@talome/types";
import { hasPermission } from "@talome/types";

/**
 * Restrict access to routes requiring a specific feature permission.
 * Admins always pass. Members are checked against their stored permissions.
 * Must be applied after requireSession (which sets sessionUser + sessionRole).
 */
export function requirePermission(feature: FeaturePermission): MiddlewareHandler {
  return async (c, next) => {
    const role = c.get("sessionRole" as never) as string | undefined;

    // Admins bypass all permission checks
    if (role === "admin") {
      return next();
    }

    const userId = c.get("sessionUser" as never) as string | undefined;
    if (!userId) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const user = db
      .select({ permissions: schema.users.permissions })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .get();

    if (!user) {
      return c.json({ error: "User not found" }, 404);
    }

    let permissions: UserPermissions | null = null;
    if (user.permissions) {
      try {
        permissions = JSON.parse(user.permissions) as UserPermissions;
      } catch {
        // Malformed JSON — treat as no restrictions
      }
    }

    if (!hasPermission(permissions, feature)) {
      return c.json(
        { error: `Access denied — you don't have permission to access ${feature}` },
        403,
      );
    }

    return next();
  };
}
