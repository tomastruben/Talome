import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/index.js";
import { sql } from "drizzle-orm";

function getOllamaUrl(): string {
  const row = db.get(sql`SELECT value FROM settings WHERE key = 'ollama_url'`) as { value: string } | undefined;
  return row?.value ?? "";
}

const ollama = new Hono();

/** GET /api/ollama/models — list installed models */
ollama.get("/models", async (c) => {
  const url = getOllamaUrl();
  if (!url) return c.json({ models: [], configured: false });
  try {
    const res = await fetch(`${url}/api/tags`);
    if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
    const data = await res.json() as { models: unknown[] };
    return c.json(data);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Failed to reach Ollama" }, 502);
  }
});

/** GET /api/ollama/ps — list running models */
ollama.get("/ps", async (c) => {
  const url = getOllamaUrl();
  if (!url) return c.json({ models: [] });
  try {
    const res = await fetch(`${url}/api/ps`);
    if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
    const data = await res.json() as { models: unknown[] };
    return c.json(data);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Failed" }, 502);
  }
});

/** POST /api/ollama/pull — pull a model (streams progress) */
ollama.post("/pull", async (c) => {
  const url = getOllamaUrl();
  if (!url) return c.json({ error: "Ollama not configured" }, 400);
  const parsed = z.object({ model: z.string().min(1).max(200) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const { model } = parsed.data;

  try {
    const res = await fetch(`${url}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: model, stream: true }),
    });
    if (!res.ok) throw new Error(`Ollama returned ${res.status}`);

    // Stream the response through
    return new Response(res.body, {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Transfer-Encoding": "chunked",
      },
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Pull failed" }, 502);
  }
});

/** DELETE /api/ollama/models/:name — delete a model */
ollama.delete("/models/:name", async (c) => {
  const url = getOllamaUrl();
  if (!url) return c.json({ error: "Ollama not configured" }, 400);
  const name = decodeURIComponent(c.req.param("name"));
  try {
    const res = await fetch(`${url}/api/delete`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Delete failed" }, 502);
  }
});

export { ollama };
