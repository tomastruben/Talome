import { Hono } from "hono";
import { getSystemStats, getDockerSocketPath } from "../docker/client.js";

const system = new Hono();

system.get("/", async (c) => {
  try {
    const stats = await getSystemStats();
    return c.json({ ...stats, dockerSocket: getDockerSocketPath() });
  } catch (err) {
    return c.json({ error: "Failed to get system stats" }, 500);
  }
});

export { system };
