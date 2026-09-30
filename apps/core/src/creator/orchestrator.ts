import { generateObject } from "ai";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSetting } from "../utils/settings.js";
import { getConfiguredModel } from "../ai/configured-model.js";
import { createUserApp } from "../stores/creator.js";
import {
  AppBlueprintSchema,
  type AppBlueprint,
  type CreatorDraft,
  type CreatorRequest,
  type GeneratedApp,
  type ValidationCheck,
} from "./contracts.js";
import { createDefaultAppSpec, TalomeAppSpecSchema } from "../app-specs/schema.js";
import { loadInstructionPack, loadTalomeReferenceSnapshots, renderInstructionPack } from "./instructions.js";
import { discoverSources, renderSourceContext } from "./source-discovery.js";
import { repairCreatorBlueprint } from "./blueprint-normalization.js";
import { prepareWorkspace, validateDesignArtifacts } from "./workspace-executor.js";
import { validateGeneratedApp } from "./completion-validation.js";
import { hasGeneratedImplementation, listGeneratedFiles } from "./workspace-files.js";
import { validateNativeAppInBrowser } from "./browser-validation.js";
import { snapshotGeneratedWorkspace, snapshotNativeContract } from "./workspace-snapshot.js";
import { preparePublicationContract } from "./publication-contract.js";

function summarizeReferenceContent(content: string): string {
  return content.split("\n").slice(0, 40).join("\n").slice(0, 1800);
}

/** Kept for existing internal callers; stored secrets must be decrypted. */
export function getAnthropicApiKey(): string | undefined {
  return getSetting("anthropic_key") || process.env.ANTHROPIC_API_KEY;
}
export const getCreatorModel = getConfiguredModel;

function buildBlueprintPrompt(
  request: CreatorRequest,
  instructionText: string,
  sourceContext: string,
  talomeReferences: Awaited<ReturnType<typeof loadTalomeReferenceSnapshots>>,
): string {
  const talomeContext = talomeReferences
    .map(
      (reference) =>
        `### ${reference.title}\nPath: ${reference.relativePath}\nReason: ${reference.reason}\nSnippet:\n${summarizeReferenceContent(reference.content)}`,
    )
    .join("\n\n");

  return [
    `Create an app blueprint for this request: "${request.description}".`,
    `Requested mode: ${request.mode}.`,
    "Return a practical, non-placeholder blueprint that can be published to Talome and used to drive Claude Code workspace generation.",
    instructionText,
    "## Source context",
    sourceContext,
    "## Talome design references",
    talomeContext,
    "## Additional requirements",
    "- Start from concrete user jobs: populate research.useCases before choosing screens or components.",
    "- research.githubQueries and research.libraryNeeds are research intent, not invented findings; the workspace must verify real repositories, libraries, licenses, and maintenance evidence.",
    "- experienceDesign must map every screen to a use case, one primary action, required states, and a named product pattern.",
    "- Commit to one visual direction. Use native-system for Talome-native AppSpec surfaces, reference-led when adapting proven product patterns, and image-concept only when a bespoke visual surface materially benefits from concept art.",
    "- The design alignment summary must explicitly mention Talome consistency.",
    "- UI references must point to real Talome files from the provided context.",
    "- Include an AppSpec v1 with only declared Talome components, data sources, actions, and assistant suggestions.",
    "- Expose useful, safe app actions to the Talome assistant through appSpec.assistant.exposedActions.",
    "- Prefer a native Talome surface over duplicating Talome components in generated source.",
    "- If mode is docker-only, disable scaffold generation.",
    "- If mode includes scaffolding, choose a realistic scaffold kind and output directory.",
    "- Prefer adapting a source when one is available.",
  ].join("\n\n");
}

function appFromBlueprint(blueprint: Awaited<ReturnType<typeof AppBlueprintSchema.parseAsync>>): GeneratedApp {
  return {
    id: blueprint.id,
    name: blueprint.name,
    description: blueprint.description,
    category: blueprint.category,
    services: blueprint.services,
    env: blueprint.env,
  };
}

/** Convert a pre-built blueprint (from the interactive chat flow) into a full AppBlueprint. */
function blueprintFromPreBuilt(
  preBuilt: NonNullable<CreatorRequest["preBuiltBlueprint"]>,
  description: string,
  mode: string,
  sources: ReturnType<typeof discoverSources>,
  talomeReferences: Awaited<ReturnType<typeof loadTalomeReferenceSnapshots>>,
  instructionsVersion: string,
): AppBlueprint {
  const id = preBuilt.identity?.id || preBuilt.identity?.name?.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "") || "custom-app";
  const name = preBuilt.identity?.name || "Custom App";
  const desc = preBuilt.identity?.description || description;
  const category = preBuilt.identity?.category || "other";
  const scaffoldEnabled = mode !== "docker-only" && (preBuilt.scaffold?.enabled ?? mode !== "docker-only");
  const scaffoldKind = preBuilt.scaffold?.kind || (scaffoldEnabled ? "full-stack" : "none");
  const fallbackUseCaseId = "primary-job";
  const research = preBuilt.research ?? {
    useCases: [
      {
        id: fallbackUseCaseId,
        title: `Use ${name}`,
        userGoal: desc,
        outcome: `Complete the primary ${name} workflow without leaving Talome.`,
        frequency: "weekly" as const,
      },
    ],
    githubQueries: [`${name} open source self hosted`],
    patternQuestions: [
      `Which screen pattern makes the primary ${name} workflow fastest?`,
      "Which empty, loading, error, and compact-window states are required?",
    ],
    libraryNeeds: [],
  };
  const experienceDesign = preBuilt.experienceDesign ?? {
    primaryUseCaseId: research.useCases[0]?.id ?? fallbackUseCaseId,
    workflows: [
      {
        id: "primary-workflow",
        name: `Primary ${name} workflow`,
        useCaseId: research.useCases[0]?.id ?? fallbackUseCaseId,
        outcome: research.useCases[0]?.outcome ?? desc,
        steps: ["Open the app", "Complete the primary action", "Review the resulting state"],
      },
    ],
    screens: (preBuilt.appSpec?.surfaces.length
      ? preBuilt.appSpec.surfaces
      : [{ id: "overview", title: "Overview", blocks: [] }]
    ).map((surface) => ({
      id: surface.id,
      name: surface.title,
      useCaseIds: [research.useCases[0]?.id ?? fallbackUseCaseId],
      job: `Support the ${research.useCases[0]?.title ?? "primary"} use case.`,
      primaryAction: "Complete the most important action for this surface.",
      pattern: "Talome native task surface",
      componentCandidates: Array.from(new Set(surface.blocks.map((block) => block.component))),
      states: ["default", "loading", "empty", "error", "compact-window"],
    })),
    visualDirection: {
      mode: "native-system" as const,
      summary: "A calm, task-first Talome-native experience with one clear focal action per surface.",
      layout: "Use the native AppSpec surface and responsive desktop-window layout.",
      signatureElements: ["large app icon", "semantic Talome tokens", "purposeful data visualization"],
      motion: ["restrained state transitions", "respect reduced-motion preferences"],
    },
  };

  return {
    id,
    name,
    description: desc,
    prompt: description,
    icon: preBuilt.identity?.icon,
    category,
    sourceReferences: sources,
    research,
    experienceDesign,
    services: preBuilt.services || [],
    env: preBuilt.env || [],
    scaffold: {
      enabled: scaffoldEnabled,
      kind: scaffoldKind as any,
      framework: preBuilt.scaffold?.framework || "next.js",
      runtime: "node",
      packageManager: "pnpm",
      outputDir: "generated-app",
      entryFiles: [],
    },
    ui: {
      surfaces: preBuilt.appSpec?.surfaces.map((surface) => surface.id) ?? ["overview"],
      preferredBlocks: preBuilt.appSpec
        ? Array.from(new Set(preBuilt.appSpec.surfaces.flatMap((surface) => surface.blocks.map((block) => block.component))))
        : ["stat", "markdown", "actions"],
      designConstraints: [
        "Render through the native Talome AppSpec runtime.",
        "Use semantic Talome tokens and approved component contracts only.",
      ],
      references: talomeReferences.map((ref) => ({
        title: ref.title,
        path: ref.relativePath,
        reason: ref.reason,
      })),
    },
    appSpec: preBuilt.appSpec ?? createDefaultAppSpec({
      appId: id,
      name,
      description: desc,
      icon: preBuilt.identity?.icon,
    }),
    successCriteria: preBuilt.criteria || [],
    designAlignment: {
      summary: "Follow Talome design conventions — dark mode, consistent spacing, shadcn/ui components.",
      referencePaths: talomeReferences.map((ref) => ref.relativePath),
      notes: [],
    },
    instructionsVersion,
  };
}

export async function generateCreatorDraft(
  request: CreatorRequest,
  apiKey?: string,
  options: { workspaceRoot?: string; abortSignal?: AbortSignal; maxOutputTokens?: number; maxRetries?: number } = {},
): Promise<CreatorDraft> {
  const instructionPack = await loadInstructionPack();
  const talomeReferences = await loadTalomeReferenceSnapshots();
  const sources = discoverSources(request.description, request.source);

  let blueprint;
  let blueprintOrigin = "Pre-built blueprint supplied by the caller";

  if (request.preBuiltBlueprint?.identity?.name && request.preBuiltBlueprint?.services?.length) {
    // Use the pre-built blueprint from the interactive chat — skip AI generation
    blueprint = blueprintFromPreBuilt(
      request.preBuiltBlueprint,
      request.description,
      request.mode,
      sources,
      talomeReferences,
      instructionPack.summary.version,
    );
  } else {
    // Generate blueprint via AI
    const configured = getCreatorModel(apiKey);
    blueprintOrigin = `Model-generated with ${configured.provider}/${configured.modelId}`;
    const normalizedPaths: string[] = [];
    const { object } = await generateObject({
      model: configured.model,
      // The shared contract contains optional fields and open data payloads.
      // OpenAI strict JSON schema rejects those; generateObject still validates
      // the returned object against AppBlueprintSchema before any workspace write.
      ...(configured.provider === "openai" ? { providerOptions: { openai: { strictJsonSchema: false } } } : {}),
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
      ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}),
      ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
      schema: AppBlueprintSchema,
      experimental_repairText: async ({ text }) => {
        const repaired = repairCreatorBlueprint(text);
        if (repaired) normalizedPaths.push(...repaired.removedPaths);
        return repaired?.text ?? null;
      },
      prompt: buildBlueprintPrompt(
        request,
        renderInstructionPack(instructionPack),
        renderSourceContext(sources),
        talomeReferences,
      ),
    });

    if (normalizedPaths.length) blueprintOrigin += `; normalized unused empty currency metadata at ${normalizedPaths.join(", ")}`;

    const generatedSpec = object.appSpec
      ? TalomeAppSpecSchema.parse({
          ...object.appSpec,
          appId: object.id,
          name: object.name,
          description: object.description,
          icon: object.icon ?? object.appSpec.icon,
        })
      : createDefaultAppSpec({
          appId: object.id,
          name: object.name,
          description: object.description,
          icon: object.icon,
        });

    blueprint = {
      ...object,
      sourceReferences: sources,
      scaffold: {
        ...object.scaffold,
        enabled: request.mode !== "docker-only",
        kind: request.mode === "docker-only" ? "none" : object.scaffold.kind,
        outputDir: object.scaffold.outputDir || "generated-app",
      },
      instructionsVersion: instructionPack.summary.version,
      designAlignment: {
        ...object.designAlignment,
        referencePaths:
          object.designAlignment.referencePaths.length > 0
            ? object.designAlignment.referencePaths
            : talomeReferences.map((reference) => reference.relativePath),
      },
      ui: {
        ...object.ui,
        references:
          object.ui.references.length > 0
            ? object.ui.references
            : talomeReferences.map((reference) => ({
                title: reference.title,
                path: reference.relativePath,
                reason: reference.reason,
              })),
      },
      appSpec: generatedSpec,
    };
  }

  const app = appFromBlueprint(blueprint);
  let workspace: CreatorDraft["workspace"] | undefined;
  let validations: ValidationCheck[] = [
    {
      id: "blueprint",
      label: "Blueprint generated",
      status: "passed",
      details: `${blueprintOrigin}; instruction pack ${instructionPack.summary.version}`,
    },
    {
      id: "source-selection",
      label: "Source discovery completed",
      status: sources.length > 0 ? "passed" : "skipped",
      details: sources.length > 0 ? `${sources.length} source reference(s)` : "No reusable source discovered",
    },
    {
      id: "research-plan",
      label: "Use-case research planned",
      status:
        blueprint.research.useCases.length > 0 && blueprint.research.githubQueries.length > 0
          ? "passed"
          : "failed",
      details: `${blueprint.research.useCases.length} use case(s), ${blueprint.research.githubQueries.length} GitHub query plan(s)`,
    },
    {
      id: "screen-plan",
      label: "Use cases mapped to screens",
      status:
        blueprint.experienceDesign.workflows.length > 0 && blueprint.experienceDesign.screens.length > 0
          ? "passed"
          : "failed",
      details: `${blueprint.experienceDesign.workflows.length} workflow(s), ${blueprint.experienceDesign.screens.length} screen(s)`,
    },
  ];

  let taskPrompt: string | undefined;

  if (blueprint.scaffold.enabled) {
    const prepared = await prepareWorkspace({
      app,
      blueprint,
      sources,
      instructionPack,
      talomeReferences,
      userDescription: request.description,
      workspaceRoot: options.workspaceRoot,
    });
    taskPrompt = prepared.taskPrompt;
    workspace = {
      appId: app.id,
      rootPath: prepared.workspaceRoot,
      scaffoldPath: prepared.scaffoldPath,
      fileCount: 0,
      entryFiles: [],
      sourceSnapshots: prepared.sourceSnapshots.map((p) => p.replace(`${prepared.workspaceRoot}/`, "")),
      designArtifacts: prepared.designArtifacts.map((p) => p.replace(`${prepared.workspaceRoot}/`, "")),
      generatedWithClaudeCode: false,
    };
  }

  const draft: CreatorDraft = {
    app, blueprint, sources, validations,
    instructionPack: instructionPack.summary, workspace, taskPrompt,
    createdAt: new Date().toISOString(),
  };
  if (workspace) {
    writeFileSync(join(workspace.rootPath, ".talome-creator", "creator-draft.json"), JSON.stringify(draft, null, 2), { mode: 0o600 });
  }
  return draft;
}

export async function publishCreatorDraft(
  draft: CreatorDraft,
  overrides?: {
    id?: string;
    name?: string;
    description?: string;
    category?: GeneratedApp["category"];
  },
) {
  const app = {
    ...draft.app,
    ...overrides,
  };

  if (draft.blueprint.scaffold.enabled && !draft.workspace) {
    throw new Error("Scaffold-enabled drafts require a completed generated workspace before publishing.");
  }

  // Both interactive and headless generation can refine the original contract.
  // Resolve the artifact again at publication so a stale caller cannot erase new actions.
  let appSpec = draft.blueprint.appSpec;
  const specPath = draft.workspace?.scaffoldPath
    ? join(draft.workspace.scaffoldPath, "talome-app.json")
    : undefined;
  if (specPath && existsSync(specPath)) {
    const generatedSpec = TalomeAppSpecSchema.parse(JSON.parse(readFileSync(specPath, "utf-8")));
    if (generatedSpec.appId !== draft.app.id) throw new Error(`AppSpec appId must be ${draft.app.id}.`);
    appSpec = generatedSpec;
  }

  // Browser evidence is produced here, never accepted from caller-authored draft metadata.
  let validations = draft.validations.filter((check) => !["native-browser", "app-runtime"].includes(check.id) && !check.evidencePath && !check.scope);
  let validatedScaffoldPath: string | undefined;
  if (draft.workspace) {
    validatedScaffoldPath = await snapshotGeneratedWorkspace(draft.workspace.scaffoldPath);
    const snapshotSpecPath = join(validatedScaffoldPath, "talome-app.json");
    if (existsSync(snapshotSpecPath)) {
      appSpec = TalomeAppSpecSchema.parse(JSON.parse(readFileSync(snapshotSpecPath, "utf-8")));
      if (appSpec.appId !== draft.app.id) throw new Error(`AppSpec appId must be ${draft.app.id}.`);
    }
    if (appSpec) {
      const retarget = <T extends { kind: string; appId?: string; path?: string }>(item: T): T => ({
        ...item,
        ...(item.kind === "app-api" && item.appId === draft.app.id ? { appId: app.id } : {}),
        ...(item.kind === "talome-api" && item.path ? { path: item.path.replace(`/api/apps/user-apps/${encodeURIComponent(draft.app.id)}`, `/api/apps/user-apps/${encodeURIComponent(app.id)}`) } : {}),
      });
      appSpec = TalomeAppSpecSchema.parse({ ...appSpec, appId: app.id, name: app.name, description: app.description, actions: appSpec.actions.map(retarget), dataSources: appSpec.dataSources.map(retarget) });
      writeFileSync(snapshotSpecPath, JSON.stringify(appSpec, null, 2));
    }
    const manifestPath = join(validatedScaffoldPath, "manifest.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      writeFileSync(manifestPath, JSON.stringify({ ...manifest, id: app.id, name: app.name, description: app.description, category: app.category }, null, 2));
    }
    appSpec = preparePublicationContract(validatedScaffoldPath, app.id, appSpec);
    const files = await listGeneratedFiles(validatedScaffoldPath);
    const hasImplementation = hasGeneratedImplementation(files);
    if (draft.blueprint.scaffold.enabled && !hasImplementation) {
      throw new Error("Scaffold-enabled drafts require generated application source or assets beyond deployment metadata before publishing.");
    }
    const current = hasImplementation || draft.workspace.generatedWithClaudeCode
      ? await validateGeneratedApp(validatedScaffoldPath, app.id, { ...draft.blueprint, appSpec })
      : { appSpec, validations: appSpec ? await validateNativeAppInBrowser(validatedScaffoldPath, appSpec) : [] };
    if (draft.blueprint.scaffold.enabled) current.validations.push(...await validateDesignArtifacts(draft.workspace.rootPath));
    const failures = current.validations.filter((check) => check.status === "failed");
    if (failures.length) throw new Error(failures.map((check) => check.details || check.label).join("; "));
    appSpec = current.appSpec ?? appSpec;
    const currentIds = new Set(current.validations.map((check) => check.id));
    validations = [...validations.filter((check) => !currentIds.has(check.id)), ...current.validations];
  } else if (appSpec) {
    appSpec = TalomeAppSpecSchema.parse({ ...appSpec, appId: app.id, name: app.name, description: app.description });
    validatedScaffoldPath = await snapshotNativeContract(appSpec);
    appSpec = preparePublicationContract(validatedScaffoldPath, app.id, appSpec)!;
    const checks = await validateNativeAppInBrowser(validatedScaffoldPath, appSpec);
    const failures = checks.filter((check) => check.status === "failed");
    if (failures.length) throw new Error(failures.map((check) => check.details || check.label).join("; "));
    validations.push(...checks);
  }

  return createUserApp({
    id: app.id,
    name: app.name,
    description: app.description,
    category: app.category,
    services: app.services,
    env: app.env,
    creator: {
      blueprint: {
        ...draft.blueprint,
        appSpec,
        id: app.id,
        name: app.name,
        description: app.description,
        category: app.category,
      },
      sources: draft.sources,
      validations,
      instructionPack: draft.instructionPack,
      workspace: draft.workspace,
      createdAt: draft.createdAt,
    },
  }, validatedScaffoldPath ? { validatedScaffoldPath } : undefined);
}
