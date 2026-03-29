import { Hono } from "hono";
import { z } from "zod";
import { checkInterContainerConnectivity, type ContainerPair } from "../docker/client.js";

const health = new Hono();

const containerPairSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  port: z.number().int().positive().optional(),
});

const connectivityRequestSchema = z.object({
  pairs: z.array(containerPairSchema).min(1).max(20),
});

/**
 * GET /api/health/container-connectivity
 *
 * Test inter-container network connectivity between specified container pairs.
 * Each pair tests DNS resolution and TCP/HTTP reachability from 'from' into 'to'.
 *
 * Query params:
 *   pairs - JSON-encoded array of {from, to, port?} objects
 *
 * Example: /api/health/container-connectivity?pairs=[{"from":"sonarr","to":"prowlarr"},{"from":"radarr","to":"qbittorrent"}]
 */
health.get("/container-connectivity", async (c) => {
  try {
    const rawPairs = c.req.query("pairs");
    if (!rawPairs) {
      return c.json({ error: "Missing 'pairs' query parameter. Provide a JSON array of {from, to, port?} objects." }, 400);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawPairs);
    } catch {
      return c.json({ error: "Invalid JSON in 'pairs' query parameter." }, 400);
    }

    const validation = connectivityRequestSchema.safeParse({ pairs: parsed });
    if (!validation.success) {
      return c.json({ error: "Invalid pairs format.", details: validation.error.flatten() }, 400);
    }

    const pairs: ContainerPair[] = validation.data.pairs;
    const report = await checkInterContainerConnectivity(pairs);
    return c.json(report);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Failed to check connectivity" }, 500);
  }
});

/**
 * POST /api/health/container-connectivity
 *
 * Same as GET but accepts the pairs in the request body for convenience.
 */
health.post("/container-connectivity", async (c) => {
  try {
    const body = await c.req.json();
    const validation = connectivityRequestSchema.safeParse(body);
    if (!validation.success) {
      return c.json({ error: "Invalid request body.", details: validation.error.flatten() }, 400);
    }

    const pairs: ContainerPair[] = validation.data.pairs;
    const report = await checkInterContainerConnectivity(pairs);
    return c.json(report);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Failed to check connectivity" }, 500);
  }
});

export { health };
