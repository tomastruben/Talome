import { Hono } from "hono";
import { getSystemStats, getDockerSocketPath } from "../docker/client.js";
import { serverError } from "../middleware/request-logger.js";

const system = new Hono();

system.get("/", async (c) => {
  try {
    const stats = await getSystemStats();
    return c.json({ ...stats, dockerSocket: getDockerSocketPath() });
  } catch (err) {
    return serverError(c, err, { message: "Failed to get system stats" });
  }
});

export { system };
