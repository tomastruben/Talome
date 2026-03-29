import { tool } from "ai";
import { z } from "zod";
import { eq, desc, and, type SQL } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { saveScreenshots } from "../claude-runner.js";

export const trackIssueTool = tool({
  description:
    "Track a bug report, feature request, or improvement idea from the user. " +
    "Use this when the user reports a problem, describes a desired feature, or " +
    "discusses something that should be acted on later. The item appears in the " +
    "Evolution page for review and execution.",
  inputSchema: z.object({
    title: z.string().describe("Short title (under 80 chars)"),
    description: z
      .string()
      .describe("2-3 sentence explanation of the issue or feature request"),
    category: z
      .enum(["performance", "reliability", "ux", "feature", "maintenance"])
      .describe("bug → reliability, feature → feature, ui issue → ux, speed → performance, cleanup → maintenance"),
    priority: z.enum(["low", "medium", "high"]),
    scope: z
      .enum(["backend", "frontend", "full"])
      .default("full")
      .describe("Which part of the codebase is affected"),
    taskPrompt: z
      .string()
      .describe(
        "Detailed prompt for Claude Code to implement the fix or feature. " +
        "Include specific file paths if known, expected behavior, and constraints.",
      ),
    screenshots: z
      .array(z.string())
      .optional()
      .describe("Base64 data URLs of screenshots from the chat, if the user attached images"),
  }),
  execute: async ({ title, description, category, priority, scope, taskPrompt, screenshots }) => {
    // Save screenshots to disk if provided
    let screenshotPaths: string[] = [];
    if (screenshots && screenshots.length > 0) {
      screenshotPaths = await saveScreenshots(screenshots);
    }

    const now = new Date().toISOString();
    const id = `sug_${Date.now()}_chat`;

    db.insert(schema.evolutionSuggestions)
      .values({
        id,
        title,
        description,
        category,
        priority,
        sourceSignals: JSON.stringify(["user_report"]),
        taskPrompt,
        scope,
        status: "pending",
        source: "chat",
        screenshots: JSON.stringify(screenshotPaths),
        createdAt: now,
        updatedAt: now,
      })
      .run();

    return `Tracked: "${title}" (${category}, ${priority} priority). View it on the Evolution page.`;
  },
});

// ── list_issues ──────────────────────────────────────────────────────────────

export const listIssuesTool = tool({
  description:
    "List tracked issues (bug reports, feature requests, scan suggestions) from the Evolution page. " +
    "Returns items sorted by creation date (newest first). Use filters to narrow results.",
  inputSchema: z.object({
    status: z
      .enum(["pending", "in_progress", "completed", "dismissed"])
      .optional()
      .describe("Filter by status"),
    source: z
      .enum(["bug_hunt", "scan", "chat"])
      .optional()
      .describe("Filter by source — bug_hunt (user-reported via Bug Hunt), scan (AI-generated), chat (tracked from conversation)"),
    category: z
      .enum(["performance", "reliability", "ux", "feature", "maintenance"])
      .optional()
      .describe("Filter by category"),
    priority: z
      .enum(["low", "medium", "high"])
      .optional()
      .describe("Filter by priority"),
    limit: z.number().default(20).describe("Maximum number of items to return"),
  }),
  execute: async ({ status, source, category, priority, limit }) => {
    const conditions: SQL[] = [];
    if (status) conditions.push(eq(schema.evolutionSuggestions.status, status));
    if (source) conditions.push(eq(schema.evolutionSuggestions.source, source));
    if (category) conditions.push(eq(schema.evolutionSuggestions.category, category));
    if (priority) conditions.push(eq(schema.evolutionSuggestions.priority, priority));

    const query = db
      .select()
      .from(schema.evolutionSuggestions)
      .orderBy(desc(schema.evolutionSuggestions.createdAt))
      .limit(limit);

    const rows = conditions.length > 0
      ? query.where(and(...conditions)).all()
      : query.all();

    return {
      count: rows.length,
      issues: rows.map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        category: r.category,
        priority: r.priority,
        status: r.status,
        source: r.source,
        scope: r.scope,
        taskPrompt: r.taskPrompt,
        screenshots: JSON.parse(r.screenshots ?? "[]") as string[],
        createdAt: r.createdAt,
      })),
    };
  },
});
