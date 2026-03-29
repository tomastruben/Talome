import { tool } from "ai";
import { z } from "zod";
import { writeMemory, searchMemories, deleteMemory, updateMemory, listAllMemories } from "../../db/memories.js";

export const rememberTool = tool({
  description:
    "Explicitly store a fact or preference about the user for future conversations. Use this when the user tells you something important about themselves, their setup, or their preferences.",
  inputSchema: z.object({
    content: z.string().describe("A single sentence describing what to remember"),
    type: z
      .enum(["preference", "fact", "context", "correction"])
      .describe(
        "preference = user habit/choice, fact = objective info about their setup, context = situational, correction = user corrected the assistant",
      ),
  }),
  execute: async ({ content, type }) => {
    await writeMemory(type, content, undefined, 1.0);
    return `Remembered: "${content}"`;
  },
});

export const recallTool = tool({
  description:
    "Search stored memories for information relevant to a query. Use when you need to recall something specific about the user or their setup.",
  inputSchema: z.object({
    query: z.string().describe("Keywords to search for in stored memories"),
  }),
  execute: async ({ query }) => {
    const results = await searchMemories(query);
    if (results.length === 0) return "No memories found matching that query.";
    return results.map((m, i) => `${i + 1}. [${m.type}] ${m.content}`).join("\n");
  },
});

export const forgetTool = tool({
  description: "Delete a specific memory by its ID. Use when the user asks you to forget something.",
  inputSchema: z.object({
    id: z.number().describe("The numeric ID of the memory to delete"),
  }),
  execute: async ({ id }) => {
    await deleteMemory(id);
    return `Memory ${id} deleted.`;
  },
});

export const updateMemoryTool = tool({
  description:
    "Update an existing memory in-place by its ID. Use when information has changed or the user corrects a previously stored fact/preference.",
  inputSchema: z.object({
    id: z.number().describe("The numeric ID of the memory to update"),
    content: z.string().optional().describe("New content to replace the existing memory text"),
    type: z
      .enum(["preference", "fact", "context", "correction"])
      .optional()
      .describe("Optionally change the memory type"),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Optionally adjust confidence (0–1)"),
  }),
  execute: async ({ id, content, type, confidence }) => {
    const updated = await updateMemory(id, { content, type, confidence });
    if (!updated) return { success: false, summary: `Memory ${id} not found.` };
    return { success: true, summary: `Memory ${id} updated.` };
  },
});

export const listMemoriesTool = tool({
  description:
    "List all stored memories with optional filtering by type. Returns memories with their IDs for management (update/delete). Use recall for search instead.",
  inputSchema: z.object({
    type: z
      .enum(["preference", "fact", "context", "correction"])
      .optional()
      .describe("Filter by memory type, or omit for all"),
    limit: z.number().default(20).describe("Maximum memories to return"),
  }),
  execute: async ({ type, limit }) => {
    const memories = await listAllMemories({ type, limit });
    if (memories.length === 0) return { memories: [], summary: "No memories stored." };
    return {
      memories: memories.map((m) => ({
        id: m.id,
        type: m.type,
        content: m.content,
        confidence: m.confidence,
        accessCount: m.accessCount,
        createdAt: m.createdAt,
      })),
      count: memories.length,
      summary: `${memories.length} memor${memories.length === 1 ? "y" : "ies"} found.`,
    };
  },
});
