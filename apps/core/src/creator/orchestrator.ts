import { generateObject } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
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
import { prepareWorkspace } from "./workspace-executor.js";

function summarizeReferenceContent(content: string): string {
  return content.split("\n").slice(0, 40).join("\n").slice(0, 1800);
}

export function getAnthropicApiKey(): string | undefined {
  try {
    const row = db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, "anthropic_key"))
      .get();
    return row?.value || process.env.ANTHROPIC_API_KEY;
  } catch {
    return process.env.ANTHROPIC_API_KEY;
  }
}

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
  apiKey: string,
): Promise<CreatorDraft> {
  const instructionPack = await loadInstructionPack();
  const talomeReferences = await loadTalomeReferenceSnapshots();
  const sources = discoverSources(request.description, request.source);

  let blueprint;

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
    const anthropic = createAnthropic({ apiKey });
    const { object } = await generateObject({
      model: anthropic("claude-sonnet-4-20250514"),
      schema: AppBlueprintSchema,
      prompt: buildBlueprintPrompt(
        request,
        renderInstructionPack(instructionPack),
        renderSourceContext(sources),
        talomeReferences,
      ),
    });

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
      details: `Instruction pack ${instructionPack.summary.version}`,
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

  return {
    app,
    blueprint,
    sources,
    validations,
    instructionPack: instructionPack.summary,
    workspace,
    taskPrompt,
    createdAt: new Date().toISOString(),
  };
}

export function publishCreatorDraft(
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
        id: app.id,
        name: app.name,
        description: app.description,
        category: app.category,
      },
      sources: draft.sources,
      validations: draft.validations,
      instructionPack: draft.instructionPack,
      workspace: draft.workspace,
      createdAt: draft.createdAt,
    },
  });
}
