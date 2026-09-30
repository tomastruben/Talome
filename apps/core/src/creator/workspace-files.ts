import { readdir } from "node:fs/promises";
import { join } from "node:path";

export const GENERATED_ARTIFACT_IGNORES = new Set(["node_modules", ".git", ".next", "__pycache__", ".venv"]);

/** A prepared native contract or deployment metadata alone is not an application scaffold. */
export function hasGeneratedImplementation(files: string[]): boolean {
  return files.some((file) => {
    const name = file.split("/").at(-1)!;
    return !/^(talome-app\.json|manifest\.json|docker-compose\.ya?ml|compose\.ya?ml|Dockerfile(?:\..*)?|package\.json|(?:package-lock|pnpm-lock|yarn)\..*|tsconfig(?:\..*)?\.json|\.[^/]+)$/i.test(name) && !/\.md$/i.test(name);
  });
}

/** Never follow generated symlinks or count dependency/build output as source. */
export async function listGeneratedFiles(root: string, prefix = ""): Promise<string[]> {
  let entries;
  try { entries = await readdir(join(root, prefix), { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (!prefix && entry.name === "creator.json") continue;
    if (GENERATED_ARTIFACT_IGNORES.has(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new Error(`Generated source symlinks cannot be validated or published: ${join(prefix, entry.name)}`);
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listGeneratedFiles(root, path));
    } else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}
