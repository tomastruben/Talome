import { z } from "zod";
import {
  TALOME_APP_SPEC_VERSION,
  TALOME_COMPONENT_IDS,
  type TalomeAppSpec,
} from "@talome/types";

const idSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/, "Use a stable alphanumeric ID");

const pathSchema = z
  .string()
  .min(1)
  .max(2048)
  .startsWith("/")
  .refine((value) => !value.includes("://") && !value.includes(".."), {
    message: "Paths must be relative API paths",
  });

const valuePathSchema = z.string().min(1).max(256);
const formatSchema = z.enum([
  "text",
  "number",
  "currency",
  "percent",
  "bytes",
  "date",
  "relative-time",
]);

const assistantSuggestionSchema = z.object({
  label: z.string().min(1).max(64),
  prompt: z.string().min(1).max(1000),
});

const actionInputSchema = z.object({
  id: idSchema,
  label: z.string().min(1).max(64),
  type: z.enum(["string", "number", "boolean"]),
  required: z.boolean().optional(),
  description: z.string().max(240).optional(),
});

const appActionSchema = z.discriminatedUnion("kind", [
  z.object({
    id: idSchema,
    label: z.string().min(1).max(64),
    description: z.string().min(1).max(240),
    kind: z.literal("assistant"),
    prompt: z.string().min(1).max(2000),
    input: z.array(actionInputSchema).max(12).optional(),
  }),
  z.object({
    id: idSchema,
    label: z.string().min(1).max(64),
    description: z.string().min(1).max(240),
    kind: z.literal("talome-api"),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    path: pathSchema,
    bodyTemplate: z.unknown().optional(),
    input: z.array(actionInputSchema).max(12).optional(),
    confirmation: z.string().max(240).optional(),
    destructive: z.boolean().optional(),
  }),
  z.object({
    id: idSchema,
    label: z.string().min(1).max(64),
    description: z.string().min(1).max(240),
    kind: z.literal("app-api"),
    appId: idSchema,
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    path: pathSchema,
    bodyTemplate: z.unknown().optional(),
    input: z.array(actionInputSchema).max(12).optional(),
    confirmation: z.string().max(240).optional(),
    destructive: z.boolean().optional(),
  }),
]);

const dataSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    id: idSchema,
    kind: z.literal("static"),
    value: z.unknown(),
  }),
  z.object({
    id: idSchema,
    kind: z.literal("talome-api"),
    path: pathSchema,
    refreshMs: z.number().int().min(2_000).max(3_600_000).optional(),
  }),
  z.object({
    id: idSchema,
    kind: z.literal("app-api"),
    appId: idSchema,
    path: pathSchema,
    refreshMs: z.number().int().min(2_000).max(3_600_000).optional(),
  }),
]);

const blockBase = {
  id: idSchema,
  title: z.string().min(1).max(96),
  description: z.string().max(240).optional(),
  icon: idSchema.optional(),
  span: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
};

const appBlockSchema = z.discriminatedUnion("component", [
  z.object({
    ...blockBase,
    component: z.literal("stat"),
    dataSource: idSchema,
    valuePath: valuePathSchema,
    format: formatSchema.optional(),
    currency: z.string().length(3).optional(),
    detailPath: valuePathSchema.optional(),
    emphasis: z.enum(["hero", "supporting"]).optional(),
    progressValuePath: valuePathSchema.optional(),
    progressMaxPath: valuePathSchema.optional(),
    progressDetailPath: valuePathSchema.optional(),
  }),
  z.object({
    ...blockBase,
    component: z.literal("list"),
    dataSource: idSchema,
    itemsPath: valuePathSchema.optional(),
    titlePath: valuePathSchema,
    descriptionPath: valuePathSchema.optional(),
    metaPath: valuePathSchema.optional(),
    statusPath: valuePathSchema.optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  z.object({
    ...blockBase,
    component: z.literal("table"),
    dataSource: idSchema,
    rowsPath: valuePathSchema.optional(),
    columns: z.array(z.object({
      id: idSchema,
      label: z.string().min(1).max(64),
      path: valuePathSchema,
      format: formatSchema.optional(),
      currency: z.string().length(3).optional(),
    })).min(1).max(12),
    limit: z.number().int().min(1).max(250).optional(),
  }),
  z.object({
    ...blockBase,
    component: z.literal("progress"),
    dataSource: idSchema,
    valuePath: valuePathSchema,
    maxPath: valuePathSchema.optional(),
    max: z.number().positive().optional(),
    valueFormat: formatSchema.optional(),
    currency: z.string().length(3).optional(),
  }),
  z.object({
    ...blockBase,
    component: z.literal("time-series"),
    dataSource: idSchema,
    rowsPath: valuePathSchema.optional(),
    xPath: valuePathSchema,
    series: z.array(z.object({
      id: idSchema,
      label: z.string().min(1).max(64),
      valuePath: valuePathSchema,
    })).min(1).max(6),
    variant: z.enum(["line", "area"]).optional(),
    valueFormat: formatSchema.optional(),
    currency: z.string().length(3).optional(),
    limit: z.number().int().min(2).max(500).optional(),
  }),
  z.object({
    ...blockBase,
    component: z.literal("budget-overview"),
    dataSource: idSchema,
    currency: z.string().length(3).optional(),
    reviewActionId: idSchema.optional(),
  }),
  z.object({
    ...blockBase,
    component: z.literal("comparison-bars"),
    dataSource: idSchema,
    rowsPath: valuePathSchema.optional(),
    labelPath: valuePathSchema,
    plannedPath: valuePathSchema,
    actualPath: valuePathSchema,
    remainingPath: valuePathSchema.optional(),
    statusPath: valuePathSchema.optional(),
    plannedTotalPath: valuePathSchema.optional(),
    actualTotalPath: valuePathSchema.optional(),
    remainingTotalPath: valuePathSchema.optional(),
    currency: z.string().length(3).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    actionId: idSchema.optional(),
    compact: z.boolean().optional(),
  }),
  z.object({
    ...blockBase,
    component: z.literal("activity-list"),
    dataSource: idSchema,
    rowsPath: valuePathSchema.optional(),
    datePath: valuePathSchema,
    titlePath: valuePathSchema,
    descriptionPath: valuePathSchema.optional(),
    kindPath: valuePathSchema.optional(),
    valuePath: valuePathSchema,
    valueFormat: formatSchema.optional(),
    currency: z.string().length(3).optional(),
    searchPaths: z.array(valuePathSchema).min(1).max(8).optional(),
    filterPath: valuePathSchema.optional(),
    filters: z.array(z.object({
      label: z.string().min(1).max(32),
      value: z.string().min(1).max(64),
    })).min(1).max(8).optional(),
    rowAction: z.object({
      actionId: idSchema,
      inputId: idSchema,
      valuePath: valuePathSchema,
    }).optional(),
    footerActionId: idSchema.optional(),
    starterFlagPath: valuePathSchema.optional(),
    limit: z.number().int().min(1).max(250).optional(),
    compact: z.boolean().optional(),
  }),
  z.object({
    ...blockBase,
    component: z.literal("markdown"),
    content: z.string().max(20_000).optional(),
    dataSource: idSchema.optional(),
    contentPath: valuePathSchema.optional(),
  }).refine((block) => Boolean(block.content || (block.dataSource && block.contentPath)), {
    message: "Markdown blocks need content or a data source/content path",
  }),
  z.object({
    ...blockBase,
    component: z.literal("actions"),
    actionIds: z.array(idSchema).min(1).max(12),
  }),
]);

export const TalomeAppSpecSchema = z.object({
  schemaVersion: z.literal(TALOME_APP_SPEC_VERSION),
  revision: z.number().int().positive(),
  appId: idSchema,
  name: z.string().min(1).max(128),
  description: z.string().min(1).max(1000),
  icon: z.string().max(128).optional(),
  assistant: z.object({
    context: z.string().min(1).max(4000),
    suggestions: z.array(assistantSuggestionSchema).max(8),
    exposedActions: z.array(idSchema).max(24),
  }),
  dataSources: z.array(dataSourceSchema).max(32),
  actions: z.array(appActionSchema).max(32),
  surfaces: z.array(z.object({
    id: idSchema,
    title: z.string().min(1).max(96),
    description: z.string().max(240).optional(),
    layout: z.enum(["dashboard", "list", "detail"]),
    primaryActionId: idSchema.optional(),
    blocks: z.array(appBlockSchema).min(1).max(40),
  })).min(1).max(12),
}).superRefine((spec, ctx) => {
  const dataSourceIds = new Set<string>();
  for (const [index, source] of spec.dataSources.entries()) {
    if (dataSourceIds.has(source.id)) {
      ctx.addIssue({ code: "custom", message: `Duplicate data source: ${source.id}`, path: ["dataSources", index, "id"] });
    }
    dataSourceIds.add(source.id);
  }

  const actionIds = new Set<string>();
  for (const [index, action] of spec.actions.entries()) {
    if (actionIds.has(action.id)) {
      ctx.addIssue({ code: "custom", message: `Duplicate action: ${action.id}`, path: ["actions", index, "id"] });
    }
    actionIds.add(action.id);
  }

  for (const [surfaceIndex, surface] of spec.surfaces.entries()) {
    for (const [blockIndex, block] of surface.blocks.entries()) {
      if ("dataSource" in block && block.dataSource && !dataSourceIds.has(block.dataSource)) {
        ctx.addIssue({
          code: "custom",
          message: `Unknown data source: ${block.dataSource}`,
          path: ["surfaces", surfaceIndex, "blocks", blockIndex, "dataSource"],
        });
      }
      if (block.component === "actions") {
        block.actionIds.forEach((actionId, actionIndex) => {
          if (!actionIds.has(actionId)) {
            ctx.addIssue({
              code: "custom",
              message: `Unknown action: ${actionId}`,
              path: ["surfaces", surfaceIndex, "blocks", blockIndex, "actionIds", actionIndex],
            });
          }
        });
      }
      if (block.component === "comparison-bars" && block.actionId && !actionIds.has(block.actionId)) {
        ctx.addIssue({
          code: "custom",
          message: `Unknown action: ${block.actionId}`,
          path: ["surfaces", surfaceIndex, "blocks", blockIndex, "actionId"],
        });
      }
      if (block.component === "budget-overview" && block.reviewActionId && !actionIds.has(block.reviewActionId)) {
        ctx.addIssue({
          code: "custom",
          message: `Unknown action: ${block.reviewActionId}`,
          path: ["surfaces", surfaceIndex, "blocks", blockIndex, "reviewActionId"],
        });
      }
      if (block.component === "activity-list") {
        const referencedActions = [block.rowAction?.actionId, block.footerActionId].filter(Boolean) as string[];
        for (const actionId of referencedActions) {
          if (!actionIds.has(actionId)) {
            ctx.addIssue({
              code: "custom",
              message: `Unknown action: ${actionId}`,
              path: ["surfaces", surfaceIndex, "blocks", blockIndex],
            });
          }
        }
      }
    }
    if (surface.primaryActionId && !actionIds.has(surface.primaryActionId)) {
      ctx.addIssue({
        code: "custom",
        message: `Unknown action: ${surface.primaryActionId}`,
        path: ["surfaces", surfaceIndex, "primaryActionId"],
      });
    }
  }

  spec.assistant.exposedActions.forEach((actionId, index) => {
    if (!actionIds.has(actionId)) {
      ctx.addIssue({ code: "custom", message: `Unknown action: ${actionId}`, path: ["assistant", "exposedActions", index] });
    }
  });
});

export function createDefaultAppSpec(input: {
  appId: string;
  storeId?: string;
  name: string;
  description: string;
  icon?: string;
}): TalomeAppSpec {
  const storeId = input.storeId ?? "user-apps";
  return TalomeAppSpecSchema.parse({
    schemaVersion: TALOME_APP_SPEC_VERSION,
    revision: 1,
    appId: input.appId,
    name: input.name,
    description: input.description,
    icon: input.icon,
    assistant: {
      context: `You are helping with ${input.name} (${input.appId}), a Talome-managed application. Use its declared actions and Talome tools; do not guess credentials or endpoints.`,
      suggestions: [
        { label: `Improve ${input.name}`, prompt: `Review ${input.name} and suggest the most useful next improvement.` },
        { label: "Check its health", prompt: `Check ${input.name}, explain its current health, and fix safe issues.` },
      ],
      exposedActions: ["inspect-with-assistant", "restart-service"],
    },
    dataSources: [
      {
        id: "app-status",
        kind: "talome-api",
        path: `/api/apps/${encodeURIComponent(storeId)}/${encodeURIComponent(input.appId)}`,
        refreshMs: 5_000,
      },
    ],
    actions: [
      {
        id: "inspect-with-assistant",
        label: "Ask Talome",
        description: "Open the assistant with this application's context and declared capabilities.",
        kind: "assistant",
        prompt: `Inspect ${input.name}, summarize its current state, and recommend the next best action.`,
      },
      {
        id: "restart-service",
        label: "Restart",
        description: "Restart the Talome-managed application.",
        kind: "talome-api",
        method: "POST",
        path: `/api/apps/${encodeURIComponent(storeId)}/${encodeURIComponent(input.appId)}/restart`,
        confirmation: `Restart ${input.name}?`,
      },
    ],
    surfaces: [
      {
        id: "overview",
        title: "Overview",
        description: input.description,
        layout: "dashboard",
        blocks: [
          {
            id: "about",
            title: "About",
            component: "markdown",
            content: input.description,
            span: 3,
          },
          {
            id: "status",
            title: "Status",
            component: "stat",
            dataSource: "app-status",
            valuePath: "installed.status",
            detailPath: "version",
            format: "text",
            span: 1,
          },
          {
            id: "quick-actions",
            title: "Actions",
            description: "Native Talome actions available to you and the assistant.",
            component: "actions",
            actionIds: ["inspect-with-assistant", "restart-service"],
            span: 4,
          },
        ],
      },
    ],
  });
}

export const talomeComponentRegistry = TALOME_COMPONENT_IDS.map((id) => ({
  id,
  contractVersion: TALOME_APP_SPEC_VERSION,
  renderer: "native" as const,
}));
