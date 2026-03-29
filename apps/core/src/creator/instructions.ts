import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { InstructionPackSummary } from "./contracts.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE_ROOT = resolve(__dirname, "../..");
const REPO_ROOT = resolve(CORE_ROOT, "../..");
const PROMPTS_DIR = resolve(CORE_ROOT, "prompts", "app-creation");

const TALOME_REFERENCE_FILES = [
  {
    title: "Cursor Rules",
    reason: "Project-wide design and component conventions",
    path: resolve(REPO_ROOT, ".cursor", "rules"),
  },
  {
    title: "Create App Page",
    reason: "Current app creation page layout and tone",
    path: resolve(REPO_ROOT, "apps", "dashboard", "src", "app", "dashboard", "apps", "create", "page.tsx"),
  },
  {
    title: "App Detail Page",
    reason: "Reference for app presentation and action structure",
    path: resolve(REPO_ROOT, "apps", "dashboard", "src", "app", "dashboard", "apps", "[storeId]", "[appId]", "page.tsx"),
  },
];

export interface InstructionPack {
  summary: InstructionPackSummary;
  documents: Record<string, string>;
}

export interface ReferenceSnapshot {
  title: string;
  reason: string;
  sourcePath: string;
  relativePath: string;
  content: string;
}

export async function loadInstructionPack(): Promise<InstructionPack> {
  const files = (await readdir(PROMPTS_DIR))
    .filter((name) => name.endsWith(".md"))
    .sort();

  const documents = Object.fromEntries(
    await Promise.all(
      files.map(async (file) => {
        const content = await readFile(resolve(PROMPTS_DIR, file), "utf-8");
        return [file, content] as const;
      }),
    ),
  );

  const combined = files.map((file) => `# ${file}\n${documents[file]}`).join("\n\n");
  const hash = createHash("sha256").update(combined).digest("hex").slice(0, 16);

  return {
    summary: {
      version: `app-creation:${hash}`,
      hash,
      files,
    },
    documents,
  };
}

export function renderInstructionPack(pack: InstructionPack): string {
  return Object.entries(pack.documents)
    .map(([name, content]) => `## ${name}\n${content.trim()}`)
    .join("\n\n");
}

export async function loadTalomeReferenceSnapshots(): Promise<ReferenceSnapshot[]> {
  const results = await Promise.all(
    TALOME_REFERENCE_FILES.map(async (item) => {
      try {
        const content = await readFile(item.path, "utf-8");
        return {
          title: item.title,
          reason: item.reason,
          sourcePath: item.path,
          relativePath: relative(REPO_ROOT, item.path),
          content,
        } satisfies ReferenceSnapshot;
      } catch {
        console.warn(`[creator] Reference file not found, skipping: ${item.path}`);
        return null;
      }
    }),
  );
  return results.filter((r): r is ReferenceSnapshot => r !== null);
}
