import { tool, type Tool, jsonSchema } from "ai";
import { z } from "zod";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { writeAuditEntry } from "../db/audit.js";

const CUSTOM_TOOLS_DIR = join(
  process.env.HOME || "/tmp",
  ".talome",
  "custom-tools",
);

const CORE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
  alias: {
    ai: resolve(CORE_ROOT, "node_modules", "ai"),
    zod: resolve(CORE_ROOT, "node_modules", "zod"),
  },
});

type LoadedTools = Record<string, Tool<any, any>>;

let _loaded: LoadedTools = {};

// Built-in tool name set — custom tools cannot shadow these
let _builtinNames: Set<string> = new Set();

export function setBuiltinToolNames(names: string[]): void {
  _builtinNames = new Set(names);
}

async function ensureDir() {
  if (!existsSync(CUSTOM_TOOLS_DIR)) {
    await mkdir(CUSTOM_TOOLS_DIR, { recursive: true });
  }
}

// ── Basic TypeScript syntax validation (no execution) ────────────────────────

function validateTypeScriptSyntax(code: string): { ok: boolean; error?: string } {
  const checks: Array<[RegExp, string]> = [
    [/export\s+(default\s+)?const\s+\w+\s*=\s*tool\(/, "No tool() exports found"],
    [/import.*from\s+['"]ai['"]/, "Missing import from 'ai'"],
  ];

  for (const [pattern, msg] of checks) {
    if (!pattern.test(code)) {
      return { ok: false, error: `Validation failed: ${msg}` };
    }
  }

  const dangerous: Array<[RegExp, string]> = [
    [/process\.exit/, "process.exit() not allowed in custom tools"],
    [/require\s*\(\s*['"]child_process['"]/, "child_process not allowed in custom tools"],
    [/from\s+['"]child_process['"]/, "child_process not allowed in custom tools"],
    [/require\s*\(\s*['"]fs['"]/, "direct fs access not allowed in custom tools"],
    [/from\s+['"]fs['"]/, "direct fs access not allowed in custom tools"],
    [/from\s+['"]node:fs['"]/, "direct fs access not allowed in custom tools"],
    [/from\s+['"]node:child_process['"]/, "child_process not allowed in custom tools"],
    [/eval\s*\(/, "eval() not allowed in custom tools"],
    [/Function\s*\(/, "Function constructor not allowed in custom tools"],
    [/globalThis\s*\[/, "Dynamic global access not allowed in custom tools"],
    [/__proto__/, "__proto__ access not allowed in custom tools"],
  ];

  for (const [pattern, msg] of dangerous) {
    if (pattern.test(code)) {
      return { ok: false, error: msg };
    }
  }

  return { ok: true };
}

export async function loadCustomTools(): Promise<LoadedTools> {
  await ensureDir();

  let files: string[];
  try {
    files = (await readdir(CUSTOM_TOOLS_DIR)).filter(
      (f) => f.endsWith(".ts") || f.endsWith(".js"),
    );
  } catch {
    return {};
  }

  const tools: LoadedTools = {};

  for (const file of files) {
    const fullPath = join(CUSTOM_TOOLS_DIR, file);
    try {
      const mod = await jiti.import(fullPath) as Record<string, unknown>;
      for (const [key, value] of Object.entries(mod)) {
        if (
          value &&
          typeof value === "object" &&
          "execute" in value &&
          ("parameters" in value || "inputSchema" in value)
        ) {
          const toolName = `custom_${key}`;

          // Prevent shadowing built-in tools
          const bareKey = key.replace(/^custom_/, "");
          if (_builtinNames.has(bareKey) || _builtinNames.has(toolName)) {
            console.warn(`[custom-tools] Tool "${key}" in ${file} would shadow a built-in tool — skipping`);
            continue;
          }

          const raw = value as Record<string, unknown>;

          if (raw.parameters && typeof raw.parameters === "object") {
            try {
              const converted = z.toJSONSchema(raw.parameters as z.ZodType);
              const { $schema, ...rest } = converted as Record<string, unknown>;
              tools[toolName] = {
                description: String(raw.description || ""),
                inputSchema: jsonSchema(rest as Record<string, unknown>),
                execute: raw.execute,
              } as unknown as Tool<any, any>;
            } catch {
              console.error(`[custom-tools] Schema conversion failed for ${key} in ${file}`);
            }
          } else {
            tools[toolName] = value as unknown as Tool<any, any>;
          }
        }
      }
    } catch (err) {
      console.error(`[custom-tools] Failed to load ${file}:`, err);
    }
  }

  _loaded = tools;
  return tools;
}

export function getCustomTools(): LoadedTools {
  return _loaded;
}

// ── create_tool ──────────────────────────────────────────────────────────────

export const createToolTool = tool({
  description: `Create a new custom AI tool by writing a TypeScript file to ~/.talome/custom-tools/. The file should export one or more Vercel AI SDK tool() definitions. After creating, use reload_tools to activate it. Validates syntax before writing.`,
  inputSchema: z.object({
    filename: z
      .string()
      .describe("Filename (e.g. 'weather.ts'). Must end in .ts"),
    code: z
      .string()
      .describe(
        "TypeScript source code. Must export tool() definitions from 'ai' package.",
      ),
  }),
  execute: async ({ filename, code }) => {
    if (!filename.endsWith(".ts")) {
      return { error: "Filename must end in .ts" };
    }
    // Strict filename validation: only lowercase alphanumeric, hyphens, underscores
    if (!/^[a-z0-9_-]+\.ts$/.test(filename)) {
      return { error: "Filename must contain only lowercase letters, numbers, hyphens, and underscores (e.g. 'my-tool.ts')" };
    }

    // Validate syntax before writing
    const validation = validateTypeScriptSyntax(code);
    if (!validation.ok) {
      return {
        error: `Syntax validation failed: ${validation.error}`,
        hint: "Fix the issue above and try again.",
      };
    }

    try {
      await ensureDir();
      const dest = join(CUSTOM_TOOLS_DIR, filename);
      await writeFile(dest, code, "utf-8");
      writeAuditEntry("AI: create_tool", "modify", filename);
      return {
        path: dest,
        filename,
        hint: "Use reload_tools to activate this tool.",
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg };
    }
  },
});

// ── reload_tools ─────────────────────────────────────────────────────────────

export const reloadToolsTool = tool({
  description:
    "Reload all custom tools from ~/.talome/custom-tools/. Call this after create_tool to activate new tools.",
  inputSchema: z.object({}),
  execute: async () => {
    try {
      const tools = await loadCustomTools();
      const names = Object.keys(tools);
      writeAuditEntry("AI: reload_tools", "modify", `Loaded: ${names.join(", ") || "(none)"}`);
      return {
        loaded: names,
        count: names.length,
        directory: CUSTOM_TOOLS_DIR,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg };
    }
  },
});

// ── list_custom_tools ────────────────────────────────────────────────────────

export const listCustomToolsTool = tool({
  description:
    "List all custom tool files in ~/.talome/custom-tools/ and the tool names they export.",
  inputSchema: z.object({}),
  execute: async () => {
    await ensureDir();
    try {
      const files = (await readdir(CUSTOM_TOOLS_DIR)).filter(
        (f) => f.endsWith(".ts") || f.endsWith(".js"),
      );

      const result: { file: string; preview: string }[] = [];
      for (const file of files) {
        const content = await readFile(join(CUSTOM_TOOLS_DIR, file), "utf-8");
        const preview = content.slice(0, 200);
        result.push({ file, preview });
      }

      const loaded = Object.keys(_loaded);

      return {
        files: result,
        activeTools: loaded,
        directory: CUSTOM_TOOLS_DIR,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg };
    }
  },
});
