import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { renderDesignPatternGuide, searchDesignPatterns } from "./design-patterns.js";
import { nativeChartGuide } from "./chart-guidance.js";
import type { InstructionPackSummary } from "./contracts.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE_ROOT = resolve(__dirname, "../..");
const REPO_ROOT = resolve(CORE_ROOT, "../..");
const PROMPTS_DIR = resolve(CORE_ROOT, "prompts", "app-creation");

const TALOME_REFERENCE_FILES = [
  ...[
    ["Theme tokens", "apps/dashboard/src/app/globals.css"],
    ["Shared buttons", "apps/dashboard/src/components/ui/button.tsx"],
    ["Shared search", "apps/dashboard/src/components/ui/search-field.tsx"],
    ["Desktop toolbar", "apps/dashboard/src/components/desktop/desktop-app-toolbar.tsx"],
    ["Desktop sidebar", "apps/dashboard/src/components/ui/source-list.tsx"],
    ["Native app renderer", "apps/dashboard/src/components/native-app/native-app-runtime.tsx"],
    ["Native blocks", "apps/dashboard/src/components/native-app/native-app-blocks.tsx"],
  ].map(([title, path]) => ({ title, reason: "Current Talome design system and desktop composition contract", path: resolve(REPO_ROOT, path) })),
  {
    title: "Cursor Rules",
    reason: "Project-wide design and component conventions",
    path: resolve(REPO_ROOT, ".cursor", "rules"),
  },
  {
    title: "Assistant Creation Flow",
    reason: "Current intent-led app creation entry, planning conversation and assistant context",
    path: resolve(REPO_ROOT, "apps", "dashboard", "src", "app", "dashboard", "assistant", "page.tsx"),
  },
  {
    title: "Blueprint Draft Review",
    reason: "Focused review and continuation of the app blueprint inside the creation flow",
    path: resolve(REPO_ROOT, "apps", "dashboard", "src", "components", "creator", "blueprint-draft-bar.tsx"),
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

  // Human guidance and machine discovery share a catalog and participate in
  // the instruction hash, so component/behavior changes invalidate stale packs.
  documents["pattern-catalog.md"] = renderDesignPatternGuide();
  documents["pattern-catalog.json"] = JSON.stringify(searchDesignPatterns(), null, 2);
  documents["chart-contract.json"] = JSON.stringify(nativeChartGuide(), null, 2);
  // Bind the pack to the actual UI foundations as well as written guidance.
  documents["design-foundations.json"] = JSON.stringify((await loadTalomeReferenceSnapshots()).map((reference) => ({
    path: reference.relativePath,
    sha256: createHash("sha256").update(reference.content).digest("hex"),
  })), null, 2);
  files.push("pattern-catalog.md", "pattern-catalog.json", "chart-contract.json", "design-foundations.json");
  files.sort();

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
