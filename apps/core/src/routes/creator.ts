import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { Hono } from "hono";
import { z } from "zod";
import {
  CreatorRequestSchema,
  CreatorDraftSchema,
  PublishDraftRequestSchema,
} from "../creator/contracts.js";
import {
  generateCreatorDraft,
  getCreatorModel,
  publishCreatorDraft,
} from "../creator/orchestrator.js";
import { validateDesignArtifacts } from "../creator/workspace-executor.js";
import { validateGeneratedApp } from "../creator/completion-validation.js";
import { searchDesignPatterns } from "../creator/design-patterns.js";
import { checkCreatorCliReadiness } from "../creator/cli-readiness.js";
import { buildCreatorTerminalCommand } from "../creator/terminal-command.js";
import { creatorSkipsPermissionPrompts } from "../ai/autonomy.js";
import { snapshotGeneratedWorkspace } from "../creator/workspace-snapshot.js";
import { preparePublicationContract } from "../creator/publication-contract.js";
import { writeAuditEntry } from "../db/audit.js";
import { captureRouteError, serverError } from "../middleware/request-logger.js";

const creator = new Hono();

/** Where generated app workspaces live (read at call time, so HOME can change in tests). */
export function creatorWorkspacesRoot(): string {
  return resolve(homedir(), ".talome", "generated-apps");
}

const APP_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/i;

/**
 * The workspace for an app is always ~/.talome/generated-apps/<appId>. A
 * request may name it explicitly (older clients send it back), but anything
 * else is refused: this path becomes the working directory of a Claude Code
 * session, and the source of files that are published as an app.
 */
export function resolveCreatorWorkspace(
  appId: string,
  requested?: string,
): { ok: true; path: string } | { ok: false; error: string } {
  if (!APP_ID_PATTERN.test(appId) || appId.includes("..")) {
    return { ok: false, error: "Invalid app id." };
  }
  const root = creatorWorkspacesRoot();
  const expected = join(root, appId);
  if (requested !== undefined && requested !== "" && resolve(requested) !== expected) {
    return { ok: false, error: "The workspace must be this app's folder in ~/.talome/generated-apps." };
  }
  // A symlinked workspace must still land inside the workspaces root.
  if (existsSync(expected)) {
    try {
      const realRoot = existsSync(root) ? realpathSync(root) : root;
      const real = realpathSync(expected);
      if (real !== realRoot && !real.startsWith(`${realRoot}${sep}`)) {
        return { ok: false, error: "The app workspace points outside ~/.talome/generated-apps." };
      }
    } catch {
      return { ok: false, error: "Couldn't read the app workspace." };
    }
  }
  return { ok: true, path: expected };
}

creator.get("/design-patterns", (c) => c.json(searchDesignPatterns(c.req.query("intent") ?? "")));

const TERMINAL_DAEMON_PORT = Number(process.env.TERMINAL_DAEMON_PORT) || 4001;

// POST /api/apps/create — build a draft app blueprint and prepare workspace (no Claude Code yet)
creator.post("/create", async (c) => {
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

  const canUseBlueprint = Boolean(parsed.data.preBuiltBlueprint?.identity?.name && parsed.data.preBuiltBlueprint.services?.length);
  if (!canUseBlueprint) {
    try { getCreatorModel(); }
    catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "AI provider is not configured." }, 503);
    }
  }

  try {
    const draft = await generateCreatorDraft(parsed.data);

    // Auto-publish: generate + publish in one call
    if (parsed.data.saveImmediately && !draft.blueprint.scaffold.enabled) {
      const result = await publishCreatorDraft(draft);
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

    return c.json({ ok: true, draft, pending: draft.blueprint.scaffold.enabled });
  } catch (err) {
    return serverError(c, err, { message: "App generation failed" });
  }
});

// POST /api/apps/create/execute — start terminal session for scaffold generation
creator.post("/create/execute", async (c) => {
  const bodySchema = z.object({
    workspaceRoot: z.string().optional(),
    taskPrompt: z.string().min(1),
    appId: z.string().min(1),
    // Narrow-only: the owner's server setting decides whether prompts are skipped.
    auto: z.boolean().optional(),
    yolo: z.boolean().optional(), // legacy alias
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

  const readiness = await checkCreatorCliReadiness();
  if (!readiness.ready) return c.json({ error: readiness.error, stage: "scaffold", generated: false }, 503);

  const workspace = resolveCreatorWorkspace(parsed.data.appId, parsed.data.workspaceRoot);
  if (!workspace.ok) return c.json({ error: workspace.error }, 400);
  const workspaceRoot = workspace.path;
  const { taskPrompt, appId } = parsed.data;
  const autoMode = creatorSkipsPermissionPrompts(parsed.data.auto ?? parsed.data.yolo);
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
  const promptFile = join(tmpdir(), `talome-prompt-creator-${randomUUID()}.md`);
  await writeFile(promptFile, taskPrompt, { encoding: "utf-8", mode: 0o600, flag: "wx" });

  // cd to workspace, use subscription auth (unset API key), interactive or auto mode
  const command = buildCreatorTerminalCommand(workspaceRoot, promptFile, autoMode);

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

  const workspace = resolveCreatorWorkspace(parsed.data.appId, parsed.data.workspaceRoot);
  if (!workspace.ok) return c.json({ error: workspace.error }, 400);
  const { appId } = parsed.data;
  const workspaceRoot = workspace.path;
  const scaffoldPath = join(workspaceRoot, "generated-app");
  const startTime = Date.now();

  try {
    const { existsSync, readFileSync } = await import("node:fs");
    const draftPath = join(workspaceRoot, ".talome-creator", "creator-draft.json");
    const storedDraft = existsSync(draftPath) ? CreatorDraftSchema.parse(JSON.parse(readFileSync(draftPath, "utf-8"))) : undefined;
    if (storedDraft && storedDraft.app.id !== appId) throw new Error("Prepared draft appId does not match completion request.");
    const creatorJsonPath = join(workspaceRoot, ".talome-creator", "blueprint.json");
    let blueprintData: Record<string, unknown> = {};
    if (existsSync(creatorJsonPath)) {
      blueprintData = JSON.parse(readFileSync(creatorJsonPath, "utf-8"));
    }
    const validatedScaffoldPath = await snapshotGeneratedWorkspace(scaffoldPath);
    const publicationSpec = preparePublicationContract(validatedScaffoldPath, appId, blueprintData.appSpec);
    if (publicationSpec) blueprintData.appSpec = publicationSpec;
    const manifestPath = join(validatedScaffoldPath, "manifest.json");
    const hasManifest = existsSync(manifestPath);
    const generated = await validateGeneratedApp(validatedScaffoldPath, appId, blueprintData);
    const filesGenerated = generated.files;
    const hasCompose = Boolean(generated.composeFile);
    if (generated.appSpec) blueprintData.appSpec = generated.appSpec;

    const usesStagedDesignWorkflow = Boolean(
      blueprintData.research || blueprintData.experienceDesign,
    );
    const designValidations = usesStagedDesignWorkflow
      ? await validateDesignArtifacts(workspaceRoot)
      : [];
    const validations = [...generated.validations, ...designValidations];
    const failedValidations = validations.filter((check) => check.status === "failed");
    const workflowError = failedValidations.length > 0
      ? failedValidations.map((check) => check.details || check.label).join("; ")
      : undefined;

    // Re-publish: copy scaffold files to user-apps install directory
    // This ensures any changes Claude Code made during the interactive session
    // (new files, modified compose, etc.) are reflected in the installed app.
    const { createUserApp } = await import("../stores/creator.js");
    let republishError: string | undefined;

    if (hasCompose && !workflowError) {
      // Read manifest for metadata
      let manifest: Record<string, unknown> = {};
      if (hasManifest) {
        try {
          manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
        } catch { /* best effort */ }
      }

      const appName = generated.appSpec?.name || (manifest.name as string) || (blueprintData.name as string) || appId;
      const result = createUserApp({
        id: appId,
        name: appName,
        description: generated.appSpec?.description || (manifest.description as string) || (blueprintData.description as string) || "",
        category: (manifest.category as string) || (blueprintData.category as string) || "other",
        services: [], // Services come from the compose file, not this input
        env: Array.isArray(blueprintData.env) ? blueprintData.env as any : storedDraft?.app.env ?? [],
        creator: {
          blueprint: blueprintData as any,
          sources: storedDraft?.sources ?? [],
          validations,
          instructionPack: storedDraft?.instructionPack ?? { version: typeof blueprintData.instructionsVersion === "string" ? blueprintData.instructionsVersion : "legacy", hash: "", files: [] },
          workspace: {
            appId,
            rootPath: workspaceRoot,
            scaffoldPath,
            fileCount: filesGenerated.length,
            entryFiles: [],
            sourceSnapshots: [],
            designArtifacts: usesStagedDesignWorkflow
              ? [
                  ".talome-creator/research/findings.md",
                  ".talome-creator/design/screen-spec.md",
                  ".talome-creator/validation/report.md",
                ]
              : [],
            generatedWithClaudeCode: true,
          },
          createdAt: storedDraft?.createdAt ?? new Date().toISOString(),
        },
      }, { validatedScaffoldPath });

      if (!result.success) {
        republishError = result.error;
      }
    }

    const duration = Date.now() - startTime;

    writeAuditEntry("AI: creator_complete", "read", `Validated ${appId}: ${filesGenerated.length} files`);

    return c.json({
      ok: !republishError && !workflowError,
      appId,
      filesGenerated,
      fileCount: filesGenerated.length,
      hasCompose,
      hasManifest,
      designValidations,
      validations,
      error: workflowError,
      republishError,
      duration,
    });
  } catch (err) {
    captureRouteError(c, err, { endpoint: "creator/complete", appId });
    return c.json({
      ok: false,
      appId,
      error: err instanceof Error ? err.message : "Validation failed",
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
    const result = await publishCreatorDraft(parsed.data.draft, parsed.data.overrides);
    if (!result.success) {
      return c.json({ error: result.error || "Failed to publish app" }, 400);
    }
    return c.json({
      ok: true,
      appId: result.appId,
      storeId: result.storeId,
      workspacePath: parsed.data.draft.workspace?.rootPath,
    });
  } catch (err) {
    return serverError(c, err, { message: "App publish failed" });
  }
});

export { creator };
