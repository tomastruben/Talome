import { tool } from "ai";
import { z } from "zod";
import { db } from "../../db/index.js";
import { sql } from "drizzle-orm";

function getOllamaUrl(): string {
  const row = db.get(sql`SELECT value FROM settings WHERE key = 'ollama_url'`) as { value: string } | undefined;
  return row?.value ?? "http://localhost:11434";
}

export const ollamaListModelsTool = tool({
  description: "List all locally available Ollama models with their sizes and modification dates.",
  inputSchema: z.object({}),
  execute: async () => {
    const url = getOllamaUrl();
    try {
      const res = await fetch(`${url}/api/tags`);
      if (!res.ok) return { success: false, error: `Ollama returned ${res.status}` };
      const data = await res.json() as { models?: { name: string; size: number; modified_at: string; details?: { parameter_size?: string; quantization_level?: string } }[] };
      return {
        success: true,
        models: (data.models ?? []).map((m) => ({
          name: m.name,
          sizeMB: Math.round(m.size / 1048576),
          modifiedAt: m.modified_at,
          parameterSize: m.details?.parameter_size,
          quantization: m.details?.quantization_level,
        })),
      };
    } catch (err) {
      return { success: false, error: `Cannot reach Ollama at ${url}: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
});

export const ollamaPullModelTool = tool({
  description: "Pull (download) an Ollama model. This may take several minutes for large models.",
  inputSchema: z.object({
    model: z.string().describe("Model name to pull (e.g., llama3.2, mistral, codellama)"),
  }),
  execute: async ({ model }) => {
    const url = getOllamaUrl();
    try {
      const res = await fetch(`${url}/api/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: model, stream: false }),
      });
      if (!res.ok) {
        const text = await res.text();
        return { success: false, error: `Ollama returned ${res.status}: ${text}` };
      }
      return { success: true, message: `Model ${model} pulled successfully` };
    } catch (err) {
      return { success: false, error: `Cannot reach Ollama: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
});

export const ollamaDeleteModelTool = tool({
  description: "Delete a locally stored Ollama model to free disk space.",
  inputSchema: z.object({
    model: z.string().describe("Model name to delete"),
  }),
  execute: async ({ model }) => {
    const url = getOllamaUrl();
    try {
      const res = await fetch(`${url}/api/delete`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: model }),
      });
      if (!res.ok) return { success: false, error: `Ollama returned ${res.status}` };
      return { success: true, message: `Model ${model} deleted` };
    } catch (err) {
      return { success: false, error: `Cannot reach Ollama: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
});

export const ollamaModelInfoTool = tool({
  description: "Get detailed information about a specific Ollama model.",
  inputSchema: z.object({
    model: z.string().describe("Model name"),
  }),
  execute: async ({ model }) => {
    const url = getOllamaUrl();
    try {
      const res = await fetch(`${url}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: model }),
      });
      if (!res.ok) return { success: false, error: `Ollama returned ${res.status}` };
      return { success: true, info: await res.json() };
    } catch (err) {
      return { success: false, error: `Cannot reach Ollama: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
});

export const ollamaPsTool = tool({
  description: "List currently running Ollama models (loaded in memory/VRAM).",
  inputSchema: z.object({}),
  execute: async () => {
    const url = getOllamaUrl();
    try {
      const res = await fetch(`${url}/api/ps`);
      if (!res.ok) return { success: false, error: `Ollama returned ${res.status}` };
      return { success: true, ...(await res.json()) };
    } catch (err) {
      return { success: false, error: `Cannot reach Ollama: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
});
