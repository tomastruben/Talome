import { homedir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { Hono } from "hono";
import { z } from "zod";
import {
  CreatorRequestSchema,
  PublishDraftRequestSchema,
} from "../creator/contracts.js";
import {
  generateCreatorDraft,
  getAnthropicApiKey,
  publishCreatorDraft,
} from "../creator/orchestrator.js";
import { writeAuditEntry } from "../db/audit.js";

const creator = new Hono();

const TERMINAL_DAEMON_PORT = Number(process.env.TERMINAL_DAEMON_PORT) || 4001;

// POST /api/apps/create — build a draft app blueprint and prepare workspace (no Claude Code yet)
creator.post("/create", async (c) => {
  const apiKey = getAnthropicApiKey();
  if (!apiKey) {
    return c.json(
      {
        error: "No Anthropic API key configured. Add one in Settings → AI Provider.",
      },
      503
    );
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = CreatorRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  try {
    const draft = await generateCreatorDraft(parsed.data, apiKey);

    // Auto-publish: generate + publish in one call
    if (parsed.data.saveImmediately) {
      const result = publishCreatorDraft(draft);
      if (!result.success) {
        return c.json({ error: result.error || "Failed to publish app" }, 500);
      }
      return c.json({
        ok: true,
        appId: result.appId,
        storeId: result.storeId,
        draft,
      });
    }

    return c.json({ ok: true, draft });
  } catch (err: any) {
    return c.json({ error: err.message || "Generation failed" }, 500);
  }
});

// POST /api/apps/create/execute — start terminal session for scaffold generation
creator.post("/create/execute", async (c) => {
  const bodySchema = z.object({
    workspaceRoot: z.string().optional(),
    taskPrompt: z.string().min(1),
    appId: z.string().min(1),
    auto: z.boolean().default(false),
    yolo: z.boolean().default(false), // legacy alias
  });

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const workspaceRoot = parsed.data.workspaceRoot || join(homedir(), ".talome", "generated-apps", parsed.data.appId);
  const { taskPrompt, appId } = parsed.data;
  const autoMode = parsed.data.auto || parsed.data.yolo;
  const sessionName = `creator-${appId}`;

  // Create terminal session via daemon
  try {
    await fetch(`http://127.0.0.1:${TERMINAL_DAEMON_PORT}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: sessionName }),
    });
  } catch {
    // Daemon may not be running — frontend will handle this gracefully
  }

  writeAuditEntry("AI: creator_execute", "destructive", `Scaffold generation for ${appId}`);

  // Write prompt to temp file for atomic CLI argument passing
  const promptFile = `/tmp/talome-prompt-creator-${appId}.md`;
  await writeFile(promptFile, taskPrompt, "utf-8");

  // cd to workspace, use subscription auth (unset API key), interactive or auto mode
  const skipPerms = autoMode ? " --dangerously-skip-permissions" : "";
  const command = `cd ${workspaceRoot} && env -u ANTHROPIC_API_KEY claude${skipPerms} "$(cat ${promptFile})"`;

  return c.json({
    sessionName: `sess_${sessionName}`,
    command,
    taskPrompt,
    workspaceRoot,
  });
});

// POST /api/apps/create/complete — validate and re-publish after Claude Code finishes
creator.post("/create/complete", async (c) => {
  const bodySchema = z.object({
    appId: z.string().min(1),
    workspaceRoot: z.string().min(1),
  });

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const { appId, workspaceRoot } = parsed.data;
  const scaffoldPath = join(workspaceRoot, "generated-app");
  const startTime = Date.now();

  try {
    // List generated files
    const { readdirSync, statSync, existsSync, readFileSync } = await import("node:fs");

    function countFiles(dir: string): string[] {
      const results: string[] = [];
      if (!existsSync(dir)) return results;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...countFiles(full));
        } else {
          results.push(full.replace(`${scaffoldPath}/`, ""));
        }
      }
      return results;
    }

    const filesGenerated = countFiles(scaffoldPath);

    // Check that docker-compose.yml exists
    const composePath = [
      join(scaffoldPath, "docker-compose.yml"),
      join(scaffoldPath, "docker-compose.yaml"),
    ].find((p) => existsSync(p));

    const hasCompose = !!composePath;

    // Check manifest exists
    const manifestPath = join(scaffoldPath, "manifest.json");
    const hasManifest = existsSync(manifestPath);

    // Re-publish: copy scaffold files to user-apps install directory
    // This ensures any changes Claude Code made during the interactive session
    // (new files, modified compose, etc.) are reflected in the installed app.
    const { createUserApp } = await import("../stores/creator.js");
    let republishError: string | undefined;

    if (hasCompose || hasManifest) {
      // Read the creator.json if it exists to get the full input data
      const creatorJsonPath = join(workspaceRoot, ".talome-creator", "blueprint.json");
      let blueprintData: Record<string, unknown> = {};
      try {
        blueprintData = JSON.parse(readFileSync(creatorJsonPath, "utf-8"));
      } catch { /* best effort */ }

      // Read manifest for metadata
      let manifest: Record<string, unknown> = {};
      if (hasManifest) {
        try {
          manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
        } catch { /* best effort */ }
      }

      const appName = (manifest.name as string) || (blueprintData.name as string) || appId;
      const result = createUserApp({
        id: appId,
        name: appName,
        description: (manifest.description as string) || (blueprintData.description as string) || "",
        category: (manifest.category as string) || (blueprintData.category as string) || "other",
        services: [], // Services come from the compose file, not this input
        env: [],
        creator: {
          blueprint: blueprintData as any,
          sources: [],
          validations: [],
          instructionPack: { version: "1.0.0", hash: "", files: [] },
          workspace: {
            appId,
            rootPath: workspaceRoot,
            scaffoldPath,
            fileCount: filesGenerated.length,
            entryFiles: [],
            sourceSnapshots: [],
            generatedWithClaudeCode: true,
          },
          createdAt: new Date().toISOString(),
        },
      });

      if (!result.success) {
        republishError = result.error;
      }
    }

    const duration = Date.now() - startTime;

    writeAuditEntry("AI: creator_complete", "read", `Validated ${appId}: ${filesGenerated.length} files`);

    return c.json({
      ok: !republishError,
      appId,
      filesGenerated,
      fileCount: filesGenerated.length,
      hasCompose,
      hasManifest,
      republishError,
      duration,
    });
  } catch (err: any) {
    return c.json({
      ok: false,
      appId,
      error: err.message || "Validation failed",
      filesGenerated: [],
      fileCount: 0,
      hasCompose: false,
      hasManifest: false,
      duration: Date.now() - startTime,
    }, 500);
  }
});

creator.post("/create/publish", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = PublishDraftRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  try {
    const result = publishCreatorDraft(parsed.data.draft, parsed.data.overrides);
    if (!result.success) {
      return c.json({ error: result.error || "Failed to publish app" }, 400);
    }
    return c.json({
      ok: true,
      appId: result.appId,
      storeId: result.storeId,
      workspacePath: parsed.data.draft.workspace?.rootPath,
    });
  } catch (err: any) {
    return c.json({ error: err.message || "Publish failed" }, 500);
  }
});

export { creator };
