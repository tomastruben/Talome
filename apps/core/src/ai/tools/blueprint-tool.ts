import { tool } from "ai";
import { z } from "zod";
import { AppCategorySchema } from "../../creator/contracts.js";
import { listContainers } from "../../docker/client.js";

const blueprintInputSchema = z.object({
  section: z.enum(["identity", "services", "env", "scaffold", "criteria"]),
  id: z.string().optional().describe("Kebab-case app ID (for identity section)"),
  name: z.string().optional().describe("Human-readable app name (for identity section)"),
  description: z.string().optional().describe("One clear sentence (for identity section)"),
  category: AppCategorySchema.optional(),
  icon: z.string().optional().describe("Single emoji representing the app (for identity section)"),
  services: z.array(
    z.object({
      name: z.string(),
      image: z.string(),
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
    "Design or refine an app blueprint for creating a new self-hosted application. Call this when the user wants to create, build, or set up a new app. Each call populates one section (identity, services, env, scaffold, criteria) of the blueprint that the user sees in a draft bar above the chat input. Call multiple times to build out the full blueprint iteratively. The response includes system context (running containers, used ports) so you can avoid conflicts.",
  inputSchema: blueprintInputSchema,
  execute: async (input: z.infer<typeof blueprintInputSchema>) => {
    const systemContext = await getSystemContext();
    return { applied: true, ...input, systemContext };
  },
});
