import { tool } from "ai";
import { z } from "zod";
import {
  executeAppSpecAction,
  getStoredAppSpec,
  listStoredAppSpecs,
} from "../../app-specs/service.js";

function resolveStoredSpec(appId: string, storeId?: string) {
  if (storeId) return getStoredAppSpec(storeId, appId);
  const matches = listStoredAppSpecs().filter((stored) => stored.appId === appId);
  if (matches.length > 1) {
    throw new Error(`Multiple native apps use '${appId}'. Provide storeId.`);
  }
  return matches[0] ?? null;
}

export const listNativeAppsTool = tool({
  description: "List approved Talome-native AppSpec applications and their assistant-visible capabilities.",
  inputSchema: z.object({}),
  execute: async () => listStoredAppSpecs().map((stored) => ({
    appId: stored.appId,
    storeId: stored.storeId,
    name: stored.spec.name,
    description: stored.spec.description,
    revision: stored.revision,
    surfaces: stored.spec.surfaces.map((surface) => surface.title),
    actions: stored.spec.actions
      .filter((action) => stored.spec.assistant.exposedActions.includes(action.id))
      .map((action) => ({ id: action.id, label: action.label, description: action.description })),
  })),
});

export const inspectNativeAppTool = tool({
  description: "Inspect a Talome-native application's surfaces, components, assistant context, and exposed actions.",
  inputSchema: z.object({
    appId: z.string().min(1),
    storeId: z.string().optional(),
  }),
  execute: async ({ appId, storeId }) => {
    const stored = resolveStoredSpec(appId, storeId);
    if (!stored) return { success: false, error: "native_app_not_found" };
    const exposed = new Set(stored.spec.assistant.exposedActions);
    return {
      success: true,
      appId: stored.appId,
      storeId: stored.storeId,
      name: stored.spec.name,
      description: stored.spec.description,
      revision: stored.revision,
      context: stored.spec.assistant.context,
      suggestions: stored.spec.assistant.suggestions,
      surfaces: stored.spec.surfaces.map((surface) => ({
        id: surface.id,
        title: surface.title,
        layout: surface.layout,
        components: surface.blocks.map((block) => ({
          id: block.id,
          component: block.component,
          title: block.title,
        })),
      })),
      actions: stored.spec.actions
        .filter((action) => exposed.has(action.id))
        .map((action) => ({
          id: action.id,
          label: action.label,
          description: action.description,
          confirmation: "confirmation" in action ? action.confirmation : undefined,
          inputs: action.input ?? [],
        })),
    };
  },
});

export const runNativeAppActionTool = tool({
  description: "Run an action explicitly exposed by a Talome-native application. Inspect the app first to discover allowed actions and required inputs.",
  inputSchema: z.object({
    appId: z.string().min(1),
    storeId: z.string().optional(),
    actionId: z.string().min(1),
    values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
    confirmed: z.boolean().default(false),
  }),
  execute: async ({ appId, storeId, actionId, values, confirmed }) => {
    const stored = resolveStoredSpec(appId, storeId);
    if (!stored) return { success: false, error: "native_app_not_found" };
    if (!stored.spec.assistant.exposedActions.includes(actionId)) {
      return { success: false, error: "action_not_exposed_to_assistant" };
    }
    try {
      return await executeAppSpecAction({
        storeId: stored.storeId,
        appId: stored.appId,
        actionId,
        values,
        confirmed,
        trusted: true,
      });
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
});
