import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { getSystemStats } from "../docker/client.js";

const statsStream = new Hono();

/** SSE tick. getSystemStats() caches for slightly less than this, so each tick
 *  gets a new sample while concurrent clients share one. */
export const STATS_STREAM_INTERVAL_MS = 3000;

statsStream.get("/", (c) => {
  return streamSSE(c, async (stream) => {
    let id = 0;
    // Stop sampling once the client goes away — writes to an aborted stream
    // are silently dropped, so without this every closed tab leaked a loop.
    while (!stream.aborted && !stream.closed) {
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
      await stream.sleep(STATS_STREAM_INTERVAL_MS);
    }
  });
});

export { statsStream };
