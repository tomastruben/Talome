import { z } from "zod";

export const AppCategorySchema = z.enum([
  "ai",
  "media",
  "productivity",
  "developer",
  "networking",
  "storage",
  "security",
  "other",
]);

export const PortMappingSchema = z.object({
  host: z.number().int().nonnegative(),
  container: z.number().int().nonnegative(),
});

export const VolumeMappingSchema = z.object({
  hostPath: z.string().min(1),
  containerPath: z.string().min(1),
});

export const EnvVarSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  required: z.boolean(),
  default: z.string().optional(),
  secret: z.boolean().optional(),
});

export const HealthcheckSchema = z.object({
  test: z.array(z.string()).min(1),
  interval: z.string().default("30s"),
  timeout: z.string().default("10s"),
  retries: z.number().int().positive().default(3),
});

export const ResourceLimitsSchema = z.object({
  memory: z.string().optional(),
  cpus: z.string().optional(),
});

export const DockerServiceSchema = z.object({
  name: z.string().min(1),
  image: z.string().min(1),
  ports: z.array(PortMappingSchema).default([]),
  volumes: z.array(VolumeMappingSchema).default([]),
  environment: z.record(z.string(), z.string()).default({}),
  healthcheck: HealthcheckSchema.optional(),
  resources: ResourceLimitsSchema.optional(),
});

export const GeneratedAppSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  category: AppCategorySchema,
  services: z.array(DockerServiceSchema).min(1),
  env: z.array(EnvVarSchema).default([]),
});

export const SourceInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("auto") }),
  z.object({ kind: z.literal("scratch") }),
  z.object({
    kind: z.literal("existing-store-app"),
    appId: z.string().optional(),
    storeId: z.string().optional(),
    query: z.string().optional(),
  }),
  z.object({
    kind: z.literal("public-repo"),
    repoUrl: z.string().url(),
    ref: z.string().optional(),
  }),
]);

export const SourceReferenceSchema = z.object({
  kind: z.enum(["existing-store-app", "public-repo", "public-doc", "auto-match"]),
  label: z.string().min(1),
  appId: z.string().optional(),
  storeId: z.string().optional(),
  repoUrl: z.string().optional(),
  ref: z.string().optional(),
  composePath: z.string().optional(),
  localPath: z.string().optional(),
  notes: z.string().optional(),
});

export const UiReferenceSchema = z.object({
  title: z.string().min(1),
  path: z.string().min(1),
  reason: z.string().min(1),
});

export const ScaffoldPlanSchema = z.object({
  enabled: z.boolean().default(true),
  kind: z.enum(["none", "next-app", "service", "full-stack"]).default("full-stack"),
  framework: z.string().default("next.js"),
  runtime: z.string().default("node"),
  packageManager: z.string().default("pnpm"),
  outputDir: z.string().default("generated-app"),
  entryFiles: z.array(z.string()).default([]),
});

export const DesignAlignmentSchema = z.object({
  summary: z.string().min(1),
  referencePaths: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([]),
});

export const AppBlueprintSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  prompt: z.string().min(1),
  icon: z.string().optional(),
  category: AppCategorySchema,
  sourceReferences: z.array(SourceReferenceSchema).default([]),
  services: z.array(DockerServiceSchema).min(1),
  env: z.array(EnvVarSchema).default([]),
  scaffold: ScaffoldPlanSchema,
  ui: z.object({
    surfaces: z.array(z.string()).default([]),
    preferredBlocks: z.array(z.string()).default([]),
    designConstraints: z.array(z.string()).default([]),
    references: z.array(UiReferenceSchema).default([]),
  }),
  successCriteria: z.array(z.string()).default([]),
  designAlignment: DesignAlignmentSchema,
  instructionsVersion: z.string().min(1),
});

export const ValidationCheckSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  status: z.enum(["passed", "failed", "skipped"]),
  details: z.string().optional(),
});

export const InstructionPackSummarySchema = z.object({
  version: z.string().min(1),
  hash: z.string().min(1),
  files: z.array(z.string()).default([]),
});

export const WorkspaceSummarySchema = z.object({
  appId: z.string().min(1),
  rootPath: z.string().min(1),
  scaffoldPath: z.string().min(1),
  fileCount: z.number().int().nonnegative(),
  entryFiles: z.array(z.string()).default([]),
  sourceSnapshots: z.array(z.string()).default([]),
  generatedWithClaudeCode: z.boolean(),
  runLogPath: z.string().optional(),
});

export const CreatorDraftSchema = z.object({
  app: GeneratedAppSchema,
  blueprint: AppBlueprintSchema,
  sources: z.array(SourceReferenceSchema).default([]),
  validations: z.array(ValidationCheckSchema).default([]),
  instructionPack: InstructionPackSummarySchema,
  workspace: WorkspaceSummarySchema.optional(),
  taskPrompt: z.string().optional(),
  createdAt: z.string().min(1),
});

/** Pre-built blueprint from the interactive design_app_blueprint flow. */
export const PreBuiltBlueprintSchema = z.object({
  identity: z.object({
    id: z.string().optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    category: AppCategorySchema.optional(),
    icon: z.string().optional(),
  }).optional(),
  services: z.array(DockerServiceSchema).optional(),
  env: z.array(EnvVarSchema).optional(),
  scaffold: z.object({
    enabled: z.boolean(),
    kind: z.string(),
    framework: z.string().optional(),
  }).optional(),
  criteria: z.array(z.string()).optional(),
});

export const CreatorRequestSchema = z.object({
  description: z.string().min(1),
  mode: z.enum(["docker-only", "full-app", "both"]).default("both"),
  saveImmediately: z.boolean().optional().default(false),
  source: SourceInputSchema.optional().default({ kind: "auto" }),
  /** Pass a pre-built blueprint to skip the AI blueprint generation step. */
  preBuiltBlueprint: PreBuiltBlueprintSchema.optional(),
});

export const PublishDraftRequestSchema = z.object({
  draft: CreatorDraftSchema,
  overrides: z
    .object({
      id: z.string().optional(),
      name: z.string().optional(),
      description: z.string().optional(),
      category: AppCategorySchema.optional(),
    })
    .optional(),
});

export type GeneratedApp = z.infer<typeof GeneratedAppSchema>;
export type SourceInput = z.infer<typeof SourceInputSchema>;
export type SourceReference = z.infer<typeof SourceReferenceSchema>;
export type AppBlueprint = z.infer<typeof AppBlueprintSchema>;
export type ValidationCheck = z.infer<typeof ValidationCheckSchema>;
export type InstructionPackSummary = z.infer<typeof InstructionPackSummarySchema>;
export type WorkspaceSummary = z.infer<typeof WorkspaceSummarySchema>;
export type CreatorDraft = z.infer<typeof CreatorDraftSchema>;
export type CreatorRequest = z.infer<typeof CreatorRequestSchema>;
