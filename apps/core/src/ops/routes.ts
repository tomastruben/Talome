import { Hono } from "hono";
import { z } from "zod";
import { streamSSE } from "hono/streaming";
import { serverError } from "../middleware/request-logger.js";
import {
  getOperation,
  listOperations,
  listOperationSteps,
  onOperationEvent,
  type OperationEvent,
} from "./operations.js";

export const operationsRoute = new Hono();

const listQuerySchema = z.object({
  active: z.enum(["1", "0", "true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

// GET /api/operations?active=1 — journaled app operations (newest first)
operationsRoute.get("/", (c) => {
  const parsed = listQuerySchema.safeParse({
    active: c.req.query("active") ?? undefined,
    limit: c.req.query("limit") ?? undefined,
  });
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  try {
    const active = parsed.data.active === "1" || parsed.data.active === "true";
    return c.json(listOperations({ active, limit: parsed.data.limit }));
  } catch (err) {
    return serverError(c, err, { message: "Failed to load operations" });
  }
});

const streamQuerySchema = z.object({
  appId: z.string().min(1).max(200).optional(),
});

// GET /api/operations/stream?appId= — live progress events (SSE)
operationsRoute.get("/stream", (c) => {
  const parsed = streamQuerySchema.safeParse({ appId: c.req.query("appId") ?? undefined });
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const filterAppId = parsed.data.appId;

  return streamSSE(c, async (stream) => {
    let id = 0;
    const queue: OperationEvent[] = [];
    const unsubscribe = onOperationEvent((event) => {
      if (filterAppId && event.appId !== filterAppId) return;
      queue.push(event);
    });

    try {
      await stream.writeSSE({ event: "ready", data: JSON.stringify({ ok: true }), id: String(id++) });
      let idleTicks = 0;
      while (!stream.aborted) {
        while (queue.length > 0) {
          const event = queue.shift();
          if (!event) break;
          await stream.writeSSE({ event: "operation", data: JSON.stringify(event), id: String(id++) });
        }
        await stream.sleep(250);
        // Keep-alive comment roughly every 15s so proxies don't drop the stream.
        if (++idleTicks >= 60) {
          idleTicks = 0;
          await stream.writeSSE({ event: "ping", data: "{}", id: String(id++) });
        }
      }
    } finally {
      unsubscribe();
    }
  });
});

// GET /api/operations/:id — one operation with its ordered step history
operationsRoute.get("/:id", (c) => {
  try {
    const op = getOperation(c.req.param("id"));
    if (!op) return c.json({ error: "Operation not found" }, 404);
    return c.json({ ...op, steps: listOperationSteps(op.id) });
  } catch (err) {
    return serverError(c, err, { message: "Failed to load operation" });
  }
});
