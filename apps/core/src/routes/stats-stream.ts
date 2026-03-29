import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { getSystemStats } from "../docker/client.js";

const statsStream = new Hono();

statsStream.get("/", (c) => {
  return streamSSE(c, async (stream) => {
    let id = 0;
    while (true) {
      try {
        const stats = await getSystemStats();
        await stream.writeSSE({
          data: JSON.stringify(stats),
          event: "stats",
          id: String(id++),
        });
      } catch {
        await stream.writeSSE({
          data: JSON.stringify({ error: "Failed to get stats" }),
          event: "error",
          id: String(id++),
        });
      }
      await stream.sleep(3000);
    }
  });
});

export { statsStream };
