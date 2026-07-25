import { tool } from "ai";
import { z } from "zod";
import {
  AppCategorySchema,
  AppResearchPlanSchema,
  ExperienceDesignPlanSchema,
} from "../../creator/contracts.js";
import { TalomeAppSpecSchema, talomeComponentRegistry } from "../../app-specs/schema.js";
import { listContainers } from "../../docker/client.js";

const blueprintInputSchema = z.object({
  section: z.enum([
    "identity",
    "research",
    "design",
    "services",
    "env",
    "scaffold",
    "experience",
    "criteria",
  ]),
  id: z.string().optional().describe("Kebab-case app ID (for identity section)"),
  name: z.string().optional().describe("Human-readable app name (for identity section)"),
  description: z.string().optional().describe("One clear sentence (for identity section)"),
  category: AppCategorySchema.optional(),
  icon: z.string().optional().describe(
    "Single domain-specific emoji representing the app (for identity section). Never use a Wi-Fi emoji/icon unless the app itself manages real Wi-Fi or wireless networks.",
  ),
  research: AppResearchPlanSchema.optional().describe(
    "Use-case, GitHub query, screen-pattern question, and library-capability plan for the research section. Do not invent findings; the workspace research gate records evidence.",
  ),
  experienceDesign: ExperienceDesignPlanSchema.optional().describe(
    "Use-case workflows, screen jobs, primary actions, states, component candidates, and a committed visual direction for the design section.",
  ),
  services: z.array(
    z.object({
      name: z.string(),
      image: z.string().describe(
        "A verified existing image with a specific tag, or <app-id>:local for a custom service that the scaffold will build. Never invent a registry or image URL.",
      ),
      ports: z.array(z.object({ host: z.number(), container: z.number() })).default([]),
      volumes: z.array(z.object({ hostPath: z.string(), containerPath: z.string() })).default([]),
      environment: z.record(z.string(), z.string()).default({}),
      healthcheck: z
        .object({
          test: z.array(z.string()),
          interval: z.string().optional(),
          timeout: z.string().optional(),
          retries: z.number().optional(),
        })
        .optional(),
      resources: z
        .object({
          memory: z.string().optional(),
          cpus: z.string().optional(),
        })
        .optional(),
      dependsOn: z.array(z.string()).optional().describe("Service names this service depends on"),
    }),
  ).optional(),
  env: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      required: z.boolean(),
      default: z.string().optional(),
      secret: z.boolean().optional(),
    }),
  ).optional(),
  enabled: z.boolean().optional(),
  kind: z.enum(["none", "next-app", "service", "full-stack"]).optional(),
  framework: z.string().optional(),
  criteria: z.array(z.string()).optional(),
  appSpec: TalomeAppSpecSchema.optional().describe(
    "Complete native AppSpec v1 for the experience section. Use only registered components and explicitly expose safe assistant actions.",
  ),
});

/** Gather lightweight system context so the AI can avoid port conflicts and wire services. */
async function getSystemContext() {
  try {
    const containers = await listContainers();
    const usedPorts = new Set<number>();
    const runningServices: Array<{ name: string; image: string; ports: number[] }> = [];

    for (const c of containers) {
      for (const p of c.ports) {
        usedPorts.add(p.host);
      }
      if (c.status === "running") {
        runningServices.push({
          name: c.name,
          image: c.image,
          ports: c.ports.map((p) => p.host),
        });
      }
    }

    return {
      usedPorts: [...usedPorts].sort((a, b) => a - b),
      runningServices,
    };
  } catch {
    return { usedPorts: [], runningServices: [] };
  }
}

export const designAppBlueprintTool = tool({
  description:
    "Design or refine an app blueprint for a self-hosted application through explicit stages. Each call populates one section (identity, research, design, services, env, scaffold, experience, criteria). Research defines real use cases and evidence-gathering queries; design maps those use cases to workflows and screens; experience produces the native Talome AppSpec. Call multiple times to build the blueprint iteratively.",
  inputSchema: blueprintInputSchema,
  execute: async (input: z.infer<typeof blueprintInputSchema>) => {
    const systemContext = await getSystemContext();
    return {
      applied: true,
      ...input,
      systemContext,
      componentRegistry: talomeComponentRegistry,
    };
  },
});
