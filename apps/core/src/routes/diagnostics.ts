import { Hono } from "hono";
import { detectJellyfinErrors } from "../services/diagnostics.js";

const diagnostics = new Hono();

diagnostics.get("/jellyfin-errors", async (c) => {
  try {
    const result = await detectJellyfinErrors();
    return c.json(result);
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Failed to detect Jellyfin errors" },
      500,
    );
  }
});

export { diagnostics };
